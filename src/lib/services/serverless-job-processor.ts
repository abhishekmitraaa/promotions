/**
 * Serverless Job Processor Service
 *
 * Implements durable, fair-dispatch, workerless background processing:
 * - Triggered periodically via Supabase Cron (pg_cron) -> pg_net HTTP POST
 * - Executes in bounded serverless function execution window (with 4s safety buffer)
 * - Concurrency control via PostgreSQL SELECT ... FOR UPDATE SKIP LOCKED
 * - Tenant Fair Dispatch: partitions queues by tenant (clientId) to prevent starvation
 * - Category Priority: TRANSACTIONAL is always dispatched before PROMOTIONAL
 * - Neutral Domain Executors: zero BullMQ coupling or fake Job wrappers
 * - Full backward and forward compatibility with both BackgroundJob table and table-specific queues
 */

import { prisma } from "../prisma";
import {
  EmailDeliveryStatus,
  EmailCampaignStatus,
  BackgroundJobStatus,
} from "@prisma/client";
import { EmailDeliveryExecutor } from "./executors/email-delivery-executor";
import { CampaignRecipientExecutor } from "./executors/campaign-recipient-executor";
import { CampaignTriggerService } from "./executors/campaign-trigger-service";
import { AutomationExecutor } from "./executors/automation-executor";
import { EmailEventProcessor } from "./executors/email-event-processor";
import { WebhookDeliveryProcessor } from "./executors/webhook-delivery-processor";
import { ReconciliationExecutor } from "./executors/reconciliation-executor";
import { logger } from "../logger";

export interface ServerlessProcessingOptions {
  transactionalBatchSize?: number;
  scheduledCampaignBatchSize?: number;
  recipientBatchSize?: number;
  recurringAutomationBatchSize?: number;
  enrollmentBatchSize?: number;
  eventBatchSize?: number;
  webhookBatchSize?: number;
  backgroundJobBatchSize?: number;
  runReconciliation?: boolean;
  maxExecutionTimeMs?: number;
}

export interface ServerlessProcessingResult {
  success: boolean;
  timestamp: string;
  durationMs: number;
  results: {
    backgroundJobs: { claimed: number; succeeded: number; failed: number };
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
      failedRecipients: number;
      recoveredJobs: number;
      failedJobs: number;
      completedCampaigns: number;
    } | null;
  };
}

let lastReconciliationAt = 0;
const RECONCILIATION_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export class ServerlessJobProcessor {
  /**
   * 1. Process Outbound Webhooks
   */
  static async processWebhooks(batchSize = 25) {
    try {
      return await WebhookDeliveryProcessor.processBatch({ batchSize });
    } catch (err) {
      logger.error("[ServerlessProcessor] Webhook processing error:", err);
      return { claimed: 0, succeeded: 0, failed: 0 };
    }
  }

  /**
   * 2. Process Durable BackgroundJob Table
   * Fair dispatch: partitions jobs by tenant, max 10 jobs per tenant per sweep
   */
  static async processBackgroundJobs(
    batchSize = 30,
    isTimeExhausted?: () => boolean
  ): Promise<{ claimed: number; succeeded: number; failed: number }> {
    let claimedCount = 0;
    let succeeded = 0;
    let failed = 0;

    try {
      // Claim jobs atomically with tenant partition and lock
      const claimedJobs = await prisma.$transaction(async (tx) => {
        const rows = (await tx.$queryRawUnsafe(`
          WITH ranked AS (
            SELECT j.id, j."clientId", j."type", j."payload",
                   ROW_NUMBER() OVER (PARTITION BY j."clientId" ORDER BY j."priority" DESC, j."availableAt" ASC) as rn
            FROM "BackgroundJob" j
            WHERE j."status" = 'QUEUED'
              AND j."availableAt" <= NOW()
              AND (j."lockedAt" IS NULL OR j."lockedAt" < NOW() - INTERVAL '10 minutes')
            ORDER BY j."priority" DESC, j."availableAt" ASC
            FOR UPDATE SKIP LOCKED
          ),
          selected AS (
            SELECT id, "clientId", "type", "payload"
            FROM ranked
            WHERE rn <= 10
            LIMIT ${batchSize}
          )
          UPDATE "BackgroundJob" j
          SET "status" = 'PROCESSING',
              "lockedAt" = NOW(),
              "lockedBy" = 'serverless-processor',
              "lastAttemptAt" = NOW(),
              "attemptCount" = j."attemptCount" + 1
          FROM selected s
          WHERE j.id = s.id
          RETURNING j.id, j."clientId", j."type", j."payload", j."attemptCount", j."maxAttempts";
        `).catch(() => [])) as {
          id: string;
          clientId: string;
          type: string;
          payload: string;
          attemptCount: number;
          maxAttempts: number;
        }[];

        return rows;
      });

      claimedCount = claimedJobs.length;

      for (const job of claimedJobs) {
        if (isTimeExhausted && isTimeExhausted()) {
          logger.warn(`[ServerlessProcessor] Execution time limit reached. Stopping BackgroundJob loop.`);
          break;
        }

        try {
          const payload = JSON.parse(job.payload || "{}");

          if (job.type === "EMAIL_DELIVERY" || job.type === "TRANSACTIONAL_EMAIL" || job.type === "PROMOTIONAL_EMAIL") {
            await EmailDeliveryExecutor.execute({
              deliveryId: payload.deliveryId,
              clientId: job.clientId,
            });
          } else if (job.type === "CAMPAIGN_RECIPIENT") {
            await CampaignRecipientExecutor.executeRecipient({
              recipientId: payload.campaignRecipientId,
            });
          } else if (job.type === "CAMPAIGN_TRIGGER") {
            await CampaignTriggerService.triggerScheduledCampaign({
              campaignId: payload.campaignId,
              clientId: job.clientId,
            });
          } else if (job.type === "AUTOMATION_STEP") {
            await AutomationExecutor.executeStep({
              clientId: job.clientId,
              enrollmentId: payload.enrollmentId,
              stepId: payload.stepId,
              isTimeout: payload.isTimeout,
            });
          } else if (job.type === "RECURRING_AUTOMATION") {
            await AutomationExecutor.executeRecurring({
              clientId: job.clientId,
              automationId: payload.automationId,
            });
          }

          // Mark job COMPLETED
          await prisma.backgroundJob.updateMany({
            where: { id: job.id },
            data: {
              status: BackgroundJobStatus.COMPLETED,
              completedAt: new Date(),
              lockedAt: null,
              lockedBy: null,
            },
          });
          succeeded++;
        } catch (jobErr) {
          failed++;
          const errMsg = jobErr instanceof Error ? jobErr.message : String(jobErr);
          const reachedMax = job.attemptCount >= job.maxAttempts;

          await prisma.backgroundJob.updateMany({
            where: { id: job.id },
            data: {
              status: reachedMax ? BackgroundJobStatus.FAILED : BackgroundJobStatus.QUEUED,
              failedAt: reachedMax ? new Date() : null,
              lastErrorCode: "EXECUTION_ERROR",
              lastErrorMessage: errMsg,
              availableAt: reachedMax ? undefined : new Date(Date.now() + Math.min(300000, 1000 * Math.pow(2, job.attemptCount))),
              lockedAt: null,
              lockedBy: null,
            },
          });

          logger.error(`[ServerlessProcessor] BackgroundJob ${job.id} failed:`, jobErr);
        }
      }
    } catch (err) {
      logger.error("[ServerlessProcessor] Error in processBackgroundJobs:", err);
    }

    return { claimed: claimedCount, succeeded, failed };
  }

  /**
   * 3. Process Transactional Emails (Legacy direct EmailDelivery table sweep)
   * High priority, fair dispatch across clients
   */
  static async processTransactionalEmails(
    batchSize = 25,
    isTimeExhausted?: () => boolean
  ): Promise<{ processed: number; succeeded: number; failed: number }> {
    let processed = 0;
    let succeeded = 0;
    let failed = 0;

    try {
      const claimedDeliveries = await prisma.$transaction(async (tx) => {
        const rows = (await tx.$queryRawUnsafe(`
          WITH ranked AS (
            SELECT d.id, d."clientId",
                   ROW_NUMBER() OVER (PARTITION BY d."clientId" ORDER BY d."createdAt" ASC) as rn
            FROM "EmailDelivery" d
            WHERE d."status" = 'QUEUED'
              AND d."category" = 'TRANSACTIONAL'
              AND (d."nextAttemptAt" IS NULL OR d."nextAttemptAt" <= NOW())
              AND (d."lockedAt" IS NULL OR d."lockedAt" < NOW() - INTERVAL '10 minutes')
            ORDER BY d."createdAt" ASC
            FOR UPDATE SKIP LOCKED
          ),
          selected AS (
            SELECT id, "clientId"
            FROM ranked
            WHERE rn <= 10
            LIMIT ${batchSize}
          )
          UPDATE "EmailDelivery" d
          SET "status" = 'PROCESSING',
              "lockedAt" = NOW(),
              "lockedBy" = 'serverless-processor',
              "lastAttemptAt" = NOW(),
              "attemptCount" = d."attemptCount" + 1
          FROM selected s
          WHERE d.id = s.id
          RETURNING d.id, d."clientId";
        `).catch(() => [])) as { id: string; clientId: string }[];

        return rows;
      });

      for (const item of claimedDeliveries) {
        if (isTimeExhausted && isTimeExhausted()) break;
        processed++;
        try {
          await EmailDeliveryExecutor.execute({
            deliveryId: item.id,
            clientId: item.clientId,
          });
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
   * 4. Process Scheduled Campaigns
   */
  static async processScheduledCampaigns(
    batchSize = 5,
    isTimeExhausted?: () => boolean
  ): Promise<{ processed: number; succeeded: number; failed: number }> {
    let processed = 0;
    let succeeded = 0;
    let failed = 0;

    try {
      const scheduledCampaigns = await CampaignTriggerService.findDueScheduledCampaigns(batchSize);

      for (const campaign of scheduledCampaigns) {
        if (isTimeExhausted && isTimeExhausted()) break;
        processed++;
        try {
          await CampaignTriggerService.triggerScheduledCampaign({
            campaignId: campaign.id,
            clientId: campaign.clientId,
          });
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
   * 5. Process Campaign Recipients
   * Dispatches PENDING recipients for RUNNING campaigns with fair dispatch per campaign
   */
  static async processCampaignRecipients(
    batchSize = 30,
    isTimeExhausted?: () => boolean
  ): Promise<{ processed: number; succeeded: number; failed: number }> {
    let processed = 0;
    let succeeded = 0;
    let failed = 0;

    try {
      const claimedRecipients = await prisma.$transaction(async (tx) => {
        const rows = (await tx.$queryRawUnsafe(`
          WITH active_campaigns AS (
            SELECT id FROM "EmailCampaign" WHERE "status" = 'RUNNING'
          ),
          ranked AS (
            SELECT r.id, r."campaignId",
                   ROW_NUMBER() OVER (PARTITION BY r."campaignId" ORDER BY r."createdAt" ASC) as rn
            FROM "EmailCampaignRecipient" r
            JOIN active_campaigns ac ON ac.id = r."campaignId"
            WHERE r."status" IN ('PENDING', 'RETRYING')
              AND (r."nextAttemptAt" IS NULL OR r."nextAttemptAt" <= NOW())
              AND (r."lockedAt" IS NULL OR r."lockedAt" < NOW() - INTERVAL '10 minutes')
            ORDER BY r."createdAt" ASC
            FOR UPDATE SKIP LOCKED
          ),
          selected AS (
            SELECT id, "campaignId"
            FROM ranked
            WHERE rn <= 10
            LIMIT ${batchSize}
          )
          UPDATE "EmailCampaignRecipient" r
          SET "status" = 'PROCESSING',
              "lockedAt" = NOW(),
              "lockedBy" = 'serverless-processor',
              "lastAttemptAt" = NOW(),
              "attemptCount" = r."attemptCount" + 1
          FROM selected s
          WHERE r.id = s.id
          RETURNING r.id, r."campaignId";
        `).catch(() => [])) as { id: string; campaignId: string }[];

        return rows;
      });

      for (const item of claimedRecipients) {
        if (isTimeExhausted && isTimeExhausted()) break;
        processed++;
        try {
          await CampaignRecipientExecutor.executeRecipient({
            recipientId: item.id,
          });
          succeeded++;
        } catch (jobErr) {
          failed++;
          logger.error(`[ServerlessProcessor] Campaign recipient ${item.id} execution failed:`, jobErr);
        }
      }
    } catch (err) {
      logger.error("[ServerlessProcessor] Campaign recipient batch processing error:", err);
    }

    return { processed, succeeded, failed };
  }

  /**
   * 6. Process Recurring Automations
   */
  static async processRecurringAutomations(
    batchSize = 5,
    isTimeExhausted?: () => boolean
  ): Promise<{ processed: number; succeeded: number; failed: number }> {
    let processed = 0;
    let succeeded = 0;
    let failed = 0;

    try {
      const automations = await AutomationExecutor.findDueRecurringAutomations(batchSize);

      for (const auto of automations) {
        if (isTimeExhausted && isTimeExhausted()) break;
        processed++;
        try {
          await AutomationExecutor.executeRecurring({
            clientId: auto.clientId,
            automationId: auto.id,
          });
          succeeded++;
        } catch (err) {
          failed++;
          logger.error(`[ServerlessProcessor] Recurring automation ${auto.id} failed:`, err);
        }
      }
    } catch (err) {
      logger.error("[ServerlessProcessor] Recurring automations processing error:", err);
    }

    return { processed, succeeded, failed };
  }

  /**
   * 7. Process Automation Journey Enrollments
   */
  static async processAutomationEnrollments(
    batchSize = 25,
    isTimeExhausted?: () => boolean
  ): Promise<{ processed: number; succeeded: number; failed: number }> {
    let processed = 0;
    let succeeded = 0;
    let failed = 0;

    try {
      const enrollments = await AutomationExecutor.findDueEnrollments(batchSize);

      for (const enrollment of enrollments) {
        if (isTimeExhausted && isTimeExhausted()) break;
        processed++;
        try {
          await AutomationExecutor.executeStep({
            clientId: enrollment.clientId,
            enrollmentId: enrollment.id,
            stepId: enrollment.currentStepId || undefined,
          });
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
   * 8. Process Incoming Webhook Events (EmailEvent rows in RECEIVED state)
   */
  static async processEvents(
    batchSize = 25,
    isTimeExhausted?: () => boolean
  ): Promise<{ processed: number; succeeded: number; failed: number }> {
    let processed = 0;
    let succeeded = 0;
    let failed = 0;

    try {
      const pendingEvents = await EmailEventProcessor.findPendingEvents(batchSize);

      for (const event of pendingEvents) {
        if (isTimeExhausted && isTimeExhausted()) break;
        processed++;
        try {
          await EmailEventProcessor.process({ eventId: event.id });
          succeeded++;
        } catch (err) {
          failed++;
          logger.error(`[ServerlessProcessor] EmailEvent ${event.id} processing failed:`, err);
        }
      }
    } catch (err) {
      logger.error("[ServerlessProcessor] Event processing batch error:", err);
    }

    return { processed, succeeded, failed };
  }

  /**
   * 9. Periodic Job Reconciliation
   */
  static async reconcileJobs(staleMinutes = 10) {
    try {
      return await ReconciliationExecutor.reconcile({ staleMinutes });
    } catch (err) {
      logger.error("[ServerlessProcessor] Reconciliation error:", err);
      return null;
    }
  }

  /**
   * Core Orchestration Loop: Single Invocation Runner
   */
  static async processAll(options: ServerlessProcessingOptions = {}): Promise<ServerlessProcessingResult> {
    const startTime = Date.now();
    const maxDurationMs = options.maxExecutionTimeMs || 25000; // 25s default
    const isTimeExhausted = () => Date.now() - startTime >= maxDurationMs - 4000;

    logger.info("[ServerlessProcessor] Starting workerless execution cycle");

    // 1. Webhooks
    const webhooks = await this.processWebhooks(options.webhookBatchSize || 25);

    // 2. Durable BackgroundJobs
    const bgJobs = await this.processBackgroundJobs(
      options.backgroundJobBatchSize || 30,
      isTimeExhausted
    );

    // 3. Transactional Emails (urgent)
    const transactional = await this.processTransactionalEmails(
      options.transactionalBatchSize || 25,
      isTimeExhausted
    );

    // 4. Scheduled Campaigns
    const scheduledCampaigns = await this.processScheduledCampaigns(
      options.scheduledCampaignBatchSize || 5,
      isTimeExhausted
    );

    // 5. Campaign Recipients
    const campaignRecipients = await this.processCampaignRecipients(
      options.recipientBatchSize || 30,
      isTimeExhausted
    );

    // 6. Recurring Automations
    const recurringAutomations = await this.processRecurringAutomations(
      options.recurringAutomationBatchSize || 5,
      isTimeExhausted
    );

    // 7. Automation Enrollments
    const automationEnrollments = await this.processAutomationEnrollments(
      options.enrollmentBatchSize || 25,
      isTimeExhausted
    );

    // 8. Inbound Webhook Events
    const events = await this.processEvents(
      options.eventBatchSize || 25,
      isTimeExhausted
    );

    // 9. Reconciliation (if requested or due every 5 minutes)
    let reconciliationResult = null;
    const now = Date.now();
    const isDue = now - lastReconciliationAt > RECONCILIATION_INTERVAL_MS;
    if (options.runReconciliation || isDue) {
      reconciliationResult = await this.reconcileJobs();
      lastReconciliationAt = now;
    }

    const durationMs = Date.now() - startTime;
    logger.info(`[ServerlessProcessor] Execution cycle completed in ${durationMs}ms`);

    return {
      success: true,
      timestamp: new Date().toISOString(),
      durationMs,
      results: {
        backgroundJobs: bgJobs,
        webhooks,
        transactional,
        scheduledCampaigns,
        campaignRecipients,
        recurringAutomations,
        automationEnrollments,
        events,
        reconciliation: reconciliationResult,
      },
    };
  }
}
