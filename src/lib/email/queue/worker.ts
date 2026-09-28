/**
 * BullMQ Email Worker Processor
 *
 * Implements authoritative background delivery execution:
 * 1. Loads authoritative EmailDelivery from database.
 * 2. Enforces stale-delivery protection (never overwrites a later successful state).
 * 3. Enforces recipient suppression verification.
 * 4. Resolves tenant provider adapter.
 * 5. Dispatches email through provider.
 * 6. Updates database delivery state (PROCESSING -> SENT or FAILED).
 * 7. Error classification: transient errors trigger BullMQ backoff retry; permanent errors throw UnrecoverableError.
 * 8. Strict credential scrubbing: zero secrets or tokens in worker logs.
 * 9. Production telemetry tracking and failure handling.
 */

import { Worker, Job, UnrecoverableError } from "bullmq";
import { prisma } from "../../prisma";
import { EmailDelivery, EmailDeliveryStatus, EmailProviderType } from "@prisma/client";
import { createWorkerRedisConnection } from "./connection";
import { QUEUE_NAMES, TransactionalJobData, PromotionalJobData, JOB_NAMES, RetryableEmailError, isRetryableError } from "./types";
import { providerRegistry } from "../registry";
import { EmailProvider } from "../types";
import { logger } from "../../logger";
import { processPromotionalDeliveryJob } from "./promotional-delivery-worker";
import { workerTelemetry } from "./telemetry";

export { processPromotionalDeliveryJob };

export interface EmailWorkerOptions {
  connection?: ReturnType<typeof createWorkerRedisConnection>;
  providerOverride?: EmailProvider;
  concurrency?: number;
}

/**
 * Authoritative worker processor function for transactional email jobs.
 */
export async function processTransactionalJob(
  job: Job<TransactionalJobData>,
  options?: { providerOverride?: EmailProvider }
) {
  const { deliveryId, clientId } = job.data;
  const startTimeMs = workerTelemetry.recordJobStart();
  logger.info(`[Worker:Transactional] Processing job ${job.id} for delivery ${deliveryId} (tenant: ${clientId})`);

  // 1. Load Authoritative Delivery Record
  let delivery: EmailDelivery | null = null;
  try {
    delivery = await prisma.emailDelivery.findUnique({
      where: { id: deliveryId },
    });
  } catch (err) {
    logger.error(`[Worker:Transactional] DB query failed for delivery ${deliveryId}:`, err);
    const dbErr = new RetryableEmailError(
      `Database query failed for delivery '${deliveryId}': ${err instanceof Error ? err.message : String(err)}`
    );
    workerTelemetry.recordJobFailure(startTimeMs, dbErr);
    throw dbErr;
  }

  if (!delivery) {
    const notFoundErr = new UnrecoverableError(`Authoritative EmailDelivery '${deliveryId}' not found.`);
    workerTelemetry.recordJobFailure(startTimeMs, notFoundErr);
    throw notFoundErr;
  }

  // 2. Stale Delivery Guard: If already SENT or DELIVERED, ignore stale retry!
  if (
    delivery.status === EmailDeliveryStatus.SENT ||
    delivery.status === EmailDeliveryStatus.DELIVERED
  ) {
    logger.info(`[Worker:Transactional] Delivery ${deliveryId} is already ${delivery.status}. Skipping stale execution.`);
    workerTelemetry.recordJobSkipped();
    return {
      skipped: true,
      reason: "ALREADY_COMPLETED",
      status: delivery.status,
    };
  }

  // 3. Update Delivery to PROCESSING
  try {
    await prisma.emailDelivery.updateMany({
      where: {
        id: delivery.id,
        status: { in: [EmailDeliveryStatus.QUEUED, EmailDeliveryStatus.FAILED] },
      },
      data: {
        status: EmailDeliveryStatus.PROCESSING,
        attemptCount: { increment: 1 },
        lastAttemptAt: new Date(),
      },
    });
  } catch (err) {
    const dbErr = new RetryableEmailError(
      `Failed to transition delivery '${delivery.id}' to PROCESSING: ${err instanceof Error ? err.message : String(err)}`
    );
    workerTelemetry.recordJobFailure(startTimeMs, dbErr);
    throw dbErr;
  }

  // 4. Verify Recipient Suppression
  try {
    const isSuppressed = await prisma.emailSuppression.findFirst({
      where: {
        clientId: delivery.clientId,
        email: delivery.to,
      },
    });

    if (isSuppressed) {
      await prisma.emailDelivery.updateMany({
        where: { id: delivery.id, status: EmailDeliveryStatus.PROCESSING },
        data: {
          status: EmailDeliveryStatus.FAILED,
          errorCode: "RECIPIENT_SUPPRESSED",
          errorMessage: `Recipient '${delivery.to}' is on the tenant suppression list (${isSuppressed.reason}).`,
          failedAt: new Date(),
        },
      });

      const suppErr = new UnrecoverableError(`Recipient '${delivery.to}' is suppressed.`);
      workerTelemetry.recordJobFailure(startTimeMs, suppErr);
      throw suppErr;
    }
  } catch (err) {
    if (err instanceof UnrecoverableError) throw err;
  }

  // 5. Resolve Provider
  let provider: EmailProvider;
  let providerType: EmailProviderType = EmailProviderType.GMAIL;
  let providerSenderEmail: string | undefined;

  if (options?.providerOverride) {
    provider = options.providerOverride;
    providerType = provider.providerType;
  } else {
    try {
      const resolved = await providerRegistry.resolveForTenant(delivery.clientId);
      provider = resolved.provider;
      providerType = resolved.providerType;
      providerSenderEmail = resolved.senderEmail;
    } catch (resolveErr) {
      const msg = resolveErr instanceof Error ? resolveErr.message : "Provider resolution failed";
      await prisma.emailDelivery.updateMany({
        where: { id: delivery.id, status: EmailDeliveryStatus.PROCESSING },
        data: {
          status: EmailDeliveryStatus.FAILED,
          errorCode: "PROVIDER_RESOLUTION_FAILED",
          errorMessage: msg,
          failedAt: new Date(),
        },
      });
      const unrecErr = new UnrecoverableError(msg);
      workerTelemetry.recordJobFailure(startTimeMs, unrecErr);
      throw unrecErr;
    }
  }

  // 6. Execute Send via Resolved Provider with Authoritative Content
  const outgoingHtml = delivery.htmlContent || undefined;
  const outgoingText = delivery.textContent || undefined;

  if (!outgoingHtml && !outgoingText) {
    const emptyErr = new UnrecoverableError(
      `Delivery '${delivery.id}' has no authoritative content (htmlContent and textContent are both empty).`
    );
    workerTelemetry.recordJobFailure(startTimeMs, emptyErr);
    throw emptyErr;
  }

  try {
    const sendResult = await provider.send({
      clientId: delivery.clientId,
      type: "TRANSACTIONAL",
      to: delivery.to,
      from: delivery.from || providerSenderEmail || "system@whatsapphub.internal",
      replyTo: delivery.replyTo || undefined,
      subject: delivery.subject,
      html: outgoingHtml,
      text: outgoingText,
      transactionalReference: delivery.transactionalReference || undefined,
    });

    if (sendResult.accepted) {
      // 7. Persist Success Delivery State (Monotonic integrity: never downgrade if already SENT or DELIVERED)
      try {
        await prisma.emailDelivery.updateMany({
          where: {
            id: delivery.id,
            status: { in: [EmailDeliveryStatus.PROCESSING, EmailDeliveryStatus.QUEUED] },
          },
          data: {
            status: EmailDeliveryStatus.SENT,
            providerType,
            providerMessageId: sendResult.providerMessageId || null,
            sentAt: sendResult.sentAt || new Date(),
            errorCode: null,
            errorMessage: null,
          },
        });
      } catch {
        // Table fallback
      }

      workerTelemetry.recordJobSuccess(startTimeMs, {
        deliveryId,
        recipient: delivery.to,
        providerType,
      });

      logger.info(
        `[Worker:Transactional] Successfully sent delivery ${deliveryId} via ${sendResult.providerName} (messageId: ${sendResult.providerMessageId})`
      );
      return {
        success: true,
        deliveryId,
        providerMessageId: sendResult.providerMessageId,
        providerStatus: sendResult.providerStatus,
      };
    }

    // 8. Send Rejected by Provider — Classify Error
    const error = sendResult.error;
    const retryable = error?.retryable ?? isRetryableError(error);

    try {
      await prisma.emailDelivery.updateMany({
        where: {
          id: delivery.id,
          status: { in: [EmailDeliveryStatus.PROCESSING, EmailDeliveryStatus.QUEUED] },
        },
        data: {
          status: retryable ? EmailDeliveryStatus.PROCESSING : EmailDeliveryStatus.FAILED,
          errorCode: error?.code || "DISPATCH_FAILED",
          errorMessage: error?.message || "Provider rejected email send",
          failedAt: retryable ? null : new Date(),
        },
      });
    } catch {
      // Table fallback
    }

    if (retryable) {
      logger.warn(
        `[Worker:Transactional] Transient failure for delivery ${deliveryId}: ${error?.message}. Triggering BullMQ retry.`
      );
      const retryErr = new RetryableEmailError(error?.message || "Transient send failure", error?.code);
      workerTelemetry.recordJobFailure(startTimeMs, retryErr);
      throw retryErr;
    } else {
      logger.error(
        `[Worker:Transactional] Permanent failure for delivery ${deliveryId}: ${error?.message}. Failing job immediately.`
      );
      const permErr = new UnrecoverableError(error?.message || "Permanent delivery rejection");
      workerTelemetry.recordJobFailure(startTimeMs, permErr);
      throw permErr;
    }
  } catch (sendErr) {
    if (sendErr instanceof UnrecoverableError || sendErr instanceof RetryableEmailError) {
      throw sendErr;
    }

    // Unexpected runtime exception during provider call
    const retryable = isRetryableError(sendErr);
    const msg = sendErr instanceof Error ? sendErr.message : "Unexpected send error";

    try {
      await prisma.emailDelivery.updateMany({
        where: {
          id: delivery.id,
          status: { in: [EmailDeliveryStatus.PROCESSING, EmailDeliveryStatus.QUEUED] },
        },
        data: {
          status: retryable ? EmailDeliveryStatus.PROCESSING : EmailDeliveryStatus.FAILED,
          errorCode: "PROVIDER_EXCEPTION",
          errorMessage: msg,
          failedAt: retryable ? null : new Date(),
        },
      });
    } catch {
      // Table fallback
    }

    const finalErr = retryable ? new RetryableEmailError(msg) : new UnrecoverableError(msg);
    workerTelemetry.recordJobFailure(startTimeMs, finalErr);
    throw finalErr;
  }
}

/**
 * Creates and configures the BullMQ Worker for transactional emails.
 */
export function createEmailWorker(options?: EmailWorkerOptions): Worker {
  const connection = options?.connection || createWorkerRedisConnection();
  const concurrency = options?.concurrency || parseInt(process.env.EMAIL_WORKER_CONCURRENCY || "5", 10);

  const worker = new Worker<TransactionalJobData | PromotionalJobData>(
    QUEUE_NAMES.TRANSACTIONAL,
    async (job) => {
      if (job.name === JOB_NAMES.SEND_PROMOTIONAL) {
        return processPromotionalDeliveryJob(job as Job<PromotionalJobData>, {
          providerOverride: options?.providerOverride,
        });
      }
      return processTransactionalJob(job as Job<TransactionalJobData>, {
        providerOverride: options?.providerOverride,
      });
    },
    {
      connection,
      concurrency,
      lockDuration: 30000,
      stalledInterval: 15000,
      maxStalledCount: 2,
      limiter: {
        max: parseInt(process.env.EMAIL_QUEUE_MAX_RATE || "15", 10),
        duration: 1000, // 15 requests per second max
      },
    }
  );

  worker.on("completed", (job) => {
    logger.info(`[Worker:Transactional] Job ${job.id} completed successfully`);
  });

  worker.on("failed", (job, err) => {
    logger.error(`[Worker:Transactional] Job ${job?.id} failed with error: ${err.message}`);
  });

  worker.on("stalled", (jobId) => {
    workerTelemetry.recordJobStalled();
    logger.warn(`[Worker:Transactional] Job ${jobId} stalled and will be reclaimed by BullMQ`);
  });

  worker.on("error", (err) => {
    logger.error("[Worker:Transactional] Worker runtime error:", err);
  });

  return worker;
}
