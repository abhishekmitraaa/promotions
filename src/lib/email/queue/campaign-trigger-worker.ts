/**
 * Dedicated Scheduled Campaign Trigger Worker Processor
 *
 * Implements authoritative trigger processing for scheduled campaigns:
 * 1. Loads campaign by tenant and ID.
 * 2. Verifies campaign status is SCHEDULED.
 * 3. Verifies scheduled time has arrived (with small clock skew tolerance).
 * 4. Verifies campaign has valid template/sender/audience configuration.
 * 5. Atomically transitions campaign state from SCHEDULED to RUNNING.
 * 6. Creates the immutable audience snapshot exactly once.
 * 7. Enqueues deterministic individual recipient jobs on BullMQ.
 * 8. Ensures idempotency against duplicate triggers.
 * 9. Enforces honest queue failure handling with recoverable/observable state.
 */

import { Job, UnrecoverableError } from "bullmq";
import { prisma } from "../../prisma";
import { CampaignJobData, JOB_NAMES, getCampaignJobId, RetryableEmailError } from "./types";
import { EmailAudienceResolver } from "../../services/email-audience-resolver";
import { getCampaignQueue } from "./queues";
import { logger } from "../../logger";
import { EmailCampaignStatus, EmailProviderStatus } from "@prisma/client";
import { EmailProvider } from "../types";

export interface ScheduledTriggerOptions {
  providerOverride?: EmailProvider;
}

export async function processScheduledCampaignTriggerJob(
  job: Job<CampaignJobData>,
  options?: ScheduledTriggerOptions
) {
  void options;
  const { campaignId, clientId } = job.data;
  if (!campaignId || !clientId) {
    throw new UnrecoverableError("campaignId and clientId are required for trigger job.");
  }

  logger.info(
    `[Worker:CampaignTrigger] Processing trigger job ${job.id} for campaign ${campaignId} (tenant: ${clientId})`
  );

  // 1. Load Campaign by Tenant and ID with relations
  const campaign = await prisma.emailCampaign.findFirst({
    where: { id: campaignId, clientId },
    include: {
      templateVersion: true,
      senderIdentity: {
        include: {
          providerConfig: true,
        },
      },
      list: true,
      segment: true,
    },
  });

  if (!campaign) {
    throw new UnrecoverableError(
      `Campaign '${campaignId}' not found for tenant '${clientId}'.`
    );
  }

  // 2. Verify Campaign is in SCHEDULED status
  if (campaign.status !== EmailCampaignStatus.SCHEDULED) {
    logger.info(
      `[Worker:CampaignTrigger] Campaign '${campaignId}' is in status '${campaign.status}', expected SCHEDULED. Skipping execution.`
    );
    return { skipped: true, reason: `CAMPAIGN_NOT_SCHEDULED_${campaign.status}` };
  }

  // 3. Verify Scheduled Time Has Arrived
  const now = new Date();
  if (campaign.scheduledAt && campaign.scheduledAt.getTime() > now.getTime() + 1000) {
    logger.warn(
      `[Worker:CampaignTrigger] Scheduled time ${campaign.scheduledAt.toISOString()} has not arrived yet (current: ${now.toISOString()}).`
    );
    throw new RetryableEmailError(
      `Scheduled time has not arrived yet for campaign '${campaignId}'.`
    );
  }

  // 4. Verify Campaign Configuration (Template, Audience, Sender)
  // 4a. Template Configuration
  if (!campaign.templateVersionId || !campaign.templateVersion) {
    await prisma.emailCampaign.update({
      where: { id: campaign.id },
      data: { status: EmailCampaignStatus.FAILED },
    });
    throw new UnrecoverableError(
      `Campaign '${campaignId}' has no valid bound template version.`
    );
  }

  // 4b. Audience Configuration
  if (!campaign.listId && !campaign.segmentId) {
    await prisma.emailCampaign.update({
      where: { id: campaign.id },
      data: { status: EmailCampaignStatus.FAILED },
    });
    throw new UnrecoverableError(
      `Campaign '${campaignId}' has no audience list or segment configured.`
    );
  }

  // 4c. Sender Identity Configuration
  if (campaign.senderIdentityId) {
    const sender = campaign.senderIdentity;
    if (!sender || sender.clientId !== clientId) {
      await prisma.emailCampaign.update({
        where: { id: campaign.id },
        data: { status: EmailCampaignStatus.FAILED },
      });
      throw new UnrecoverableError(
        `Sender identity '${campaign.senderIdentityId}' does not belong to tenant '${clientId}'.`
      );
    }

    if (!sender.verified) {
      await prisma.emailCampaign.update({
        where: { id: campaign.id },
        data: { status: EmailCampaignStatus.FAILED },
      });
      throw new UnrecoverableError(
        `Sender identity '${sender.email}' is not verified.`
      );
    }

    if (sender.providerConfigId) {
      if (!sender.providerConfig || sender.providerConfig.status !== EmailProviderStatus.ACTIVE) {
        await prisma.emailCampaign.update({
          where: { id: campaign.id },
          data: { status: EmailCampaignStatus.FAILED },
        });
        throw new UnrecoverableError(
          `Provider configuration for sender identity '${sender.email}' is not active.`
        );
      }

      if (sender.providerConfig.clientId !== clientId) {
        await prisma.emailCampaign.update({
          where: { id: campaign.id },
          data: { status: EmailCampaignStatus.FAILED },
        });
        throw new UnrecoverableError(
          `Provider configuration for sender identity does not belong to tenant '${clientId}'.`
        );
      }
    }
  }

  // 5. Atomically Transition State from SCHEDULED to RUNNING
  const transitionResult = await prisma.emailCampaign.updateMany({
    where: {
      id: campaign.id,
      clientId,
      status: EmailCampaignStatus.SCHEDULED,
    },
    data: {
      status: EmailCampaignStatus.RUNNING,
      startedAt: new Date(),
    },
  });

  if (transitionResult.count === 0) {
    logger.info(
      `[Worker:CampaignTrigger] Campaign '${campaignId}' atomic transition from SCHEDULED to RUNNING affected 0 rows (concurrent execution or status mutation). Skipping.`
    );
    return { skipped: true, reason: "CONCURRENT_TRIGGER_OR_STATUS_CHANGED" };
  }

  // 6. Create the Immutable Audience Snapshot Exactly Once
  let recipients = await prisma.emailCampaignRecipient.findMany({
    where: { campaignId: campaign.id },
  });

  if (recipients.length === 0) {
    await EmailAudienceResolver.createRecipientSnapshot(clientId, {
      id: campaign.id,
      listId: campaign.listId,
      segmentId: campaign.segmentId,
      type: campaign.type,
    });

    recipients = await prisma.emailCampaignRecipient.findMany({
      where: { campaignId: campaign.id },
    });
  }

  // If no eligible recipients exist, complete the campaign immediately
  if (recipients.length === 0) {
    logger.info(
      `[Worker:CampaignTrigger] Campaign '${campaignId}' resolved audience produced 0 eligible recipients. Completing campaign.`
    );
    await prisma.emailCampaign.update({
      where: { id: campaign.id },
      data: {
        status: EmailCampaignStatus.COMPLETED,
        completedAt: new Date(),
        totalRecipients: 0,
      },
    });
    return { success: true, enqueuedCount: 0, reason: "EMPTY_AUDIENCE_COMPLETED" };
  }

  // 7. Enqueue Deterministic Individual Recipient Jobs on BullMQ
  let enqueuedCount = 0;
  try {
    const queue = getCampaignQueue();
    for (const recipient of recipients) {
      if (recipient.status === "PENDING") {
        const jobId = getCampaignJobId(recipient.id);
        const jobData: CampaignJobData = {
          campaignRecipientId: recipient.id,
          campaignId: campaign.id,
          clientId,
          category: "PROMOTIONAL",
        };

        // If completed or failed job with the same ID already exists in BullMQ, remove it first
        const existingJob = await queue.getJob(jobId);
        if (existingJob) {
          const state = await existingJob.getState();
          if (state === "completed" || state === "failed") {
            await existingJob.remove();
          }
        }

        await queue.add(JOB_NAMES.SEND_CAMPAIGN_RECIPIENT, jobData, {
          jobId,
        });
        enqueuedCount++;
      }
    }
  } catch (queueErr: unknown) {
    // 8. Queue failure must never produce fake success.
    // A scheduled campaign whose queue insertion fails must have a recoverable and observable state (FAILED).
    await prisma.emailCampaign.update({
      where: { id: campaign.id },
      data: {
        status: EmailCampaignStatus.FAILED,
      },
    });
    const errMsg = queueErr instanceof Error ? queueErr.message : "Queue insertion failed";
    logger.error(
      `[Worker:CampaignTrigger] Queue failure while enqueuing recipient jobs for campaign '${campaign.id}': ${errMsg}`
    );
    throw new Error(`Queue failure while enqueuing campaign recipients: ${errMsg}`);
  }

  return {
    success: true,
    campaignId: campaign.id,
    enqueuedCount,
    status: EmailCampaignStatus.RUNNING,
  };
}
