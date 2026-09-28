/**
 * Automated Abandoned Job & Stale State Reconciliation Engine
 *
 * Runs on worker startup and periodically (e.g. Every 5 minutes):
 * 1. Recovers abandoned EmailDelivery records stuck in 'PROCESSING' across unexpected worker crashes or timeouts.
 * 2. Recovers abandoned EmailCampaignRecipient records stuck in 'PROCESSING'.
 * 3. Enforces campaign safety invariants:
 *    - Paused campaigns remain paused (recipients reverted to PENDING).
 *    - Cancelled campaigns remain cancelled (recipients transitioned to CANCELLED).
 *    - Completed campaigns are never resurrected (any unfinished terminal check marks campaign COMPLETED).
 * 4. Caps retry attempts: Deliveries exceeding max attempts are marked FAILED with 'ABANDONED_TIMED_OUT'.
 */

import { prisma } from "../../prisma";
import { EmailDeliveryStatus, EmailCampaignStatus } from "@prisma/client";
import { workerLogger } from "./worker-logger";
import { checkAndCompleteCampaign } from "./campaign-worker";
import { getTransactionalQueue, getCampaignQueue } from "./queues";
import { getTransactionalJobId, getPromotionalJobId, getCampaignJobId } from "./types";

export interface ReconciliationOptions {
  staleThresholdMinutes?: number;
  maxAttempts?: number;
  batchSize?: number;
}

export interface ReconciliationReport {
  timestamp: string;
  recoveredDeliveries: number;
  failedDeliveries: number;
  recoveredRecipients: number;
  completedCampaigns: number;
  durationMs: number;
}

/**
 * Reconciles abandoned states across deliveries, campaign recipients, and campaigns.
 */
export async function reconcileAbandonedJobs(
  options?: ReconciliationOptions
): Promise<ReconciliationReport> {
  const start = Date.now();
  const thresholdMinutes = options?.staleThresholdMinutes ?? 10;
  const maxAttempts = options?.maxAttempts ?? 3;
  const staleCutoff = new Date(Date.now() - thresholdMinutes * 60 * 1000);

  let recoveredDeliveries = 0;
  let failedDeliveries = 0;
  let recoveredRecipients = 0;
  let completedCampaigns = 0;

  try {
    // -------------------------------------------------------------------------
    // 1. Reconcile Stale EmailDelivery Records in 'PROCESSING'
    // -------------------------------------------------------------------------
    const staleDeliveries = await prisma.emailDelivery.findMany({
      where: {
        status: EmailDeliveryStatus.PROCESSING,
        OR: [
          { lastAttemptAt: { lt: staleCutoff } },
          { lastAttemptAt: null, updatedAt: { lt: staleCutoff } },
        ],
      },
      take: 100, // Batch limit per cycle
    });

    for (const delivery of staleDeliveries) {
      if (delivery.attemptCount >= maxAttempts) {
        // Exceeded retry budget -> Fail permanently
        const res = await prisma.emailDelivery.updateMany({
          where: { id: delivery.id, status: EmailDeliveryStatus.PROCESSING },
          data: {
            status: EmailDeliveryStatus.FAILED,
            errorCode: "ABANDONED_TIMED_OUT",
            errorMessage: `Delivery timed out in PROCESSING status across worker restarts (attempts: ${delivery.attemptCount}).`,
            failedAt: new Date(),
          },
        });
        if (res.count > 0) {
          failedDeliveries++;
          workerLogger.warn(`[Reconciliation] Timed out abandoned delivery ${delivery.id}`, {
            deliveryId: delivery.id,
            tenant: delivery.clientId,
            attempts: delivery.attemptCount,
          });
        }
      } else {
        // Revert to QUEUED and re-enqueue to ensure delivery
        const res = await prisma.emailDelivery.updateMany({
          where: { id: delivery.id, status: EmailDeliveryStatus.PROCESSING },
          data: {
            status: EmailDeliveryStatus.QUEUED,
          },
        });

        if (res.count > 0) {
          recoveredDeliveries++;
          try {
            if (delivery.category === "TRANSACTIONAL") {
              const queue = getTransactionalQueue();
              await queue.add(
                "send-transactional",
                {
                  deliveryId: delivery.id,
                  clientId: delivery.clientId,
                  category: "TRANSACTIONAL",
                  attempt: delivery.attemptCount,
                },
                { jobId: getTransactionalJobId(delivery.id) }
              );
            } else if (delivery.category === "PROMOTIONAL" && !delivery.campaignRecipientId) {
              const queue = getCampaignQueue();
              await queue.add(
                "send-promotional",
                {
                  deliveryId: delivery.id,
                  clientId: delivery.clientId,
                  category: "PROMOTIONAL",
                  attempt: delivery.attemptCount,
                },
                { jobId: getPromotionalJobId(delivery.id) }
              );
            }
            workerLogger.info(`[Reconciliation] Recovered abandoned delivery ${delivery.id} back to queue`, {
              deliveryId: delivery.id,
              tenant: delivery.clientId,
            });
          } catch (enqueueErr) {
            workerLogger.error(`[Reconciliation] Failed to re-enqueue delivery ${delivery.id}`, enqueueErr);
          }
        }
      }
    }

    // -------------------------------------------------------------------------
    // 2. Reconcile Stale EmailCampaignRecipient Records in 'PROCESSING'
    // -------------------------------------------------------------------------
    const staleRecipients = await prisma.emailCampaignRecipient.findMany({
      where: {
        status: "PROCESSING",
        updatedAt: { lt: staleCutoff },
      },
      include: {
        campaign: true,
      },
      take: 100,
    });

    for (const recipient of staleRecipients) {
      if (!recipient.campaign) continue;

      if (recipient.campaign.status === EmailCampaignStatus.CANCELLED) {
        await prisma.emailCampaignRecipient.updateMany({
          where: { id: recipient.id, status: "PROCESSING" },
          data: { status: "CANCELLED" },
        });
        recoveredRecipients++;
      } else if (recipient.campaign.status === EmailCampaignStatus.PAUSED) {
        // Safe pause guarantee: remain in PENDING state
        await prisma.emailCampaignRecipient.updateMany({
          where: { id: recipient.id, status: "PROCESSING" },
          data: { status: "PENDING" },
        });
        recoveredRecipients++;
      } else if (recipient.campaign.status === EmailCampaignStatus.RUNNING) {
        // Reset to PENDING and re-enqueue
        const res = await prisma.emailCampaignRecipient.updateMany({
          where: { id: recipient.id, status: "PROCESSING" },
          data: { status: "PENDING" },
        });

        if (res.count > 0) {
          recoveredRecipients++;
          try {
            const queue = getCampaignQueue();
            await queue.add(
              "send-campaign-recipient",
              {
                campaignRecipientId: recipient.id,
                campaignId: recipient.campaignId,
                clientId: recipient.campaign.clientId,
                category: "PROMOTIONAL",
              },
              { jobId: getCampaignJobId(recipient.id) }
            );
            workerLogger.info(`[Reconciliation] Re-enqueued stalled campaign recipient ${recipient.id}`);
          } catch (reErr) {
            workerLogger.error(`[Reconciliation] Failed to re-enqueue recipient ${recipient.id}`, reErr);
          }
        }
      }
    }

    // -------------------------------------------------------------------------
    // 3. Reconcile Abandoned RUNNING / PAUSED Campaigns with No Active Recipients
    // -------------------------------------------------------------------------
    const activeCampaigns = await prisma.emailCampaign.findMany({
      where: {
        status: { in: [EmailCampaignStatus.RUNNING, EmailCampaignStatus.PAUSED] },
      },
      take: 50,
    });

    for (const c of activeCampaigns) {
      const completed = await checkAndCompleteCampaign(c.id);
      if (completed) {
        completedCampaigns++;
      }
    }
  } catch (err) {
    workerLogger.error("[Reconciliation] Unhandled error during reconciliation cycle", err);
  }

  const durationMs = Date.now() - start;
  const report: ReconciliationReport = {
    timestamp: new Date().toISOString(),
    recoveredDeliveries,
    failedDeliveries,
    recoveredRecipients,
    completedCampaigns,
    durationMs,
  };

  if (recoveredDeliveries > 0 || failedDeliveries > 0 || recoveredRecipients > 0 || completedCampaigns > 0) {
    workerLogger.info("[Reconciliation] Cycle completed with recoveries", report as unknown as Record<string, unknown>);
  }

  return report;
}
