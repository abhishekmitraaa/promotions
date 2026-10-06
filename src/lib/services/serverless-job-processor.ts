/**
 * Serverless Job Processor Service
 *
 * Implements durable, workerless background processing on Vercel + Supabase:
 * - Triggered periodically via Supabase Cron (pg_cron) -> pg_net HTTP POST
 * - Executes in short-lived Vercel Serverless Functions (bounded execution window)
 * - Safe concurrent execution via PostgreSQL FOR UPDATE SKIP LOCKED
 * - Eliminates the requirement for a persistent Node.js worker process
 * - Fully preserves all existing lifecycle, campaign, automation, and email functionality
 */

import { prisma } from "../prisma";
import {
  EmailDeliveryStatus,
  EmailCampaignStatus,
  EmailAutomationStatus,
  EmailEnrollmentStatus,
  EmailEventProcessingStatus,
  EmailAutomationTriggerType,
} from "@prisma/client";
import { processTransactionalJob } from "../email/queue/worker";
import {
  processCampaignRecipientJob,
  checkAndCompleteCampaign,
} from "../email/queue/campaign-worker";
import { processScheduledCampaignTriggerJob } from "../email/queue/campaign-trigger-worker";
import { EmailEventService } from "./email-event-service";
import { EmailAutomationService } from "./email-automation-service";
import { reconcileAbandonedJobs } from "../email/queue/reconciliation";
import { processWebhookDeliveryQueue } from "../webhooks/dispatcher";
import {
  JOB_NAMES,
  getTransactionalJobId,
  getCampaignJobId,
  TransactionalJobData,
  CampaignJobData,
} from "../email/queue/types";
import { logger } from "../logger";
import type { Job } from "bullmq";

export interface ServerlessProcessingOptions {
  transactionalBatchSize?: number;
  scheduledCampaignBatchSize?: number;
  recipientBatchSize?: number;
  recurringAutomationBatchSize?: number;
  enrollmentBatchSize?: number;
  eventBatchSize?: number;
  webhookBatchSize?: number;
  runReconciliation?: boolean;
  maxExecutionTimeMs?: number;
}

export interface ServerlessProcessingResult {
  success: boolean;
  timestamp: string;
  durationMs: number;
  results: {
    webhooks: { claimed: number; succeeded: number; failed: number };
    transactional: { processed: number; succeeded: number; failed: number };
    scheduledCampaigns: { processed: number; succeeded: number; failed: number };
    campaignRecipients: { processed: number; succeeded: number; failed: number };
    recurringAutomations: { processed: number; succeeded: number; failed: number };
    automationEnrollments: { processed: number; succeeded: number; failed: number };
    events: { processed: number; succeeded: number; failed: number };
    reconciliation: {
      recoveredDeliveries: number;
      failedDeliveries: number;
      recoveredRecipients: number;
      completedCampaigns: number;
    } | null;
  };
}

let lastReconciliationAt = 0;
const RECONCILIATION_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export class ServerlessJobProcessor {
  /**
   * 1. Process Outbound Webhooks (uses existing atomic PostgreSQL queue)
   */
  static async processWebhooks(batchSize = 20) {
    try {
      return await processWebhookDeliveryQueue({ batchSize });
    } catch (err) {
      logger.error("[ServerlessProcessor] Webhook processing error:", err);
      return { claimed: 0, succeeded: 0, failed: 0 };
    }
  }

  /**
   * 2. Process Transactional Emails
   * Claims QUEUED deliveries atomically and executes provider send
   */
  static async processTransactionalEmails(batchSize = 20): Promise<{ processed: number; succeeded: number; failed: number }> {
    let processed = 0;
    let succeeded = 0;
    let failed = 0;

    try {
      // Claim QUEUED deliveries with atomic status update
      const claimedDeliveries = await prisma.$transaction(async (tx) => {
        const rows = (await tx.$queryRawUnsafe(`
          WITH claimed AS (
            SELECT d.id
            FROM "EmailDelivery" d
            WHERE d."status" = 'QUEUED'
              AND (d."nextAttemptAt" IS NULL OR d."nextAttemptAt" <= NOW())
            ORDER BY d."createdAt" ASC
            LIMIT ${batchSize}
            FOR UPDATE SKIP LOCKED
          )
          UPDATE "EmailDelivery" d
          SET "status" = 'PROCESSING',
              "lastAttemptAt" = NOW(),
              "attemptCount" = d."attemptCount" + 1
          FROM claimed c
          WHERE d.id = c.id
          RETURNING d.id, d."clientId";
        `).catch(() => [])) as { id: string; clientId: string }[];

        return rows;
      });

      if (claimedDeliveries.length === 0) {
        return { processed: 0, succeeded: 0, failed: 0 };
      }

      for (const item of claimedDeliveries) {
        processed++;
        try {
          const fakeJob = {
            id: getTransactionalJobId(item.id),
            name: JOB_NAMES.SEND_TRANSACTIONAL,
            data: { deliveryId: item.id, clientId: item.clientId } as TransactionalJobData,
          } as unknown as Job<TransactionalJobData>;

          await processTransactionalJob(fakeJob);
          succeeded++;
        } catch (jobErr) {
          failed++;
          logger.error(`[ServerlessProcessor] Transactional email ${item.id} execution failed:`, jobErr);
        }
      }
    } catch (err) {
      logger.error("[ServerlessProcessor] Transactional processing batch error:", err);
    }

    return { processed, succeeded, failed };
  }

  /**
   * 3. Process Scheduled Campaigns
   * Evaluates SCHEDULED campaigns whose scheduledAt has arrived
   */
  static async processScheduledCampaigns(batchSize = 5): Promise<{ processed: number; succeeded: number; failed: number }> {
    let processed = 0;
    let succeeded = 0;
    let failed = 0;

    try {
      const scheduledCampaigns = await prisma.emailCampaign.findMany({
        where: {
          status: EmailCampaignStatus.SCHEDULED,
          scheduledAt: { lte: new Date() },
        },
        take: batchSize,
        orderBy: { scheduledAt: "asc" },
      });

      for (const campaign of scheduledCampaigns) {
        processed++;
        try {
          const fakeJob = {
            id: `campaign-trigger-${campaign.id}`,
            name: JOB_NAMES.TRIGGER_SCHEDULED_CAMPAIGN,
            data: { campaignId: campaign.id, clientId: campaign.clientId } as CampaignJobData,
          } as unknown as Job<CampaignJobData>;

          await processScheduledCampaignTriggerJob(fakeJob);
          succeeded++;
        } catch (jobErr) {
          failed++;
          logger.error(`[ServerlessProcessor] Scheduled campaign ${campaign.id} trigger failed:`, jobErr);
        }
      }
    } catch (err) {
      logger.error("[ServerlessProcessor] Scheduled campaign processing error:", err);
    }

    return { processed, succeeded, failed };
  }

  /**
   * 4. Process Running Campaign Recipients
   * Dispatches PENDING recipients for RUNNING campaigns
   */
  static async processCampaignRecipients(batchSize = 25): Promise<{ processed: number; succeeded: number; failed: number }> {
    let processed = 0;
    let succeeded = 0;
    let failed = 0;

    try {
      // Claim PENDING recipients for RUNNING campaigns atomically
      const claimedRecipients = await prisma.$transaction(async (tx) => {
        const rows = (await tx.$queryRawUnsafe(`
          WITH claimed AS (
            SELECT r.id
            FROM "EmailCampaignRecipient" r
            JOIN "EmailCampaign" c ON c.id = r."campaignId"
            WHERE r."status" = 'PENDING'
              AND c."status" = 'RUNNING'
            ORDER BY r."createdAt" ASC
            LIMIT ${batchSize}
            FOR UPDATE SKIP LOCKED
          )
          UPDATE "EmailCampaignRecipient" r
          SET "status" = 'PROCESSING',
              "updatedAt" = NOW()
          FROM claimed c
          WHERE r.id = c.id
          RETURNING r.id, r."campaignId", (SELECT "clientId" FROM "EmailCampaign" WHERE id = r."campaignId") as "clientId";
        `).catch(() => [])) as { id: string; campaignId: string; clientId: string }[];

        return rows;
      });

      if (claimedRecipients.length === 0) {
        return { processed: 0, succeeded: 0, failed: 0 };
      }

      const affectedCampaignIds = new Set<string>();

      for (const rec of claimedRecipients) {
        processed++;
        affectedCampaignIds.add(rec.campaignId);
        try {
          const fakeJob = {
            id: getCampaignJobId(rec.id),
            name: JOB_NAMES.SEND_CAMPAIGN_RECIPIENT,
            data: {
              campaignRecipientId: rec.id,
              campaignId: rec.campaignId,
              clientId: rec.clientId,
              category: "PROMOTIONAL",
            } as CampaignJobData,
          } as unknown as Job<CampaignJobData>;

          await processCampaignRecipientJob(fakeJob);
          succeeded++;
        } catch (jobErr) {
          failed++;
          logger.error(`[ServerlessProcessor] Campaign recipient ${rec.id} execution failed:`, jobErr);
        }
      }

      // Check if any affected campaign has completed
      for (const cid of affectedCampaignIds) {
        try {
          await checkAndCompleteCampaign(cid);
        } catch (completeErr) {
          logger.warn(`[ServerlessProcessor] Campaign completion check error for ${cid}:`, completeErr);
        }
      }
    } catch (err) {
      logger.error("[ServerlessProcessor] Campaign recipient processing batch error:", err);
    }

    return { processed, succeeded, failed };
  }

  /**
   * 5. Process Recurring Automations
   * Executes scheduled recurring automation runs whose nextRunAt has arrived
   */
  static async processRecurringAutomations(batchSize = 5): Promise<{ processed: number; succeeded: number; failed: number }> {
    let processed = 0;
    let succeeded = 0;
    let failed = 0;

    try {
      const dueAutomations = await prisma.emailAutomation.findMany({
        where: {
          status: EmailAutomationStatus.ACTIVE,
          triggerType: EmailAutomationTriggerType.RECURRING_SCHEDULE,
          nextRunAt: { lte: new Date() },
        },
        take: batchSize,
        orderBy: { nextRunAt: "asc" },
      });

      for (const auto of dueAutomations) {
        processed++;
        try {
          await EmailAutomationService.executeRecurringStep(auto.clientId, auto.id);
          succeeded++;
        } catch (err) {
          failed++;
          logger.error(`[ServerlessProcessor] Recurring automation ${auto.id} failed:`, err);
        }
      }
    } catch (err) {
      logger.error("[ServerlessProcessor] Recurring automation processing error:", err);
    }

    return { processed, succeeded, failed };
  }

  /**
   * 6. Process Waiting Automation Enrollments (Delay Steps & Timeouts)
   */
  static async processAutomationEnrollments(batchSize = 20): Promise<{ processed: number; succeeded: number; failed: number }> {
    let processed = 0;
    let succeeded = 0;
    let failed = 0;

    try {
      // Find enrollments WAITING with nextActionAt in the past
      const dueEnrollments = await prisma.emailAutomationEnrollment.findMany({
        where: {
          status: EmailEnrollmentStatus.WAITING,
          nextActionAt: { lte: new Date() },
          automation: { status: EmailAutomationStatus.ACTIVE },
        },
        include: {
          automation: { select: { steps: true } },
        },
        take: batchSize,
        orderBy: { nextActionAt: "asc" },
      });

      for (const enrollment of dueEnrollments) {
        processed++;
        try {
          if (!enrollment.currentStepId) {
            continue;
          }

          let steps: { id: string; type: string; nextStepId?: string }[] = [];
          try {
            steps = JSON.parse(enrollment.automation.steps);
          } catch {
            steps = [];
          }

          const currentStep = steps.find((s) => s.id === enrollment.currentStepId);

          if (currentStep?.type === "WAIT_FOR_EVENT") {
            // Timeout expired for WAIT_FOR_EVENT
            await EmailAutomationService.executeStepTimeout(
              enrollment.clientId,
              enrollment.id,
              enrollment.currentStepId
            );
          } else if (currentStep?.type === "DELAY" && currentStep.nextStepId) {
            // Delay expired -> advance to next step
            await EmailAutomationService.processEnrollmentStep(
              enrollment.clientId,
              enrollment.id,
              currentStep.nextStepId
            );
          } else {
            // General step advance
            await EmailAutomationService.processEnrollmentStep(
              enrollment.clientId,
              enrollment.id,
              enrollment.currentStepId
            );
          }

          succeeded++;
        } catch (err) {
          failed++;
          logger.error(`[ServerlessProcessor] Automation enrollment ${enrollment.id} step failed:`, err);
        }
      }
    } catch (err) {
      logger.error("[ServerlessProcessor] Automation enrollment processing error:", err);
    }

    return { processed, succeeded, failed };
  }

  /**
   * 7. Process Email Webhook Events (RECEIVED status)
   */
  static async processEmailEvents(batchSize = 20): Promise<{ processed: number; succeeded: number; failed: number }> {
    let processed = 0;
    let succeeded = 0;
    let failed = 0;

    try {
      const pendingEvents = await prisma.emailEvent.findMany({
        where: { status: EmailEventProcessingStatus.RECEIVED },
        take: batchSize,
        orderBy: { occurredAt: "asc" },
      });

      for (const event of pendingEvents) {
        processed++;
        try {
          await EmailEventService.processEventFromWorker(event.id);
          succeeded++;
        } catch (err) {
          failed++;
          logger.error(`[ServerlessProcessor] Email event ${event.id} processing failed:`, err);
        }
      }
    } catch (err) {
      logger.error("[ServerlessProcessor] Email events batch processing error:", err);
    }

    return { processed, succeeded, failed };
  }

  /**
   * 8. Periodic Job Reconciliation
   */
  static async reconcileJobs(staleMinutes = 10) {
    try {
      return await reconcileAbandonedJobs({
        batchSize: 50,
        staleThresholdMinutes: staleMinutes,
      });
    } catch (err) {
      logger.error("[ServerlessProcessor] Reconciliation error:", err);
      return null;
    }
  }

  /**
   * Master Execution Entrypoint: Process all pending queues in bounded order
   */
  static async processAll(options: ServerlessProcessingOptions = {}): Promise<ServerlessProcessingResult> {
    const startTime = Date.now();
    const maxExecutionMs = options.maxExecutionTimeMs || 25000; // 25s Vercel budget

    logger.info("[ServerlessProcessor] Starting workerless processing pass...");

    // 1. Webhooks
    const webhooks = await this.processWebhooks(options.webhookBatchSize || 20);

    // 2. Transactional Emails
    const transactional = await this.processTransactionalEmails(options.transactionalBatchSize || 20);

    // 3. Scheduled Campaigns
    const scheduledCampaigns = await this.processScheduledCampaigns(options.scheduledCampaignBatchSize || 5);

    // 4. Campaign Recipients
    const campaignRecipients = await this.processCampaignRecipients(options.recipientBatchSize || 25);

    // 5. Recurring Automations
    const recurringAutomations = await this.processRecurringAutomations(options.recurringAutomationBatchSize || 5);

    // 6. Automation Enrollments
    const automationEnrollments = await this.processAutomationEnrollments(options.enrollmentBatchSize || 20);

    // 7. Email Events
    const events = await this.processEmailEvents(options.eventBatchSize || 20);

    // 8. Reconciliation (if requested or due every 5 minutes)
    let reconciliationResult = null;
    const now = Date.now();
    const isDue = now - lastReconciliationAt > RECONCILIATION_INTERVAL_MS;
    if (options.runReconciliation || isDue) {
      reconciliationResult = await this.reconcileJobs();
      lastReconciliationAt = now;
    }

    const durationMs = Date.now() - startTime;
    logger.info(`[ServerlessProcessor] Processing pass complete in ${durationMs}ms`);

    return {
      success: true,
      timestamp: new Date().toISOString(),
      durationMs,
      results: {
        webhooks,
        transactional,
        scheduledCampaigns,
        campaignRecipients,
        recurringAutomations,
        automationEnrollments,
        events,
        reconciliation: reconciliationResult
          ? {
              recoveredDeliveries: reconciliationResult.recoveredDeliveries,
              failedDeliveries: reconciliationResult.failedDeliveries,
              recoveredRecipients: reconciliationResult.recoveredRecipients,
              completedCampaigns: reconciliationResult.completedCampaigns,
            }
          : null,
      },
    };
  }
}
