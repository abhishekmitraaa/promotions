/**
 * Serverless Job Processor Service
 *
 * Implements durable, fair-dispatch, workerless background processing:
 * - Triggered periodically via Supabase Cron (pg_cron) -> pg_net HTTP POST
 * - Executes in bounded serverless function execution window with 4s safety buffer
 * - Concurrency control via PostgreSQL SELECT ... FOR UPDATE SKIP LOCKED
 * - Tenant Fair Dispatch: partitions queues by tenant (clientId) to prevent starvation
 * - Category Priority: TRANSACTIONAL is always dispatched before PROMOTIONAL
 * - Neutral Domain Executors: zero BullMQ coupling or fake Job wrappers
 * - Safe claim release on approaching execution deadline
 */

import { prisma } from "../prisma";
import {
  EmailDeliveryStatus,
  BackgroundJobStatus,
  Prisma,
} from "@prisma/client";
import { EmailDeliveryExecutor } from "./executors/email-delivery-executor";
import { CampaignRecipientExecutor } from "./executors/campaign-recipient-executor";
import { CampaignTriggerService } from "./executors/campaign-trigger-service";
import { AutomationExecutor } from "./executors/automation-executor";
import { EmailEventProcessor } from "./executors/email-event-processor";
import { WebhookDeliveryProcessor } from "./executors/webhook-delivery-processor";
import { ReconciliationExecutor, ReconciliationReport } from "./executors/reconciliation-executor";
import { PermanentError } from "../errors/job-errors";
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
  timingBreakdownMs?: {
    webhooks: number;
    backgroundJobs: number;
    transactional: number;
    scheduledCampaigns: number;
    campaignRecipients: number;
    recurringAutomations: number;
    automationEnrollments: number;
    events: number;
    reconciliation?: number;
  };
  errors?: string[];
  results: {
    backgroundJobs: { claimed: number; succeeded: number; failed: number; durationMs?: number; error?: string };
    webhooks: { claimed: number; succeeded: number; failed: number; durationMs?: number; error?: string };
    transactional: { processed: number; succeeded: number; failed: number; durationMs?: number; error?: string };
    scheduledCampaigns: { processed: number; succeeded: number; failed: number; durationMs?: number; error?: string };
    campaignRecipients: { processed: number; succeeded: number; failed: number; durationMs?: number; error?: string };
    recurringAutomations: { processed: number; succeeded: number; failed: number; durationMs?: number; error?: string };
    automationEnrollments: { processed: number; succeeded: number; failed: number; durationMs?: number; error?: string };
    events: { processed: number; succeeded: number; failed: number; durationMs?: number; error?: string };
    reconciliation: {
      recoveredDeliveries: number;
      failedDeliveries: number;
      recoveredRecipients: number;
      failedRecipients: number;
      recoveredJobs: number;
      failedJobs: number;
      completedCampaigns: number;
      durationMs?: number;
      error?: string;
    } | null;
  };
}

export class ServerlessJobProcessor {
  /**
   * 1. Process Outbound Webhooks
   */
  static async processWebhooks(
    batchSize = 25,
    isTimeExhausted?: () => boolean
  ): Promise<{ claimed: number; succeeded: number; failed: number; durationMs?: number; error?: string }> {
    const startTime = Date.now();
    try {
      const safeSize = Math.min(50, Math.max(1, batchSize));
      const result = await WebhookDeliveryProcessor.processBatch({
        batchSize: safeSize,
        isTimeExhausted,
      });
      return { ...result, durationMs: Date.now() - startTime };
    } catch (err) {
      logger.error("[ServerlessProcessor] Webhook processing error:", err);
      return {
        claimed: 0,
        succeeded: 0,
        failed: 0,
        durationMs: Date.now() - startTime,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * 2. Process Durable BackgroundJob Table
   * Fair dispatch: partitions jobs by tenant, max 10 jobs per tenant per sweep
   */
  static async processBackgroundJobs(
    batchSize = 30,
    isTimeExhausted?: () => boolean
  ): Promise<{ claimed: number; succeeded: number; failed: number; durationMs?: number; error?: string }> {
    const startTime = Date.now();
    let claimedCount = 0;
    let succeeded = 0;
    let failed = 0;
    let claimError: string | undefined;

    const safeBatchSize = Math.min(100, Math.max(1, batchSize));
    const lockedBy = `serverless-processor-${Date.now()}`;

    if (isTimeExhausted && isTimeExhausted()) {
      return { claimed: 0, succeeded: 0, failed: 0, durationMs: Date.now() - startTime };
    }

    let claimedJobs: Array<{
      id: string;
      clientId: string;
      type: string;
      payload: string;
      attemptCount: number;
      maxAttempts: number;
    }> = [];

    try {
      claimedJobs = await prisma.$queryRaw<Array<{
        id: string;
        clientId: string;
        type: string;
        payload: string;
        attemptCount: number;
        maxAttempts: number;
      }>>(Prisma.sql`
        WITH candidates AS (
          SELECT id, "clientId"
          FROM "BackgroundJob"
          WHERE "status" = 'QUEUED'
            AND "availableAt" <= NOW()
            AND ("lockedAt" IS NULL OR "lockedAt" < NOW() - INTERVAL '10 minutes')
          ORDER BY "priority" DESC, "availableAt" ASC
          LIMIT 50
          FOR UPDATE SKIP LOCKED
        ),
        ranked AS (
          SELECT id, ROW_NUMBER() OVER (PARTITION BY "clientId" ORDER BY id) as rn
          FROM candidates
        ),
        selected AS (
          SELECT id
          FROM ranked
          WHERE rn <= 10
          LIMIT ${safeBatchSize}
        )
        UPDATE "BackgroundJob" j
        SET "status" = 'PROCESSING',
            "lockedAt" = NOW(),
            "lockedBy" = ${lockedBy},
            "lastAttemptAt" = NOW(),
            "attemptCount" = j."attemptCount" + 1
        FROM selected s
        WHERE j.id = s.id
        RETURNING j.id, j."clientId", j."type", j."payload", j."attemptCount", j."maxAttempts"
      `);

      claimedCount = claimedJobs.length;

      for (let i = 0; i < claimedJobs.length; i++) {
        const job = claimedJobs[i];

        if (isTimeExhausted && isTimeExhausted()) {
          logger.warn(`[ServerlessProcessor] Approaching execution deadline. Releasing remaining ${claimedJobs.length - i} claimed jobs.`);
          const unstartedIds = claimedJobs.slice(i).map((u) => u.id);
          if (unstartedIds.length > 0) {
            await prisma.backgroundJob.updateMany({
              where: { id: { in: unstartedIds } },
              data: {
                status: BackgroundJobStatus.QUEUED,
                lockedAt: null,
                lockedBy: null,
                attemptCount: { decrement: 1 },
              },
            });
          }
          break;
        }

        try {
          let payload: Record<string, unknown> = {};
          try {
            payload = JSON.parse(job.payload || "{}");
          } catch {
            throw new PermanentError(`Malformed JSON payload in BackgroundJob '${job.id}'`);
          }

          let yieldContention = false;

          if (
            job.type === "EMAIL_DELIVERY" ||
            job.type === "TRANSACTIONAL_EMAIL" ||
            job.type === "PROMOTIONAL_EMAIL"
          ) {
            const deliveryId = (payload.deliveryId as string) || job.id;
            const execResult = await EmailDeliveryExecutor.execute({
              deliveryId,
              clientId: job.clientId,
            });
            if (execResult.skipped && execResult.reason === "CONTENTION_LOCK_HELD") {
              yieldContention = true;
            }
          } else if (job.type === "CAMPAIGN_RECIPIENT") {
            const recipientId = (payload.campaignRecipientId as string) || (payload.recipientId as string);
            if (!recipientId) throw new PermanentError("Missing campaignRecipientId in payload");
            const execResult = await CampaignRecipientExecutor.executeRecipient({
              recipientId,
            });
            if (execResult.skipped && execResult.reason === "CONTENTION_LOCK_HELD") {
              yieldContention = true;
            }
          } else if (job.type === "CAMPAIGN_TRIGGER") {
            const campaignId = (payload.campaignId as string);
            if (!campaignId) throw new PermanentError("Missing campaignId in payload");
            await CampaignTriggerService.triggerScheduledCampaign({
              campaignId,
              clientId: job.clientId,
            });
          } else if (job.type === "AUTOMATION_STEP") {
            const enrollmentId = (payload.enrollmentId as string);
            if (!enrollmentId) throw new PermanentError("Missing enrollmentId in payload");
            await AutomationExecutor.executeStep({
              clientId: job.clientId,
              enrollmentId,
              stepId: (payload.stepId as string) || undefined,
              isTimeout: Boolean(payload.isTimeout),
            });
          } else if (job.type === "RECURRING_AUTOMATION") {
            const automationId = (payload.automationId as string);
            if (!automationId) throw new PermanentError("Missing automationId in payload");
            await AutomationExecutor.executeRecurring({
              clientId: job.clientId,
              automationId,
            });
          } else if (job.type === "EMAIL_EVENT") {
            const eventId = (payload.eventId as string) || (payload.eventRecordId as string);
            if (!eventId) throw new PermanentError("Missing eventId in payload");
            const execResult = await EmailEventProcessor.process({ eventId });
            if (execResult && typeof execResult === "object" && "reason" in execResult && execResult.reason === "CONTENTION_LOCK_HELD") {
              yieldContention = true;
            }
          } else {
            throw new PermanentError(`Unrecognized job type '${job.type}' in BackgroundJob '${job.id}'`);
          }

          if (yieldContention) {
            logger.info(
              `[ServerlessProcessor] BackgroundJob ${job.id} yielded due to contention lock on authoritative work item.`
            );
            await prisma.backgroundJob.updateMany({
              where: { id: job.id, status: BackgroundJobStatus.PROCESSING },
              data: {
                status: BackgroundJobStatus.QUEUED,
                availableAt: new Date(Date.now() + 5000),
                lockedAt: null,
                lockedBy: null,
              },
            });
            continue;
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
          const isPermanent = jobErr instanceof PermanentError;
          const shouldFail = reachedMax || isPermanent;

          const jitterMs = Math.floor(Math.random() * 500);
          const backoffDelay = Math.min(300000, 1000 * Math.pow(2, job.attemptCount) + jitterMs);

          await prisma.backgroundJob.updateMany({
            where: { id: job.id },
            data: {
              status: shouldFail ? BackgroundJobStatus.FAILED : BackgroundJobStatus.QUEUED,
              failedAt: shouldFail ? new Date() : null,
              lastErrorCode: isPermanent ? "PERMANENT_ERROR" : (reachedMax ? "MAX_ATTEMPTS_EXCEEDED" : "EXECUTION_ERROR"),
              lastErrorMessage: errMsg,
              availableAt: shouldFail ? undefined : new Date(Date.now() + backoffDelay),
              lockedAt: null,
              lockedBy: null,
            },
          });

          logger.error(`[ServerlessProcessor] BackgroundJob ${job.id} failed:`, jobErr);
        }
      }
    } catch (err) {
      claimError = err instanceof Error ? err.message : String(err);
      logger.error("[ServerlessProcessor] Error in processBackgroundJobs:", err);
    }

    return {
      claimed: claimedCount,
      succeeded,
      failed,
      durationMs: Date.now() - startTime,
      ...(claimError ? { error: claimError } : {}),
    };
  }

  /**
   * 3. Process Transactional Emails (Legacy direct EmailDelivery table sweep)
   * High priority, fair dispatch across clients
   */
  static async processTransactionalEmails(
    batchSize = 25,
    isTimeExhausted?: () => boolean
  ): Promise<{ processed: number; succeeded: number; failed: number; durationMs?: number; error?: string }> {
    const startTime = Date.now();
    let processed = 0;
    let succeeded = 0;
    let failed = 0;
    let claimError: string | undefined;

    const safeBatchSize = Math.min(50, Math.max(1, batchSize));
    const lockedBy = `serverless-processor-${Date.now()}`;

    if (isTimeExhausted && isTimeExhausted()) {
      return { processed: 0, succeeded: 0, failed: 0, durationMs: Date.now() - startTime };
    }

    try {
      const claimedDeliveries = await prisma.$queryRaw<Array<{ id: string; clientId: string }>>(Prisma.sql`
        WITH candidates AS (
          SELECT d.id, d."clientId"
          FROM "EmailDelivery" d
          WHERE d."status" = 'QUEUED'
            AND d."category" = 'TRANSACTIONAL'
            AND (d."nextAttemptAt" IS NULL OR d."nextAttemptAt" <= NOW())
            AND (d."lockedAt" IS NULL OR d."lockedAt" < NOW() - INTERVAL '10 minutes')
          ORDER BY d."createdAt" ASC
          LIMIT 50
          FOR UPDATE SKIP LOCKED
        ),
        ranked AS (
          SELECT id, ROW_NUMBER() OVER (PARTITION BY "clientId" ORDER BY id) as rn
          FROM candidates
        ),
        selected AS (
          SELECT id
          FROM ranked
          WHERE rn <= 10
          LIMIT ${safeBatchSize}
        )
        UPDATE "EmailDelivery" d
        SET "status" = 'PROCESSING',
            "lockedAt" = NOW(),
            "lockedBy" = ${lockedBy},
            "lastAttemptAt" = NOW(),
            "attemptCount" = d."attemptCount" + 1
        FROM selected s
        WHERE d.id = s.id
        RETURNING d.id, d."clientId"
      `);

      for (let i = 0; i < claimedDeliveries.length; i++) {
        const item = claimedDeliveries[i];

        if (isTimeExhausted && isTimeExhausted()) {
          const unstarted = claimedDeliveries.slice(i).map((u) => u.id);
          if (unstarted.length > 0) {
            await prisma.emailDelivery.updateMany({
              where: { id: { in: unstarted } },
              data: {
                status: EmailDeliveryStatus.QUEUED,
                lockedAt: null,
                lockedBy: null,
                attemptCount: { decrement: 1 },
              },
            });
          }
          break;
        }

        processed++;
        try {
          await EmailDeliveryExecutor.execute({
            deliveryId: item.id,
            clientId: item.clientId,
            claimToken: lockedBy,
          });
          succeeded++;
        } catch (jobErr) {
          failed++;
          logger.error(`[ServerlessProcessor] Transactional email ${item.id} execution failed:`, jobErr);
        }
      }
    } catch (err) {
      claimError = err instanceof Error ? err.message : String(err);
      logger.error("[ServerlessProcessor] Transactional processing batch error:", err);
    }

    return {
      processed,
      succeeded,
      failed,
      durationMs: Date.now() - startTime,
      ...(claimError ? { error: claimError } : {}),
    };
  }

  /**
   * 4. Process Scheduled Campaigns
   */
  static async processScheduledCampaigns(
    batchSize = 5,
    isTimeExhausted?: () => boolean
  ): Promise<{ processed: number; succeeded: number; failed: number; durationMs?: number; error?: string }> {
    const startTime = Date.now();
    let processed = 0;
    let succeeded = 0;
    let failed = 0;
    let batchError: string | undefined;

    if (isTimeExhausted && isTimeExhausted()) {
      return { processed: 0, succeeded: 0, failed: 0, durationMs: Date.now() - startTime };
    }

    try {
      const safeBatchSize = Math.min(20, Math.max(1, batchSize));
      const scheduledCampaigns = await CampaignTriggerService.findDueScheduledCampaigns(safeBatchSize);

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
      batchError = err instanceof Error ? err.message : String(err);
      logger.error("[ServerlessProcessor] Scheduled campaign processing error:", err);
    }

    return {
      processed,
      succeeded,
      failed,
      durationMs: Date.now() - startTime,
      ...(batchError ? { error: batchError } : {}),
    };
  }

  /**
   * 5. Process Campaign Recipients
   * Dispatches PENDING recipients for RUNNING campaigns with fair dispatch per campaign
   */
  static async processCampaignRecipients(
    batchSize = 30,
    isTimeExhausted?: () => boolean
  ): Promise<{ processed: number; succeeded: number; failed: number; durationMs?: number; error?: string }> {
    const startTime = Date.now();
    let processed = 0;
    let succeeded = 0;
    let failed = 0;
    let claimError: string | undefined;

    const safeBatchSize = Math.min(100, Math.max(1, batchSize));
    const lockedBy = `serverless-processor-${Date.now()}`;

    if (isTimeExhausted && isTimeExhausted()) {
      return { processed: 0, succeeded: 0, failed: 0, durationMs: Date.now() - startTime };
    }

    try {
      const claimedRecipients = await prisma.$queryRaw<Array<{ id: string; campaignId: string }>>(Prisma.sql`
        WITH active_campaigns AS (
          SELECT id FROM "EmailCampaign" WHERE "status" = 'RUNNING'
        ),
        candidates AS (
          SELECT r.id, r."campaignId"
          FROM "EmailCampaignRecipient" r
          JOIN active_campaigns ac ON ac.id = r."campaignId"
          WHERE r."status" IN ('PENDING', 'RETRYING')
            AND (r."nextAttemptAt" IS NULL OR r."nextAttemptAt" <= NOW())
            AND (r."lockedAt" IS NULL OR r."lockedAt" < NOW() - INTERVAL '10 minutes')
          ORDER BY r."createdAt" ASC
          LIMIT 50
          FOR UPDATE SKIP LOCKED
        ),
        ranked AS (
          SELECT id, ROW_NUMBER() OVER (PARTITION BY "campaignId" ORDER BY id) as rn
          FROM candidates
        ),
        selected AS (
          SELECT id
          FROM ranked
          WHERE rn <= 10
          LIMIT ${safeBatchSize}
        )
        UPDATE "EmailCampaignRecipient" r
        SET "status" = 'PROCESSING',
            "lockedAt" = NOW(),
            "lockedBy" = ${lockedBy},
            "lastAttemptAt" = NOW(),
            "attemptCount" = r."attemptCount" + 1
        FROM selected s
        WHERE r.id = s.id
        RETURNING r.id, r."campaignId"
      `);

      for (let i = 0; i < claimedRecipients.length; i++) {
        const item = claimedRecipients[i];

        if (isTimeExhausted && isTimeExhausted()) {
          const unstarted = claimedRecipients.slice(i).map((u) => u.id);
          if (unstarted.length > 0) {
            await prisma.emailCampaignRecipient.updateMany({
              where: { id: { in: unstarted } },
              data: {
                status: "PENDING",
                lockedAt: null,
                lockedBy: null,
                attemptCount: { decrement: 1 },
              },
            });
          }
          break;
        }

        processed++;
        try {
          await CampaignRecipientExecutor.executeRecipient({
            recipientId: item.id,
            claimToken: lockedBy,
          });
          succeeded++;
        } catch (jobErr) {
          failed++;
          logger.error(`[ServerlessProcessor] Campaign recipient ${item.id} execution failed:`, jobErr);
        }
      }
    } catch (err) {
      claimError = err instanceof Error ? err.message : String(err);
      logger.error("[ServerlessProcessor] Campaign recipient batch processing error:", err);
    }

    return {
      processed,
      succeeded,
      failed,
      durationMs: Date.now() - startTime,
      ...(claimError ? { error: claimError } : {}),
    };
  }

  /**
   * 6. Process Recurring Automations
   */
  static async processRecurringAutomations(
    batchSize = 5,
    isTimeExhausted?: () => boolean
  ): Promise<{ processed: number; succeeded: number; failed: number; durationMs?: number; error?: string }> {
    const startTime = Date.now();
    let processed = 0;
    let succeeded = 0;
    let failed = 0;
    let batchError: string | undefined;

    if (isTimeExhausted && isTimeExhausted()) {
      return { processed: 0, succeeded: 0, failed: 0, durationMs: Date.now() - startTime };
    }

    try {
      const safeBatchSize = Math.min(20, Math.max(1, batchSize));
      const automations = await AutomationExecutor.findDueRecurringAutomations(safeBatchSize);

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
      batchError = err instanceof Error ? err.message : String(err);
      logger.error("[ServerlessProcessor] Recurring automations processing error:", err);
    }

    return {
      processed,
      succeeded,
      failed,
      durationMs: Date.now() - startTime,
      ...(batchError ? { error: batchError } : {}),
    };
  }

  /**
   * 7. Process Automation Journey Enrollments
   */
  static async processAutomationEnrollments(
    batchSize = 25,
    isTimeExhausted?: () => boolean
  ): Promise<{ processed: number; succeeded: number; failed: number; durationMs?: number; error?: string }> {
    const startTime = Date.now();
    let processed = 0;
    let succeeded = 0;
    let failed = 0;
    let batchError: string | undefined;

    if (isTimeExhausted && isTimeExhausted()) {
      return { processed: 0, succeeded: 0, failed: 0, durationMs: Date.now() - startTime };
    }

    try {
      const safeBatchSize = Math.min(50, Math.max(1, batchSize));
      const enrollments = await AutomationExecutor.findDueEnrollments(safeBatchSize);

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
      batchError = err instanceof Error ? err.message : String(err);
      logger.error("[ServerlessProcessor] Automation enrollment processing error:", err);
    }

    return {
      processed,
      succeeded,
      failed,
      durationMs: Date.now() - startTime,
      ...(batchError ? { error: batchError } : {}),
    };
  }

  /**
   * 8. Process Incoming Webhook Events (EmailEvent rows in RECEIVED state)
   */
  static async processEvents(
    batchSize = 25,
    isTimeExhausted?: () => boolean
  ): Promise<{ processed: number; succeeded: number; failed: number; durationMs?: number; error?: string }> {
    const startTime = Date.now();
    let processed = 0;
    let succeeded = 0;
    let failed = 0;
    let batchError: string | undefined;

    if (isTimeExhausted && isTimeExhausted()) {
      return { processed: 0, succeeded: 0, failed: 0, durationMs: Date.now() - startTime };
    }

    try {
      const safeBatchSize = Math.min(50, Math.max(1, batchSize));
      const pendingEvents = await EmailEventProcessor.findPendingEvents(safeBatchSize);

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
      batchError = err instanceof Error ? err.message : String(err);
      logger.error("[ServerlessProcessor] Event processing batch error:", err);
    }

    return {
      processed,
      succeeded,
      failed,
      durationMs: Date.now() - startTime,
      ...(batchError ? { error: batchError } : {}),
    };
  }

  static async processEmailEvents(
    batchSize = 25,
    isTimeExhausted?: () => boolean
  ): Promise<{ processed: number; succeeded: number; failed: number; durationMs?: number }> {
    return this.processEvents(batchSize, isTimeExhausted);
  }

  /**
   * 9. Job Reconciliation
   */
  static async reconcileJobs(staleMinutes = 10, isTimeExhausted?: () => boolean): Promise<ReconciliationReport | null> {
    if (isTimeExhausted && isTimeExhausted()) {
      return null;
    }
    const startTime = Date.now();
    try {
      return await ReconciliationExecutor.reconcile({ staleMinutes, isTimeExhausted });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error("[ServerlessProcessor] Reconciliation error:", err);
      return {
        recoveredDeliveries: 0,
        failedDeliveries: 0,
        recoveredRecipients: 0,
        failedRecipients: 0,
        recoveredJobs: 0,
        failedJobs: 0,
        completedCampaigns: 0,
        durationMs: Date.now() - startTime,
        error: errMsg,
      };
    }
  }

  /**
   * Core Orchestration Loop: Single Invocation Runner
   */
  static async processAll(options: ServerlessProcessingOptions = {}): Promise<ServerlessProcessingResult> {
    const startTime = Date.now();
    const maxDurationMs =
      options.maxExecutionTimeMs || (options.runReconciliation ? 35000 : 25000);
    const safetyBufferMs = Math.min(5000, Math.max(1000, Math.floor(maxDurationMs * 0.2)));
    const isTimeExhausted = () => Date.now() - startTime >= maxDurationMs - safetyBufferMs;

    logger.info(
      `[ServerlessProcessor] Starting workerless execution cycle (budget: ${maxDurationMs}ms, safetyBuffer: ${safetyBufferMs}ms)`
    );

    // Stage 1: Primary Workloads (Webhooks & BackgroundJobs - completely disjoint tables)
    const [webhooks, bgJobs] = await Promise.all([
      this.processWebhooks(options.webhookBatchSize || 25, isTimeExhausted),
      this.processBackgroundJobs(options.backgroundJobBatchSize || 30, isTimeExhausted),
    ]);

    type CategoryResult = {
      processed: number;
      succeeded: number;
      failed: number;
      durationMs?: number;
      error?: string;
    };

    // Stage 2: Scheduled Triggers (Campaigns & Recurring Automations - completely disjoint tables)
    let scheduledCampaigns: CategoryResult = { processed: 0, succeeded: 0, failed: 0, durationMs: 0 };
    let recurringAutomations: CategoryResult = { processed: 0, succeeded: 0, failed: 0, durationMs: 0 };

    if (!isTimeExhausted()) {
      [scheduledCampaigns, recurringAutomations] = await Promise.all([
        this.processScheduledCampaigns(options.scheduledCampaignBatchSize || 5, isTimeExhausted),
        this.processRecurringAutomations(options.recurringAutomationBatchSize || 5, isTimeExhausted),
      ]);
    } else {
      logger.warn("[ServerlessProcessor] Time budget exhausted before scheduled triggers stage");
    }

    // Stage 3: Event & Journey Step Sweeps (EmailEvent & AutomationEnrollment - disjoint tables)
    let events: CategoryResult = { processed: 0, succeeded: 0, failed: 0, durationMs: 0 };
    let automationEnrollments: CategoryResult = { processed: 0, succeeded: 0, failed: 0, durationMs: 0 };

    if (!isTimeExhausted()) {
      [events, automationEnrollments] = await Promise.all([
        this.processEvents(options.eventBatchSize || 25, isTimeExhausted),
        this.processAutomationEnrollments(options.enrollmentBatchSize || 25, isTimeExhausted),
      ]);
    } else {
      logger.warn("[ServerlessProcessor] Time budget exhausted before events/enrollments stage");
    }

    // Stage 4: Legacy Fallback Sweeps (EmailDelivery & CampaignRecipient - disjoint tables)
    let transactional: CategoryResult = { processed: 0, succeeded: 0, failed: 0, durationMs: 0 };
    let campaignRecipients: CategoryResult = { processed: 0, succeeded: 0, failed: 0, durationMs: 0 };

    if (!isTimeExhausted()) {
      [transactional, campaignRecipients] = await Promise.all([
        this.processTransactionalEmails(options.transactionalBatchSize || 25, isTimeExhausted),
        this.processCampaignRecipients(options.recipientBatchSize || 30, isTimeExhausted),
      ]);
    } else {
      logger.warn("[ServerlessProcessor] Time budget exhausted before fallback delivery/recipient sweeps");
    }

    // Stage 5: Reconciliation: only executed when explicitly requested (e.g. via separate 5-minute cron)
    let reconciliationResult: ReconciliationReport | null = null;
    if (options.runReconciliation && !isTimeExhausted()) {
      reconciliationResult = await this.reconcileJobs(10, isTimeExhausted);
    }

    const durationMs = Date.now() - startTime;
    logger.info(`[ServerlessProcessor] Execution cycle completed in ${durationMs}ms`);

    const errors: string[] = [];
    if (webhooks.error) errors.push(`webhooks: ${webhooks.error}`);
    if (bgJobs.error) errors.push(`backgroundJobs: ${bgJobs.error}`);
    if (transactional.error) errors.push(`transactional: ${transactional.error}`);
    if (scheduledCampaigns.error) errors.push(`scheduledCampaigns: ${scheduledCampaigns.error}`);
    if (campaignRecipients.error) errors.push(`campaignRecipients: ${campaignRecipients.error}`);
    if (recurringAutomations.error) errors.push(`recurringAutomations: ${recurringAutomations.error}`);
    if (automationEnrollments.error) errors.push(`automationEnrollments: ${automationEnrollments.error}`);
    if (events.error) errors.push(`events: ${events.error}`);
    if (reconciliationResult?.error) errors.push(`reconciliation: ${reconciliationResult.error}`);

    const timingBreakdownMs = {
      webhooks: webhooks.durationMs || 0,
      backgroundJobs: bgJobs.durationMs || 0,
      transactional: transactional.durationMs || 0,
      scheduledCampaigns: scheduledCampaigns.durationMs || 0,
      campaignRecipients: campaignRecipients.durationMs || 0,
      recurringAutomations: recurringAutomations.durationMs || 0,
      automationEnrollments: automationEnrollments.durationMs || 0,
      events: events.durationMs || 0,
      reconciliation: reconciliationResult?.durationMs || 0,
    };

    return {
      success: errors.length === 0,
      timestamp: new Date().toISOString(),
      durationMs,
      timingBreakdownMs,
      ...(errors.length > 0 ? { errors } : {}),
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
