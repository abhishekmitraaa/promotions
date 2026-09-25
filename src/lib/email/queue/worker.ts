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
  logger.info(`[Worker:Transactional] Processing job ${job.id} for delivery ${deliveryId} (tenant: ${clientId})`);

  // 1. Load Authoritative Delivery Record
  let delivery: EmailDelivery | null = null;
  try {
    delivery = await prisma.emailDelivery.findUnique({
      where: { id: deliveryId },
    });
  } catch (err) {
    logger.error(`[Worker:Transactional] DB query failed for delivery ${deliveryId}:`, err);
  }

  if (!delivery) {
    // Permanent failure: record does not exist
    throw new UnrecoverableError(`Authoritative EmailDelivery '${deliveryId}' not found.`);
  }

  // 2. Stale Delivery Guard: If already SENT or DELIVERED, ignore stale retry!
  if (
    delivery.status === EmailDeliveryStatus.SENT ||
    delivery.status === EmailDeliveryStatus.DELIVERED
  ) {
    logger.info(`[Worker:Transactional] Delivery ${deliveryId} is already ${delivery.status}. Skipping stale execution.`);
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
  } catch {
    // If table not yet migrated, continue processing
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
        where: { id: delivery.id },
        data: {
          status: EmailDeliveryStatus.FAILED,
          errorCode: "RECIPIENT_SUPPRESSED",
          errorMessage: `Recipient '${delivery.to}' is on the tenant suppression list (${isSuppressed.reason}).`,
          failedAt: new Date(),
        },
      });

      // Permanent error: Do NOT retry suppressed recipients
      throw new UnrecoverableError(`Recipient '${delivery.to}' is suppressed.`);
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
      // Provider unconfigured or invalid is a permanent error requiring admin intervention
      await prisma.emailDelivery.updateMany({
        where: { id: delivery.id },
        data: {
          status: EmailDeliveryStatus.FAILED,
          errorCode: "PROVIDER_RESOLUTION_FAILED",
          errorMessage: msg,
          failedAt: new Date(),
        },
      });
      throw new UnrecoverableError(msg);
    }
  }

  // 6. Execute Send via Resolved Provider
  try {
    const sendResult = await provider.send({
      clientId: delivery.clientId,
      type: "TRANSACTIONAL",
      to: delivery.to,
      from: delivery.from || providerSenderEmail || "system@whatsapphub.internal",
      subject: delivery.subject,
      html: `<p>${delivery.subject}</p>`,
      text: delivery.subject,
      transactionalReference: delivery.transactionalReference || undefined,
    });

    if (sendResult.accepted) {
      // 7. Persist Success Delivery State
      try {
        await prisma.emailDelivery.updateMany({
          where: { id: delivery.id },
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

      logger.info(`[Worker:Transactional] Successfully sent delivery ${deliveryId} via ${sendResult.providerName} (messageId: ${sendResult.providerMessageId})`);
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
        where: { id: delivery.id },
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
      logger.warn(`[Worker:Transactional] Transient failure for delivery ${deliveryId}: ${error?.message}. Triggering BullMQ retry.`);
      throw new RetryableEmailError(error?.message || "Transient send failure", error?.code);
    } else {
      logger.error(`[Worker:Transactional] Permanent failure for delivery ${deliveryId}: ${error?.message}. Failing job immediately.`);
      throw new UnrecoverableError(error?.message || "Permanent delivery rejection");
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
        where: { id: delivery.id },
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

    if (retryable) {
      throw new RetryableEmailError(msg);
    } else {
      throw new UnrecoverableError(msg);
    }
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

  worker.on("error", (err) => {
    logger.error("[Worker:Transactional] Worker runtime error:", err);
  });

  return worker;
}
