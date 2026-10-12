/**
 * CampaignRecipientExecutor
 *
 * Neutral, BullMQ-free execution service for campaign recipient delivery.
 * - Atomically claims recipients via conditional update (or verifies a sweep's pre-claim)
 * - Renders immutable template version with frozen recipient metadata
 * - Embeds RFC 8058 one-click unsubscribe headers
 * - Dispatches via resolved tenant provider, with an in-flight send marker (see claim-lock.ts)
 * - Creates authoritative EmailDelivery record; a retry that finds it never re-sends
 * - Updates recipient and campaign aggregate counters atomically
 * - Every post-claim exit releases the recipient lock
 * - Uses clean JobError taxonomy
 */

import { prisma } from "../../prisma";
import {
  EmailCampaignStatus,
  EmailDelivery,
  EmailDeliveryStatus,
  EmailProviderType,
  Prisma,
} from "@prisma/client";
import { providerRegistry } from "../../email/registry";
import { EmailProvider, EmailSendResult } from "../../email/types";
import { EmailSuppressionService } from "../email-suppression-service";
import { EmailUnsubscribeService } from "../email-unsubscribe-service";
import { TemplateEngine } from "../../email/template-engine";
import {
  RetryableError,
  PermanentError,
  classifyJobError,
  providerFailureError,
} from "../../errors/job-errors";
import { logger } from "../../logger";
import { getPublicAppUrl } from "../../env";
import { EmailTrackingService } from "../../email/tracking/email-tracking-service";
import { CampaignTriggerService } from "./campaign-trigger-service";
import {
  newClaimToken,
  notSendInFlight,
  sendInFlightToken,
  staleLockCutoff,
} from "./claim-lock";

export interface ExecuteCampaignRecipientOptions {
  recipientId: string;
  claimToken?: string;
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

/** Delivery states that mean the provider never accepted this message. */
const UNSENT_DELIVERY_STATUSES: EmailDeliveryStatus[] = [
  EmailDeliveryStatus.QUEUED,
  EmailDeliveryStatus.PROCESSING,
  EmailDeliveryStatus.FAILED,
];

export class CampaignRecipientExecutor {
  /**
   * Executes a single campaign recipient
   */
  static async executeRecipient(
    options: ExecuteCampaignRecipientOptions
  ): Promise<ExecuteCampaignRecipientResult> {
    const { recipientId, claimToken, maxAttempts = 5 } = options;

    logger.info(`[CampaignRecipientExecutor] Executing recipient ${recipientId} (claimToken: ${claimToken || "none"})`);

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

    // 3. Authoritative Atomic Claim Mechanism
    let lockToken: string;
    let currentAttempt: number;

    if (claimToken) {
      // Sweep has pre-claimed the row (and already incremented attemptCount). Verify ownership.
      if (recipient.status !== "PROCESSING" || recipient.lockedBy !== claimToken) {
        logger.warn(
          `[CampaignRecipientExecutor] Recipient ${recipientId} claimToken mismatch or lock lost. Current status: ${recipient.status}, lockedBy: ${recipient.lockedBy}. Skipping.`
        );
        return {
          success: true,
          recipientId,
          status: recipient.status,
          skipped: true,
          reason: "CLAIM_TOKEN_MISMATCH",
        };
      }
      lockToken = claimToken;
      currentAttempt = recipient.attemptCount || 1;
    } else {
      lockToken = newClaimToken("camp-recip");
      const staleCutoff = staleLockCutoff();

      const claimResult = await prisma.emailCampaignRecipient.updateMany({
        where: {
          id: recipient.id,
          OR: [
            { status: { in: ["PENDING", "RETRYING"] } },
            {
              status: "PROCESSING",
              AND: [
                notSendInFlight,
                {
                  OR: [
                    { lockedAt: { lt: staleCutoff } },
                    { lockedAt: null, lastAttemptAt: { lt: staleCutoff } },
                  ],
                },
              ],
            },
          ],
        },
        data: {
          status: "PROCESSING",
          attemptCount: { increment: 1 },
          lastAttemptAt: new Date(),
          lockedAt: new Date(),
          lockedBy: lockToken,
        },
      });

      if (claimResult.count === 0) {
        const fresh = await prisma.emailCampaignRecipient.findUnique({
          where: { id: recipient.id },
        });

        if (fresh?.status === "SENT") {
          return { success: true, recipientId, status: "SENT", skipped: true, reason: "ALREADY_SENT" };
        }

        if (fresh?.status === "PROCESSING") {
          logger.info(
            `[CampaignRecipientExecutor] Recipient ${recipientId} actively held by claimant '${fresh.lockedBy}'. Skipping without external dispatch.`
          );
          return {
            success: true,
            recipientId,
            status: fresh.status,
            skipped: true,
            reason: "CONTENTION_LOCK_HELD",
          };
        }

        return {
          success: false,
          recipientId,
          status: fresh?.status || recipient.status,
          skipped: true,
          reason: "CLAIM_CONTENTION",
        };
      }
      currentAttempt = (recipient.attemptCount || 0) + 1;
    }

    // Current lock owner value; switches to the in-flight token right before the provider send.
    let ownerToken = lockToken;
    const owned = () => ({ id: recipient.id, status: "PROCESSING", lockedBy: ownerToken });

    let sent = false;
    let deliveryRecorded = false;
    let pendingDeliveryId: string | null = null;
    let campaignId = recipient.campaignId;

    try {
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
      campaignId = campaign.id;

      if (campaign.status === EmailCampaignStatus.CANCELLED) {
        await prisma.emailCampaignRecipient.updateMany({
          where: owned(),
          data: { status: "CANCELLED", lockedAt: null, lockedBy: null },
        });
        await CampaignTriggerService.checkAndCompleteCampaign(campaign.id);
        return { success: false, recipientId, status: "CANCELLED", skipped: true, reason: "CAMPAIGN_CANCELLED" };
      }

      if (campaign.status === EmailCampaignStatus.PAUSED) {
        // Pausing is not an attempt: give the claim's increment back.
        await prisma.emailCampaignRecipient.updateMany({
          where: owned(),
          data: { status: "PENDING", lockedAt: null, lockedBy: null, attemptCount: { decrement: 1 } },
        });
        return { success: false, recipientId, status: "PAUSED", skipped: true, reason: "CAMPAIGN_PAUSED" };
      }

      if (campaign.status === EmailCampaignStatus.COMPLETED) {
        await prisma.emailCampaignRecipient.updateMany({
          where: owned(),
          data: { status: "CANCELLED", errorCode: "CAMPAIGN_ALREADY_COMPLETED", lockedAt: null, lockedBy: null },
        });
        return { success: true, recipientId, status: "COMPLETED", skipped: true, reason: "CAMPAIGN_ALREADY_COMPLETED" };
      }

      const { clientId } = campaign;

      // 5. Verify Suppression List
      const suppCheck = await EmailSuppressionService.isSuppressed(clientId, recipient.email);
      if (suppCheck.suppressed) {
        await prisma.emailCampaignRecipient.updateMany({
          where: owned(),
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
        // Defense in depth: never send as another tenant's identity, even if the DB was tampered with
        if (senderIdentity.clientId !== clientId) {
          throw new PermanentError(
            `Sender identity '${senderIdentity.id}' does not belong to tenant '${clientId}'.`,
            "SENDER_IDENTITY_TENANT_MISMATCH"
          );
        }
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
        unsubscribeHeaders = EmailUnsubscribeService.getOneClickUnsubscribeHeaders(
          getPublicAppUrl(),
          unsubToken
        );
      }

      // 9. Idempotency: a delivery for this recipient that reached the provider means an earlier
      //    attempt already sent it. (Rows still QUEUED/PROCESSING/FAILED never reached a send that
      //    succeeded: the recipient's in-flight marker would otherwise have blocked this claim.)
      const idempotencyKey = `campaign-${campaign.id}-recipient-${recipient.id}`;
      let delivery: EmailDelivery | null = await prisma.emailDelivery.findUnique({
        where: { clientId_idempotencyKey: { clientId, idempotencyKey } },
      });

      if (delivery && !UNSENT_DELIVERY_STATUSES.includes(delivery.status)) {
        sent = true;
        deliveryRecorded = true;
        logger.info(
          `[CampaignRecipientExecutor] Recipient ${recipient.id} already has delivery ${delivery.id}; finishing bookkeeping without re-sending.`
        );
      } else {
        // 10. Mark send in flight on the recipient and its delivery (created first so tracking
        //     tokens can reference the delivery id)
        const inFlightToken = sendInFlightToken(lockToken);
        const marked = await prisma.emailCampaignRecipient.updateMany({
          where: owned(),
          data: { lockedBy: inFlightToken, lockedAt: new Date() },
        });
        if (marked.count === 0) {
          logger.warn(`[CampaignRecipientExecutor] Recipient ${recipient.id} lock lost before send. Skipping without dispatch.`);
          return { success: true, recipientId, status: "PROCESSING", skipped: true, reason: "CLAIM_LOST" };
        }
        ownerToken = inFlightToken;

        const inFlightDelivery = {
          status: EmailDeliveryStatus.PROCESSING,
          lockedBy: inFlightToken,
          lockedAt: new Date(),
          lastAttemptAt: new Date(),
        };
        delivery = delivery
          ? await prisma.emailDelivery.update({
              where: { id: delivery.id },
              data: { ...inFlightDelivery, attemptCount: { increment: 1 }, errorCode: null, errorMessage: null },
            })
          : await prisma.emailDelivery.create({
              data: {
                ...inFlightDelivery,
                attemptCount: 1,
                clientId,
                providerType,
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
                idempotencyKey,
              },
            });
        pendingDeliveryId = delivery.id;

        // Signed open pixel + wrapped links bound to this delivery
        const trackedHtml = rendered.html
          ? EmailTrackingService.prepareTrackedHtml(rendered.html, clientId, delivery.id, { baseUrl: getPublicAppUrl() })
          : rendered.html;

        const sendResult: EmailSendResult = await provider.send({
          clientId,
          from: fromAddress,
          to: recipient.email,
          subject: rendered.subject,
          html: trackedHtml,
          text: rendered.text,
          replyTo: replyToAddress,
          type: "PROMOTIONAL",
          headers: unsubscribeHeaders,
          idempotencyKey,
          campaignId: campaign.id,
          campaignRecipientId: recipient.id,
        });

        if (!sendResult.success) {
          throw providerFailureError(sendResult.error);
        }
        sent = true;

        // 11. Record the delivery as SENT
        delivery = await prisma.emailDelivery.update({
          where: { id: delivery.id },
          data: {
            status: EmailDeliveryStatus.SENT,
            sentAt: new Date(),
            providerType,
            providerMessageId: sendResult.providerMessageId || null,
            smtpCode: sendResult.error?.statusCode ? String(sendResult.error.statusCode) : null,
            lockedAt: null,
            lockedBy: null,
          },
        });
        deliveryRecorded = true;
      }

      // 12. Mark recipient SENT and count it, atomically and only if we still own the lock
      await prisma.$transaction(async (tx) => {
        const updated = await tx.emailCampaignRecipient.updateMany({
          where: owned(),
          data: { status: "SENT", lockedAt: null, lockedBy: null, errorCode: null, errorMessage: null },
        });
        if (updated.count === 1) {
          await tx.emailCampaign.update({
            where: { id: campaign.id },
            data: { sentCount: { increment: 1 } },
          });
        }
      });

      try {
        await CampaignTriggerService.checkAndCompleteCampaign(campaign.id);
      } catch (completeErr) {
        // Non-critical: reconciliation completes campaigns on its next sweep.
        logger.warn(`[CampaignRecipientExecutor] Campaign completion check failed for ${campaign.id}:`, completeErr);
      }

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

      if (sent) {
        // The provider accepted the message. Never let this path lead to a second send.
        if (deliveryRecorded) {
          // A retry will find the delivery row and only finish bookkeeping.
          await prisma.emailCampaignRecipient
            .updateMany({
              where: owned(),
              data: { status: "PENDING", nextAttemptAt: new Date(Date.now() + 5000), lockedAt: null, lockedBy: null },
            })
            .catch((releaseErr) =>
              logger.error(`[CampaignRecipientExecutor] Could not release recipient ${recipient.id}:`, releaseErr)
            );
          throw new RetryableError(
            `Recipient ${recipient.id} sent; bookkeeping failed and will be retried: ${classification.message}`,
            "BOOKKEEPING_RETRY"
          );
        }
        // Delivery row could not be written: keep the in-flight marker so reconciliation flags it.
        logger.error(
          `[CampaignRecipientExecutor] Recipient ${recipient.id} was sent but its delivery could not be recorded. Leaving in-flight marker to prevent a duplicate send.`,
          err
        );
        throw new PermanentError(
          `Recipient ${recipient.id} sent but delivery could not be recorded: ${classification.message}`,
          "SENT_NOT_RECORDED"
        );
      }

      if (classification.isRetryable && currentAttempt < maxAttempts) {
        const backoffMs = Math.min(300000, 1000 * Math.pow(2, currentAttempt));
        const nextAttemptAt = new Date(Date.now() + backoffMs);

        await prisma.emailCampaignRecipient.updateMany({
          where: owned(),
          data: {
            status: "PENDING",
            nextAttemptAt,
            errorCode: classification.code,
            errorMessage: classification.message,
            lockedAt: null,
            lockedBy: null,
          },
        });
        await releasePendingDelivery(pendingDeliveryId, ownerToken, {
          status: EmailDeliveryStatus.QUEUED,
          nextAttemptAt,
          errorCode: classification.code,
          errorMessage: classification.message,
        });

        logger.warn(
          `[CampaignRecipientExecutor] Recipient ${recipient.id} failed transiently (attempt ${currentAttempt}/${maxAttempts}). Retrying at ${nextAttemptAt.toISOString()}`
        );

        throw new RetryableError(
          `Transient error sending recipient ${recipient.id}: ${classification.message}`,
          classification.code,
          backoffMs
        );
      }

      // Permanent failure (no-op if an earlier step already moved the recipient to a terminal state)
      await prisma.emailCampaignRecipient.updateMany({
        where: owned(),
        data: {
          status: "FAILED",
          errorCode: classification.code,
          errorMessage: classification.message,
          lockedAt: null,
          lockedBy: null,
        },
      });
      await releasePendingDelivery(pendingDeliveryId, ownerToken, {
        status: EmailDeliveryStatus.FAILED,
        failedAt: new Date(),
        errorCode: classification.code,
        errorMessage: classification.message,
      });

      try {
        await CampaignTriggerService.checkAndCompleteCampaign(campaignId);
      } catch (completeErr) {
        logger.warn(`[CampaignRecipientExecutor] Campaign completion check failed for ${campaignId}:`, completeErr);
      }

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

/** Clears the in-flight marker on a delivery whose send did not go out, recording the outcome. */
async function releasePendingDelivery(
  deliveryId: string | null,
  inFlightToken: string,
  data: Prisma.EmailDeliveryUpdateManyMutationInput
): Promise<void> {
  if (!deliveryId) return;
  await prisma.emailDelivery
    .updateMany({
      where: { id: deliveryId, status: EmailDeliveryStatus.PROCESSING, lockedBy: inFlightToken },
      data: { ...data, lockedAt: null, lockedBy: null },
    })
    .catch((err) => logger.error(`[CampaignRecipientExecutor] Could not release delivery ${deliveryId}:`, err));
}
