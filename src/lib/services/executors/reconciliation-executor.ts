/**
 * ReconciliationExecutor
 *
 * Neutral, BullMQ-free execution service for recovering abandoned states:
 * 1. Stale EmailDelivery records in 'PROCESSING'
 * 2. Stale EmailCampaignRecipient records in 'PROCESSING'
 * 3. Stale BackgroundJob records in 'PROCESSING'
 * 4. Stale EmailAutomationEnrollment records in 'PROCESSING'
 * 5. Abandoned RUNNING / PAUSED campaigns with no remaining active recipients
 */

import { prisma } from "../../prisma";
import {
  EmailDeliveryStatus,
  EmailCampaignStatus,
  BackgroundJobStatus,
  MessageStatus,
} from "@prisma/client";
import { CampaignTriggerService } from "./campaign-trigger-service";
import { logger } from "../../logger";
import { SEND_IN_FLIGHT_SUFFIX, SEND_OUTCOME_UNKNOWN, STALE_LOCK_MS, isSendInFlight } from "./claim-lock";

export interface ReconciliationOptions {
  staleMinutes?: number;
  maxAttempts?: number;
  isTimeExhausted?: () => boolean;
}

export interface ReconciliationReport {
  recoveredDeliveries: number;
  failedDeliveries: number;
  recoveredRecipients: number;
  failedRecipients: number;
  recoveredJobs: number;
  failedJobs: number;
  completedCampaigns: number;
  /** WhatsApp messages flagged SEND_OUTCOME_UNKNOWN in this sweep. */
  failedMessages?: number;
  durationMs?: number;
  error?: string;
}

export class ReconciliationExecutor {
  static async reconcile(options?: ReconciliationOptions): Promise<ReconciliationReport> {
    const startTime = Date.now();
    const staleMinutes = options?.staleMinutes || STALE_LOCK_MS / 60000;
    const maxAttempts = options?.maxAttempts || 5;
    const staleCutoff = new Date(Date.now() - staleMinutes * 60 * 1000);

    let recoveredDeliveries = 0;
    let failedDeliveries = 0;
    let recoveredRecipients = 0;
    let failedRecipients = 0;
    let recoveredJobs = 0;
    let failedJobs = 0;
    let completedCampaigns = 0;
    let failedMessages = 0;

    logger.info(`[ReconciliationExecutor] Starting reconciliation sweep (cutoff: ${staleCutoff.toISOString()})`);

    const checkTime = () => Boolean(options?.isTimeExhausted && options.isTimeExhausted());

    // 1. Stale EmailDelivery in 'PROCESSING'
    if (checkTime()) {
      logger.warn("[ReconciliationExecutor] Deadline reached before stale delivery check.");
      return { recoveredDeliveries, failedDeliveries, recoveredRecipients, failedRecipients, recoveredJobs, failedJobs, completedCampaigns, durationMs: Date.now() - startTime };
    }
    const staleDeliveries = await prisma.emailDelivery.findMany({
      where: {
        status: EmailDeliveryStatus.PROCESSING,
        OR: [
          { lockedAt: { lt: staleCutoff } },
          { lastAttemptAt: { lt: staleCutoff } },
          { lockedAt: null, lastAttemptAt: null, updatedAt: { lt: staleCutoff } },
        ],
      },
      take: 100,
    });

    for (const delivery of staleDeliveries) {
      if (isSendInFlight(delivery.lockedBy)) {
        // The worker died during the provider call: the email may already be delivered.
        // Never re-queue (that would risk a duplicate); surface it for manual review instead.
        await prisma.emailDelivery.updateMany({
          where: { id: delivery.id, status: EmailDeliveryStatus.PROCESSING, lockedBy: delivery.lockedBy },
          data: {
            status: EmailDeliveryStatus.FAILED,
            errorCode: SEND_OUTCOME_UNKNOWN,
            errorMessage: "Worker stopped during the provider send. The email may or may not have been delivered; not retried automatically.",
            failedAt: new Date(),
            lockedAt: null,
            lockedBy: null,
          },
        });
        failedDeliveries++;
      } else if ((delivery.attemptCount || 0) >= maxAttempts) {
        await prisma.emailDelivery.updateMany({
          where: { id: delivery.id, status: EmailDeliveryStatus.PROCESSING },
          data: {
            status: EmailDeliveryStatus.FAILED,
            errorCode: "ABANDONED_TIMED_OUT",
            errorMessage: `Delivery timed out in PROCESSING status across worker restarts (attempts: ${delivery.attemptCount}).`,
            failedAt: new Date(),
            lockedAt: null,
            lockedBy: null,
          },
        });
        failedDeliveries++;
      } else {
        await prisma.emailDelivery.updateMany({
          where: { id: delivery.id, status: EmailDeliveryStatus.PROCESSING },
          data: {
            status: EmailDeliveryStatus.QUEUED,
            lockedAt: null,
            lockedBy: null,
          },
        });
        recoveredDeliveries++;
      }
    }

    // 2. Stale EmailCampaignRecipient in 'PROCESSING'
    if (checkTime()) {
      logger.warn("[ReconciliationExecutor] Deadline reached before stale recipient check.");
      return { recoveredDeliveries, failedDeliveries, recoveredRecipients, failedRecipients, recoveredJobs, failedJobs, completedCampaigns, durationMs: Date.now() - startTime };
    }
    const staleRecipients = await prisma.emailCampaignRecipient.findMany({
      where: {
        status: "PROCESSING",
        OR: [
          { lockedAt: { lt: staleCutoff } },
          { lastAttemptAt: { lt: staleCutoff } },
          { lockedAt: null, lastAttemptAt: null, updatedAt: { lt: staleCutoff } },
        ],
      },
      include: { campaign: { select: { status: true } } },
      take: 100,
    });

    for (const recipient of staleRecipients) {
      if (checkTime()) break;
      if (!isSendInFlight(recipient.lockedBy) && recipient.campaign?.status === EmailCampaignStatus.CANCELLED) {
        // Never resurrect work for a cancelled campaign (the recipient sweep ignores it anyway)
        await prisma.emailCampaignRecipient.updateMany({
          where: { id: recipient.id, status: "PROCESSING" },
          data: { status: "CANCELLED", lockedAt: null, lockedBy: null },
        });
        recoveredRecipients++;
      } else if (isSendInFlight(recipient.lockedBy)) {
        await prisma.emailCampaignRecipient.updateMany({
          where: { id: recipient.id, status: "PROCESSING", lockedBy: recipient.lockedBy },
          data: {
            status: "FAILED",
            errorCode: SEND_OUTCOME_UNKNOWN,
            errorMessage: "Worker stopped during the provider send. The email may or may not have been delivered; not retried automatically.",
            lockedAt: null,
            lockedBy: null,
          },
        });
        failedRecipients++;
      } else if ((recipient.attemptCount || 0) >= maxAttempts) {
        await prisma.emailCampaignRecipient.updateMany({
          where: { id: recipient.id, status: "PROCESSING" },
          data: {
            status: "FAILED",
            errorCode: "ABANDONED_TIMED_OUT",
            errorMessage: "Recipient stalled in PROCESSING status across worker restarts.",
            lockedAt: null,
            lockedBy: null,
          },
        });
        failedRecipients++;
      } else {
        await prisma.emailCampaignRecipient.updateMany({
          where: { id: recipient.id, status: "PROCESSING" },
          data: {
            status: "PENDING",
            lockedAt: null,
            lockedBy: null,
          },
        });
        recoveredRecipients++;
      }
    }

    // 2b. Outbound WhatsApp messages whose send was in flight when the invocation died.
    //     Meta may have accepted them, so they are flagged for review and never re-sent.
    //     (Stale locks without the in-flight marker are simply reclaimed by the retry executor.)
    if (!checkTime()) {
      const flagged = await prisma.message.updateMany({
        where: {
          status: MessageStatus.QUEUED,
          lockedAt: { lt: staleCutoff },
          lockedBy: { endsWith: SEND_IN_FLIGHT_SUFFIX },
        },
        data: {
          status: MessageStatus.FAILED,
          errorCode: SEND_OUTCOME_UNKNOWN,
          errorMessage: "Worker stopped during the provider send. The message may or may not have been delivered; not retried automatically.",
          failedAt: new Date(),
          lockedAt: null,
          lockedBy: null,
        },
      });
      failedMessages = flagged.count;
    }

    // 3. Stale BackgroundJob in 'PROCESSING'
    if (checkTime()) {
      logger.warn("[ReconciliationExecutor] Deadline reached before stale job check.");
      return { recoveredDeliveries, failedDeliveries, recoveredRecipients, failedRecipients, recoveredJobs, failedJobs, completedCampaigns, durationMs: Date.now() - startTime };
    }
    const staleJobs = await prisma.backgroundJob.findMany({
      where: {
        status: BackgroundJobStatus.PROCESSING,
        OR: [
          { lockedAt: { lt: staleCutoff } },
          { lastAttemptAt: { lt: staleCutoff } },
          { lockedAt: null, lastAttemptAt: null, updatedAt: { lt: staleCutoff } },
        ],
      },
      take: 100,
    });

    for (const job of staleJobs) {
      if (checkTime()) break;
      if (job.attemptCount >= job.maxAttempts) {
        await prisma.backgroundJob.updateMany({
          where: { id: job.id, status: BackgroundJobStatus.PROCESSING },
          data: {
            status: BackgroundJobStatus.FAILED,
            failedAt: new Date(),
            lastErrorCode: "ABANDONED_TIMED_OUT",
            lastErrorMessage: "Background job stalled in PROCESSING status across worker restarts.",
            lockedAt: null,
            lockedBy: null,
          },
        });
        failedJobs++;
      } else {
        await prisma.backgroundJob.updateMany({
          where: { id: job.id, status: BackgroundJobStatus.PROCESSING },
          data: {
            status: BackgroundJobStatus.QUEUED,
            lockedAt: null,
            lockedBy: null,
          },
        });
        recoveredJobs++;
      }
    }

    // 4. Stale Campaigns: Complete any RUNNING or PAUSED campaign that has 0 active recipients
    if (checkTime()) {
      logger.warn("[ReconciliationExecutor] Deadline reached before stale campaign check.");
      return { recoveredDeliveries, failedDeliveries, recoveredRecipients, failedRecipients, recoveredJobs, failedJobs, completedCampaigns, durationMs: Date.now() - startTime };
    }
    const activeCampaigns = await prisma.emailCampaign.findMany({
      where: {
        status: { in: [EmailCampaignStatus.RUNNING, EmailCampaignStatus.PAUSED] },
      },
      select: { id: true },
      take: 50,
    });

    for (const camp of activeCampaigns) {
      if (checkTime()) break;
      const completed = await CampaignTriggerService.checkAndCompleteCampaign(camp.id);
      if (completed) {
        completedCampaigns++;
      }
    }

    const report: ReconciliationReport = {
      recoveredDeliveries,
      failedDeliveries,
      recoveredRecipients,
      failedRecipients,
      recoveredJobs,
      failedJobs,
      completedCampaigns,
      failedMessages,
      durationMs: Date.now() - startTime,
    };

    logger.info(`[ReconciliationExecutor] Reconciliation cycle complete`, report as unknown as Record<string, unknown>);
    return report;
  }
}
