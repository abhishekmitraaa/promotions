/**
 * BullMQ Campaign Recipient Worker Processor
 *
 * Implements authoritative individual campaign recipient job processing:
 * 1. Checks current campaign lifecycle state (PAUSED / CANCELLED guards).
 * 2. Enforces stale-delivery protection (never sends to an already SENT recipient).
 * 3. Enforces real-time suppression verification prior to dispatch.
 * 4. Resolves bound immutable template version and renders personalized snapshot.
 * 5. Dispatches email via resolved tenant provider.
 * 6. Records EmailDelivery and updates EmailCampaignRecipient state.
 * 7. Increments campaign delivery counters and transitions to COMPLETED when finished.
 */

import { Job, UnrecoverableError, Worker } from "bullmq";
import { prisma } from "../../prisma";
import { CampaignJobData, RetryableEmailError, QUEUE_NAMES } from "./types";
import { createWorkerRedisConnection } from "./connection";
import { TemplateEngine } from "../template-engine";
import { EmailSuppressionService } from "../../services/email-suppression-service";
import { EmailUnsubscribeService } from "../../services/email-unsubscribe-service";
import { providerRegistry } from "../registry";
import { EmailProvider } from "../types";
import { logger } from "../../logger";
import {
  EmailCampaignStatus,
  EmailDeliveryStatus,
  EmailProviderType,
  EmailType,
} from "@prisma/client";

export interface CampaignWorkerOptions {
  providerOverride?: EmailProvider;
}

export async function processCampaignRecipientJob(
  job: Job<CampaignJobData>,
  options?: CampaignWorkerOptions
) {
  const { campaignRecipientId, campaignId, clientId } = job.data;
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

  // 2. Stale Guard: If already SENT, skip execution
  if (recipient.status === "SENT") {
    logger.info(`[Worker:Campaign] Recipient ${campaignRecipientId} already SENT. Skipping duplicate execution.`);
    return { skipped: true, reason: "ALREADY_SENT" };
  }

  // 3. Load Authoritative Campaign & Check Lifecycle State
  const campaign = await prisma.emailCampaign.findUnique({
    where: { id: campaignId },
    include: { templateVersion: true },
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

  // 6. Resolve Provider
  let provider: EmailProvider;
  let providerType: EmailProviderType = EmailProviderType.GMAIL;
  let senderEmail: string | undefined;

  if (options?.providerOverride) {
    provider = options.providerOverride;
    providerType = provider.providerType;
  } else {
    try {
      const resolved = await providerRegistry.resolveForTenant(clientId);
      provider = resolved.provider;
      providerType = resolved.providerType;
      senderEmail = resolved.senderEmail;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Provider resolution failed";
      throw new UnrecoverableError(msg);
    }
  }

  // 7. Dispatch Email with One-Click Unsubscribe Headers
  const fromAddress = senderEmail || "campaigns@whatsapphub.internal";
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

  try {
    const sendResult = await provider.send({
      clientId,
      type: "PROMOTIONAL",
      to: recipient.email,
      from: fromAddress,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      headers: unsubscribeHeaders,
      campaignRecipientId: recipient.id,
    });

    if (sendResult.accepted) {
      // 8. Update Recipient and Persist Delivery
      await prisma.emailCampaignRecipient.update({
        where: { id: recipient.id },
        data: { status: "SENT" },
      });

      await prisma.emailDelivery.create({
        data: {
          clientId,
          campaignRecipientId: recipient.id,
          category: EmailType.PROMOTIONAL,
          providerType,
          providerMessageId: sendResult.providerMessageId || null,
          from: fromAddress,
          to: recipient.email,
          subject: rendered.subject,
          status: EmailDeliveryStatus.SENT,
          sentAt: new Date(),
        },
      });

      // 9. Increment Campaign Sent Count
      const updatedCampaign = await prisma.emailCampaign.update({
        where: { id: campaign.id },
        data: { sentCount: { increment: 1 } },
      });

      // 10. Check if All Recipients Sent -> Transition to COMPLETED
      if (updatedCampaign.sentCount >= updatedCampaign.totalRecipients && updatedCampaign.totalRecipients > 0) {
        await prisma.emailCampaign.update({
          where: { id: campaign.id },
          data: {
            status: EmailCampaignStatus.COMPLETED,
            completedAt: new Date(),
          },
        });
        logger.info(`[Worker:Campaign] Campaign ${campaign.id} completed. All ${updatedCampaign.sentCount} recipients sent.`);
      }

      return {
        success: true,
        campaignRecipientId: recipient.id,
        providerMessageId: sendResult.providerMessageId,
      };
    }

    // Provider returned error
    const err = sendResult.error;
    if (err?.retryable) {
      throw new RetryableEmailError(err.message, err.code);
    } else {
      await prisma.emailCampaignRecipient.update({
        where: { id: recipient.id },
        data: { status: "FAILED" },
      });
      throw new UnrecoverableError(err?.message || "Permanent delivery failure");
    }
  } catch (err: unknown) {
    if (err instanceof UnrecoverableError) throw err;
    if (err instanceof RetryableEmailError) throw err;

    const errMsg = err instanceof Error ? err.message : String(err);
    if (errMsg.includes("429") || errMsg.includes("timeout") || errMsg.includes("ETIMEDOUT")) {
      throw new RetryableEmailError(errMsg, "PROVIDER_RETRYABLE");
    }

    await prisma.emailCampaignRecipient.update({
      where: { id: recipient.id },
      data: { status: "FAILED" },
    });
    throw new UnrecoverableError(errMsg);
  }
}

/**
 * Creates and configures the BullMQ Worker for promotional campaign recipient jobs.
 */
export function createCampaignWorker(options?: {
  connection?: ReturnType<typeof createWorkerRedisConnection>;
  concurrency?: number;
  providerOverride?: EmailProvider;
}): Worker {
  const connection = options?.connection || createWorkerRedisConnection();
  const concurrency =
    options?.concurrency || parseInt(process.env.EMAIL_CAMPAIGN_CONCURRENCY || "5", 10);

  const worker = new Worker<CampaignJobData>(
    QUEUE_NAMES.CAMPAIGN,
    async (job) => {
      return processCampaignRecipientJob(job, {
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

