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
} from "@prisma/client";
import { CampaignTriggerService } from "./campaign-trigger-service";
import { logger } from "../../logger";

export interface ReconciliationOptions {
  staleMinutes?: number;
  maxAttempts?: number;
}

export interface ReconciliationReport {
  recoveredDeliveries: number;
  failedDeliveries: number;
  recoveredRecipients: number;
  failedRecipients: number;
  recoveredJobs: number;
  failedJobs: number;
  completedCampaigns: number;
}

export class ReconciliationExecutor {
  static async reconcile(options?: ReconciliationOptions): Promise<ReconciliationReport> {
    const staleMinutes = options?.staleMinutes || 10;
    const maxAttempts = options?.maxAttempts || 5;
    const staleCutoff = new Date(Date.now() - staleMinutes * 60 * 1000);

    let recoveredDeliveries = 0;
    let failedDeliveries = 0;
    let recoveredRecipients = 0;
    let failedRecipients = 0;
    let recoveredJobs = 0;
    let failedJobs = 0;
    let completedCampaigns = 0;

    logger.info(`[ReconciliationExecutor] Starting reconciliation sweep (cutoff: ${staleCutoff.toISOString()})`);

    // 1. Stale EmailDelivery in 'PROCESSING'
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
      if ((delivery.attemptCount || 0) >= maxAttempts) {
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
    const staleRecipients = await prisma.emailCampaignRecipient.findMany({
      where: {
        status: "PROCESSING",
        OR: [
          { lockedAt: { lt: staleCutoff } },
          { lastAttemptAt: { lt: staleCutoff } },
          { lockedAt: null, lastAttemptAt: null, updatedAt: { lt: staleCutoff } },
        ],
      },
      take: 100,
    });

    for (const recipient of staleRecipients) {
      if ((recipient.attemptCount || 0) >= maxAttempts) {
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

    // 3. Stale BackgroundJob in 'PROCESSING'
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
    const activeCampaigns = await prisma.emailCampaign.findMany({
      where: {
        status: { in: [EmailCampaignStatus.RUNNING, EmailCampaignStatus.PAUSED] },
      },
      select: { id: true },
      take: 50,
    });

    for (const camp of activeCampaigns) {
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
    };

    logger.info(`[ReconciliationExecutor] Reconciliation cycle complete`, report as unknown as Record<string, unknown>);
    return report;
  }
}
