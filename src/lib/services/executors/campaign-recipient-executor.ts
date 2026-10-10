/**
 * CampaignRecipientExecutor
 *
 * Neutral, BullMQ-free execution service for campaign recipient delivery.
 * - Atomically claims recipients via SELECT ... FOR UPDATE SKIP LOCKED
 * - Renders immutable template version with frozen recipient metadata
 * - Embeds RFC 8058 one-click unsubscribe headers
 * - Dispatches via resolved tenant provider
 * - Creates authoritative EmailDelivery record
 * - Updates recipient and campaign aggregate counters
 * - Uses clean JobError taxonomy
 */

import { prisma } from "../../prisma";
import {
  EmailCampaignStatus,
  EmailDeliveryStatus,
  EmailProviderType,
} from "@prisma/client";
import { providerRegistry } from "../../email/registry";
import { EmailProvider } from "../../email/types";
import { EmailSuppressionService } from "../email-suppression-service";
import { EmailUnsubscribeService } from "../email-unsubscribe-service";
import { TemplateEngine } from "../../email/template-engine";
import {
  RetryableError,
  PermanentError,
  classifyJobError,
} from "../../errors/job-errors";
import { logger } from "../../logger";
import { CampaignTriggerService } from "./campaign-trigger-service";

export interface ExecuteCampaignRecipientOptions {
  recipientId: string;
  providerOverride?: EmailProvider;
  maxAttempts?: number;
}

export interface ExecuteCampaignRecipientResult {
  success: boolean;
  recipientId: string;
  deliveryId?: string;
  status: string;
  skipped?: boolean;
  reason?: string;
}

export class CampaignRecipientExecutor {
  /**
   * Executes a single campaign recipient
   */
  static async executeRecipient(
    options: ExecuteCampaignRecipientOptions
  ): Promise<ExecuteCampaignRecipientResult> {
    const { recipientId, maxAttempts = 5 } = options;

    logger.info(`[CampaignRecipientExecutor] Executing recipient ${recipientId}`);

    // 1. Load Recipient
    const recipient = await prisma.emailCampaignRecipient.findUnique({
      where: { id: recipientId },
    });

    if (!recipient) {
      throw new PermanentError(`Campaign recipient '${recipientId}' not found.`);
    }

    // 2. Terminal State Guard
    if (recipient.status === "SENT") {
      return { success: true, recipientId, status: "SENT", skipped: true, reason: "ALREADY_SENT" };
    }
    if (recipient.status === "CANCELLED" || recipient.status === "SUPPRESSED" || recipient.status === "FAILED") {
      return { success: false, recipientId, status: recipient.status, skipped: true, reason: `RECIPIENT_${recipient.status}` };
    }

    // 3. Mark Recipient as PROCESSING
    await prisma.emailCampaignRecipient.updateMany({
      where: {
        id: recipient.id,
        status: { in: ["PENDING", "RETRYING", "FAILED"] },
      },
      data: {
        status: "PROCESSING",
        attemptCount: { increment: 1 },
        lastAttemptAt: new Date(),
        lockedAt: new Date(),
        lockedBy: "serverless-processor",
      },
    });

    const currentAttempt = (recipient.attemptCount || 0) + 1;

    // 4. Load Campaign & Lifecycle Checks
    const campaign = await prisma.emailCampaign.findUnique({
      where: { id: recipient.campaignId },
      include: {
        templateVersion: true,
        senderIdentity: {
          include: {
            providerConfig: true,
          },
        },
      },
    });

    if (!campaign) {
      throw new PermanentError(`Campaign '${recipient.campaignId}' not found.`);
    }

    if (campaign.status === EmailCampaignStatus.CANCELLED) {
      await prisma.emailCampaignRecipient.update({
        where: { id: recipient.id },
        data: { status: "CANCELLED", lockedAt: null, lockedBy: null },
      });
      await CampaignTriggerService.checkAndCompleteCampaign(campaign.id);
      return { success: false, recipientId, status: "CANCELLED", skipped: true, reason: "CAMPAIGN_CANCELLED" };
    }

    if (campaign.status === EmailCampaignStatus.PAUSED) {
      await prisma.emailCampaignRecipient.update({
        where: { id: recipient.id },
        data: { status: "PENDING", lockedAt: null, lockedBy: null },
      });
      return { success: false, recipientId, status: "PAUSED", skipped: true, reason: "CAMPAIGN_PAUSED" };
    }

    if (campaign.status === EmailCampaignStatus.COMPLETED) {
      return { success: true, recipientId, status: "COMPLETED", skipped: true, reason: "CAMPAIGN_ALREADY_COMPLETED" };
    }

    const { clientId } = campaign;

    // 5. Verify Suppression List
    const suppCheck = await EmailSuppressionService.isSuppressed(clientId, recipient.email);
    if (suppCheck.suppressed) {
      await prisma.emailCampaignRecipient.update({
        where: { id: recipient.id },
        data: { status: "SUPPRESSED", errorCode: "SUPPRESSED", errorMessage: suppCheck.reason, lockedAt: null, lockedBy: null },
      });
      await CampaignTriggerService.checkAndCompleteCampaign(campaign.id);
      throw new PermanentError(`Recipient '${recipient.email}' is suppressed (${suppCheck.reason || "SUPPRESSED"}).`);
    }

    // 6. Template & Variable Resolution
    if (!campaign.templateVersion) {
      throw new PermanentError(`Campaign '${campaign.id}' has no bound template version.`);
    }

    let snapshotData: Record<string, unknown> = {};
    if (recipient.metadataSnapshot) {
      try {
        snapshotData = JSON.parse(recipient.metadataSnapshot);
      } catch {
        snapshotData = {};
      }
    }

    const rendered = TemplateEngine.renderTemplate(campaign.templateVersion, {
      email: recipient.email,
      ...snapshotData,
    });

    // 7. Resolve Sender Identity and Provider
    let provider: EmailProvider;
    let providerType: EmailProviderType = EmailProviderType.GMAIL;
    let fromAddress: string;
    let replyToAddress: string | undefined;

    if (campaign.senderIdentityId && campaign.senderIdentity) {
      const senderIdentity = campaign.senderIdentity;
      if (!senderIdentity.verified) {
        throw new PermanentError(`Sender identity '${senderIdentity.email}' is not verified.`);
      }

      fromAddress = senderIdentity.name
        ? `"${senderIdentity.name}" <${senderIdentity.email}>`
        : senderIdentity.email;
      replyToAddress = senderIdentity.replyToEmail || undefined;

      if (options.providerOverride) {
        provider = options.providerOverride;
        providerType = provider.providerType;
      } else {
        const resolved = await providerRegistry.resolveForTenant(
          clientId,
          senderIdentity.providerConfigId || undefined
        );
        provider = resolved.provider;
        providerType = resolved.providerType;
      }
    } else {
      if (options.providerOverride) {
        provider = options.providerOverride;
        providerType = provider.providerType;
        fromAddress = "campaigns@whatsapphub.internal";
      } else {
        const resolved = await providerRegistry.resolveForTenant(clientId);
        provider = resolved.provider;
        providerType = resolved.providerType;
        fromAddress = resolved.senderEmail || "campaigns@whatsapphub.internal";
      }
    }

    // 8. One-Click Unsubscribe Headers
    let unsubscribeHeaders: Record<string, string> | undefined;
    if (recipient.contactId) {
      const unsubToken = EmailUnsubscribeService.generateUnsubscribeToken(clientId, recipient.contactId);
      const appUrl = process.env.NEXTAUTH_URL || "https://app.whatsapphub.internal";
      unsubscribeHeaders = EmailUnsubscribeService.getOneClickUnsubscribeHeaders(
        appUrl,
        unsubToken
      );
    }

    // 9. Dispatch
    try {
      const sendResult = await provider.send({
        clientId,
        from: fromAddress,
        to: recipient.email,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        replyTo: replyToAddress,
        type: "PROMOTIONAL",
        headers: unsubscribeHeaders,
      });

      if (!sendResult.success) {
        throw new Error(sendResult.error?.message || "Provider returned failure");
      }

      // 10. Persist Delivery & Update Recipient
      const delivery = await prisma.emailDelivery.create({
        data: {
          clientId,
          providerType,
          providerMessageId: sendResult.providerMessageId || null,
          campaignId: campaign.id,
          campaignRecipientId: recipient.id,
          category: "PROMOTIONAL",
          from: fromAddress,
          to: recipient.email,
          replyTo: replyToAddress,
          subject: rendered.subject,
          htmlContent: rendered.html,
          textContent: rendered.text,
          templateId: campaign.templateVersion.templateId,
          templateVersionId: campaign.templateVersion.id,
          senderIdentityId: campaign.senderIdentityId,
          status: EmailDeliveryStatus.SENT,
          sentAt: new Date(),
          smtpCode: sendResult.error?.statusCode ? String(sendResult.error.statusCode) : null,
        },
      });

      await prisma.emailCampaignRecipient.update({
        where: { id: recipient.id },
        data: {
          status: "SENT",
          lockedAt: null,
          lockedBy: null,
        },
      });

      await prisma.emailCampaign.update({
        where: { id: campaign.id },
        data: { sentCount: { increment: 1 } },
      });

      await CampaignTriggerService.checkAndCompleteCampaign(campaign.id);

      logger.info(
        `[CampaignRecipientExecutor] Recipient ${recipient.id} SENT (delivery: ${delivery.id})`
      );

      return {
        success: true,
        recipientId: recipient.id,
        deliveryId: delivery.id,
        status: "SENT",
      };
    } catch (err) {
      const classification = classifyJobError(err);

      if (classification.isRetryable && currentAttempt < maxAttempts) {
        const backoffMs = Math.min(300000, 1000 * Math.pow(2, currentAttempt));
        const nextAttemptAt = new Date(Date.now() + backoffMs);

        await prisma.emailCampaignRecipient.update({
          where: { id: recipient.id },
          data: {
            status: "PENDING",
            nextAttemptAt,
            errorCode: classification.code,
            errorMessage: classification.message,
            lockedAt: null,
            lockedBy: null,
          },
        });

        logger.warn(
          `[CampaignRecipientExecutor] Recipient ${recipient.id} failed transiently (attempt ${currentAttempt}/${maxAttempts}). Retrying at ${nextAttemptAt.toISOString()}`
        );

        throw new RetryableError(
          `Transient error sending recipient ${recipient.id}: ${classification.message}`,
          classification.code,
          backoffMs
        );
      } else {
        await prisma.emailCampaignRecipient.update({
          where: { id: recipient.id },
          data: {
            status: "FAILED",
            errorCode: classification.code,
            errorMessage: classification.message,
            lockedAt: null,
            lockedBy: null,
          },
        });

        await CampaignTriggerService.checkAndCompleteCampaign(campaign.id);

        logger.error(
          `[CampaignRecipientExecutor] Recipient ${recipient.id} permanently failed: ${classification.message}`
        );

        throw new PermanentError(
          `Permanent failure sending recipient ${recipient.id}: ${classification.message}`,
          classification.code
        );
      }
    }
  }
}
