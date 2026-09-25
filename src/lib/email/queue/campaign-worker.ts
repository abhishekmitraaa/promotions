/**
 * BullMQ Campaign Recipient & Trigger Worker Processor
 *
 * Implements authoritative individual campaign recipient job processing:
 * 1. Routes scheduled campaign triggers to dedicated trigger processor.
 * 2. Checks current campaign lifecycle state (PAUSED / CANCELLED guards).
 * 3. Enforces stale-delivery protection (never sends to an already SENT recipient).
 * 4. Enforces real-time suppression verification prior to dispatch.
 * 5. Resolves bound immutable template version and renders personalized snapshot.
 * 6. Resolves sender identity (validating tenant ownership, active provider, email/name/reply-to).
 * 7. Dispatches email via resolved tenant provider.
 * 8. Records EmailDelivery and updates EmailCampaignRecipient state.
 * 9. Increments campaign delivery counters and deterministically completes campaign when all recipients reach terminal states.
 */

import { Job, UnrecoverableError, Worker } from "bullmq";
import { prisma } from "../../prisma";
import { CampaignJobData, PromotionalJobData, RetryableEmailError, PermanentEmailError, QUEUE_NAMES, JOB_NAMES } from "./types";
import { createWorkerRedisConnection } from "./connection";
import { TemplateEngine } from "../template-engine";
import { EmailSuppressionService } from "../../services/email-suppression-service";
import { EmailUnsubscribeService } from "../../services/email-unsubscribe-service";
import { providerRegistry } from "../registry";
import { EmailProvider } from "../types";
import { EmailTrackingService } from "../tracking/email-tracking-service";
import { logger } from "../../logger";
import { processPromotionalDeliveryJob } from "./promotional-delivery-worker";
import { processScheduledCampaignTriggerJob } from "./campaign-trigger-worker";

export { processPromotionalDeliveryJob, processScheduledCampaignTriggerJob };
import {
  EmailCampaignStatus,
  EmailDeliveryStatus,
  EmailProviderStatus,
  EmailProviderType,
  EmailType,
} from "@prisma/client";

export interface CampaignWorkerOptions {
  providerOverride?: EmailProvider;
}

/**
 * Checks if all recipients for a campaign have reached terminal states
 * (SENT, FAILED, BOUNCED, COMPLAINED, CANCELLED, SUPPRESSED).
 * Transitions campaign to COMPLETED if no pending or processing recipients remain.
 */
export async function checkAndCompleteCampaign(campaignId: string): Promise<boolean> {
  const activeRecipients = await prisma.emailCampaignRecipient.count({
    where: {
      campaignId,
      status: { in: ["PENDING", "PROCESSING"] },
    },
  });

  if (activeRecipients === 0) {
    const updated = await prisma.emailCampaign.updateMany({
      where: {
        id: campaignId,
        status: { in: [EmailCampaignStatus.RUNNING, EmailCampaignStatus.PAUSED] },
      },
      data: {
        status: EmailCampaignStatus.COMPLETED,
        completedAt: new Date(),
      },
    });

    if (updated.count > 0) {
      logger.info(
        `[Worker:Campaign] Campaign ${campaignId} completed deterministically. All recipients have reached terminal states.`
      );
      return true;
    }
  }
  return false;
}

export async function processCampaignRecipientJob(
  job: Job<CampaignJobData>,
  options?: CampaignWorkerOptions
) {
  // Fail-safe routing: If trigger job arrives here, delegate to dedicated processor
  if (job.name === JOB_NAMES.TRIGGER_SCHEDULED_CAMPAIGN || (!job.data.campaignRecipientId && job.data.campaignId)) {
    return processScheduledCampaignTriggerJob(job, options);
  }

  const { campaignRecipientId, campaignId, clientId } = job.data;
  if (!campaignRecipientId) {
    throw new UnrecoverableError("campaignRecipientId is required for campaign recipient job.");
  }

  logger.info(
    `[Worker:Campaign] Processing job ${job.id} for recipient ${campaignRecipientId} (campaign: ${campaignId})`
  );

  // 1. Load Authoritative Recipient Record
  const recipient = await prisma.emailCampaignRecipient.findUnique({
    where: { id: campaignRecipientId },
  });

  if (!recipient) {
    throw new UnrecoverableError(`Campaign recipient '${campaignRecipientId}' not found.`);
  }

  // 2. Stale Guard: If already SENT, CANCELLED, SUPPRESSED, or FAILED, skip execution
  if (recipient.status === "SENT") {
    logger.info(`[Worker:Campaign] Recipient ${campaignRecipientId} already SENT. Skipping duplicate execution.`);
    return { skipped: true, reason: "ALREADY_SENT" };
  }
  if (recipient.status === "CANCELLED") {
    logger.info(`[Worker:Campaign] Recipient ${campaignRecipientId} already CANCELLED. Skipping execution.`);
    return { skipped: true, reason: "RECIPIENT_CANCELLED" };
  }
  if (recipient.status === "SUPPRESSED") {
    logger.info(`[Worker:Campaign] Recipient ${campaignRecipientId} is SUPPRESSED. Skipping execution.`);
    return { skipped: true, reason: "RECIPIENT_SUPPRESSED" };
  }
  if (recipient.status === "FAILED") {
    logger.info(`[Worker:Campaign] Recipient ${campaignRecipientId} already FAILED. Skipping execution.`);
    return { skipped: true, reason: "RECIPIENT_FAILED" };
  }

  // 3. Load Authoritative Campaign & Check Lifecycle State
  const campaign = await prisma.emailCampaign.findUnique({
    where: { id: campaignId },
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
    throw new UnrecoverableError(`Campaign '${campaignId}' not found.`);
  }

  // Lifecycle check: Cancelled
  if (campaign.status === EmailCampaignStatus.CANCELLED) {
    logger.info(`[Worker:Campaign] Campaign ${campaignId} is CANCELLED. Skipping recipient ${campaignRecipientId}.`);
    await prisma.emailCampaignRecipient.update({
      where: { id: recipient.id },
      data: { status: "CANCELLED" },
    });
    await checkAndCompleteCampaign(campaign.id);
    return { skipped: true, reason: "CAMPAIGN_CANCELLED" };
  }

  // Lifecycle check: Paused
  if (campaign.status === EmailCampaignStatus.PAUSED) {
    logger.info(`[Worker:Campaign] Campaign ${campaignId} is PAUSED. Postponing recipient ${campaignRecipientId}.`);
    return { skipped: true, reason: "CAMPAIGN_PAUSED" };
  }

  // 4. Verify Suppression List in Real-Time
  const suppCheck = await EmailSuppressionService.isSuppressed(clientId, recipient.email);
  if (suppCheck.suppressed) {
    await prisma.emailCampaignRecipient.update({
      where: { id: recipient.id },
      data: { status: "SUPPRESSED" },
    });
    await checkAndCompleteCampaign(campaign.id);
    throw new UnrecoverableError(
      `Recipient '${recipient.email}' is suppressed (${suppCheck.reason || "SUPPRESSED"}).`
    );
  }

  // 5. Load Immutable Template Version
  if (!campaign.templateVersion) {
    throw new UnrecoverableError(`Campaign '${campaignId}' has no bound template version.`);
  }

  let snapshotData: Record<string, unknown> = {};
  if (recipient.metadataSnapshot) {
    try {
      snapshotData = JSON.parse(recipient.metadataSnapshot);
    } catch {
      snapshotData = {};
    }
  }

  // Render personalized template using frozen recipient metadata
  const rendered = TemplateEngine.renderTemplate(campaign.templateVersion, {
    email: recipient.email,
    ...snapshotData,
  });

  // 6. Resolve Sender Identity and Provider Configuration
  let provider: EmailProvider;
  let providerType: EmailProviderType = EmailProviderType.GMAIL;
  let fromAddress: string;
  let replyToAddress: string | undefined;

  if (campaign.senderIdentityId) {
    // Explicit sender identity configured on campaign
    const senderIdentity = await prisma.emailSenderIdentity.findFirst({
      where: {
        id: campaign.senderIdentityId,
        clientId, // Tenant boundary check!
      },
      include: {
        providerConfig: true,
      },
    });

    if (!senderIdentity) {
      throw new UnrecoverableError(
        `Sender identity '${campaign.senderIdentityId}' not found or does not belong to tenant '${clientId}'.`
      );
    }

    if (!senderIdentity.verified) {
      throw new UnrecoverableError(
        `Sender identity '${senderIdentity.email}' is not verified.`
      );
    }

    if (senderIdentity.providerConfigId) {
      if (
        !senderIdentity.providerConfig ||
        senderIdentity.providerConfig.status !== EmailProviderStatus.ACTIVE
      ) {
        throw new UnrecoverableError(
          `Provider configuration for sender identity '${senderIdentity.email}' is not active.`
        );
      }
      if (senderIdentity.providerConfig.clientId !== clientId) {
        throw new UnrecoverableError(
          `Provider configuration for sender identity does not belong to tenant '${clientId}'.`
        );
      }
    }

    // Format fromAddress and replyTo
    fromAddress = senderIdentity.name
      ? `"${senderIdentity.name}" <${senderIdentity.email}>`
      : senderIdentity.email;
    replyToAddress = senderIdentity.replyToEmail || undefined;

    if (options?.providerOverride) {
      provider = options.providerOverride;
      providerType = provider.providerType;
    } else {
      try {
        const resolved = await providerRegistry.resolveForTenant(
          clientId,
          senderIdentity.providerConfigId || undefined
        );
        provider = resolved.provider;
        providerType = resolved.providerType;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Provider resolution failed";
        throw new UnrecoverableError(msg);
      }
    }
  } else {
    // Default sender behavior explicitly requested (senderIdentityId is null)
    replyToAddress = undefined;
    if (options?.providerOverride) {
      provider = options.providerOverride;
      providerType = provider.providerType;
      fromAddress = "campaigns@whatsapphub.internal";
    } else {
      try {
        const resolved = await providerRegistry.resolveForTenant(clientId);
        provider = resolved.provider;
        providerType = resolved.providerType;
        fromAddress = resolved.senderEmail || "campaigns@whatsapphub.internal";
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Provider resolution failed";
        throw new UnrecoverableError(msg);
      }
    }
  }

  // 7. Dispatch Email with One-Click Unsubscribe Headers
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "https://hub.local";
  let unsubscribeHeaders: Record<string, string> | undefined;

  if (recipient.contactId) {
    const unsubToken = EmailUnsubscribeService.generateUnsubscribeToken(
      clientId,
      recipient.contactId
    );
    unsubscribeHeaders = EmailUnsubscribeService.getOneClickUnsubscribeHeaders(
      baseUrl,
      unsubToken
    );
  }

  // 8. Find or create authoritative EmailDelivery record to bind tracking tokens
  let delivery = await prisma.emailDelivery.findFirst({
    where: { campaignRecipientId: recipient.id },
    orderBy: { createdAt: "desc" },
  });

  if (!delivery) {
    delivery = await prisma.emailDelivery.create({
      data: {
        clientId,
        campaignRecipientId: recipient.id,
        category: EmailType.PROMOTIONAL,
        providerType,
        from: fromAddress,
        to: recipient.email,
        subject: rendered.subject,
        status: EmailDeliveryStatus.PROCESSING,
        attemptCount: 1,
        lastAttemptAt: new Date(),
      },
    });
  } else {
    delivery = await prisma.emailDelivery.update({
      where: { id: delivery.id },
      data: {
        status: EmailDeliveryStatus.PROCESSING,
        attemptCount: { increment: 1 },
        lastAttemptAt: new Date(),
      },
    });
  }

  // 9. Prepare Tracked HTML: Inject signed open pixel & wrap eligible HTTP/HTTPS links
  const trackedHtml = EmailTrackingService.prepareTrackedHtml(
    rendered.html,
    clientId,
    delivery.id,
    { baseUrl }
  );

  try {
    const sendResult = await provider.send({
      clientId,
      type: "PROMOTIONAL",
      to: recipient.email,
      from: fromAddress,
      replyTo: replyToAddress,
      subject: rendered.subject,
      html: trackedHtml,
      text: rendered.text,
      headers: unsubscribeHeaders,
      campaignRecipientId: recipient.id,
    });

    if (sendResult.accepted) {
      // 10. Update Delivery to SENT and Recipient to SENT
      await prisma.emailDelivery.update({
        where: { id: delivery.id },
        data: {
          status: EmailDeliveryStatus.SENT,
          providerMessageId: sendResult.providerMessageId || null,
          sentAt: new Date(),
        },
      });

      await prisma.emailCampaignRecipient.update({
        where: { id: recipient.id },
        data: { status: "SENT" },
      });

      // 11. Increment Campaign Sent Count
      await prisma.emailCampaign.update({
        where: { id: campaign.id },
        data: { sentCount: { increment: 1 } },
      });

      // 12. Check if All Recipients reached terminal states -> Transition to COMPLETED
      await checkAndCompleteCampaign(campaign.id);

      return {
        success: true,
        campaignRecipientId: recipient.id,
        deliveryId: delivery.id,
        providerMessageId: sendResult.providerMessageId,
      };
    }

    // Provider returned error
    const err = sendResult.error;
    if (err?.retryable) {
      throw new RetryableEmailError(err.message, err.code);
    } else {
      await prisma.emailDelivery.update({
        where: { id: delivery.id },
        data: {
          status: EmailDeliveryStatus.FAILED,
          failedAt: new Date(),
          errorCode: err?.code || "PROVIDER_FAILED",
          errorMessage: err?.message || "Permanent delivery failure",
        },
      });

      await prisma.emailCampaignRecipient.update({
        where: { id: recipient.id },
        data: { status: "FAILED" },
      });
      await checkAndCompleteCampaign(campaign.id);
      throw new UnrecoverableError(err?.message || "Permanent delivery failure");
    }
  } catch (err: unknown) {
    if (err instanceof UnrecoverableError) {
      await prisma.emailDelivery.updateMany({
        where: { id: delivery.id, status: EmailDeliveryStatus.PROCESSING },
        data: {
          status: EmailDeliveryStatus.FAILED,
          failedAt: new Date(),
          errorMessage: err.message,
        },
      });
      await prisma.emailCampaignRecipient.update({
        where: { id: recipient.id },
        data: { status: "FAILED" },
      });
      await checkAndCompleteCampaign(campaign.id);
      throw err;
    }
    if (err instanceof PermanentEmailError) {
      await prisma.emailDelivery.updateMany({
        where: { id: delivery.id, status: EmailDeliveryStatus.PROCESSING },
        data: {
          status: EmailDeliveryStatus.FAILED,
          failedAt: new Date(),
          errorCode: err.code,
          errorMessage: err.message,
        },
      });
      await prisma.emailCampaignRecipient.update({
        where: { id: recipient.id },
        data: { status: "FAILED" },
      });
      await checkAndCompleteCampaign(campaign.id);
      throw new UnrecoverableError(err.message);
    }
    if (err instanceof RetryableEmailError) {
      throw err;
    }

    const errMsg = err instanceof Error ? err.message : String(err);
    if (errMsg.includes("429") || errMsg.includes("timeout") || errMsg.includes("ETIMEDOUT")) {
      throw new RetryableEmailError(errMsg, "PROVIDER_RETRYABLE");
    }

    await prisma.emailCampaignRecipient.update({
      where: { id: recipient.id },
      data: { status: "FAILED" },
    });
    await checkAndCompleteCampaign(campaign.id);
    throw new UnrecoverableError(errMsg);
  }
}

/**
 * Creates and configures the BullMQ Worker for promotional campaign recipient & trigger jobs.
 */
export function createCampaignWorker(options?: {
  connection?: ReturnType<typeof createWorkerRedisConnection>;
  concurrency?: number;
  providerOverride?: EmailProvider;
}): Worker {
  const connection = options?.connection || createWorkerRedisConnection();
  const concurrency =
    options?.concurrency || parseInt(process.env.EMAIL_CAMPAIGN_CONCURRENCY || "5", 10);

  const worker = new Worker<CampaignJobData | PromotionalJobData>(
    QUEUE_NAMES.CAMPAIGN,
    async (job) => {
      if (job.name === JOB_NAMES.SEND_PROMOTIONAL) {
        return processPromotionalDeliveryJob(job as Job<PromotionalJobData>, {
          providerOverride: options?.providerOverride,
        });
      }
      if (job.name === JOB_NAMES.TRIGGER_SCHEDULED_CAMPAIGN) {
        return processScheduledCampaignTriggerJob(job as Job<CampaignJobData>, {
          providerOverride: options?.providerOverride,
        });
      }
      return processCampaignRecipientJob(job as Job<CampaignJobData>, {
        providerOverride: options?.providerOverride,
      });
    },
    {
      connection,
      concurrency,
      limiter: {
        max: parseInt(process.env.EMAIL_CAMPAIGN_MAX_RATE || "10", 10),
        duration: 1000,
      },
    }
  );

  worker.on("completed", (job) => {
    logger.info(`[Worker:Campaign] Job ${job.id} completed successfully`);
  });

  worker.on("failed", (job, err) => {
    logger.error(`[Worker:Campaign] Job ${job?.id} failed with error: ${err.message}`);
  });

  worker.on("error", (err) => {
    logger.error("[Worker:Campaign] Worker runtime error:", err);
  });

  return worker;
}
