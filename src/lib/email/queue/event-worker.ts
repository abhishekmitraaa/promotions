/**
 * BullMQ Email Event Worker Processor
 *
 * Real asynchronous processing for email webhook event jobs from the 'email-events' queue.
 * - Loads authoritative EmailEvent from DB.
 * - Correlates delivery and applies strengthened monotonic state machine.
 * - Updates campaign metrics idempotently.
 * - Enforces bounce/complaint/unsubscribe suppression policies.
 * - Retries transient failures with exponential backoff.
 * - Marks permanent failures as terminal (FAILED) and observable.
 */

import { Job, Worker } from "bullmq";
import {
  EmailEventJobData,
  QUEUE_NAMES,
  RetryableEmailError,
  PermanentEmailError,
  isRetryableError,
} from "./types";
import { createWorkerRedisConnection } from "./connection";
import { EmailEventService } from "../../services/email-event-service";
import { logger } from "../../logger";

export async function processEmailEventJob(job: Job<EmailEventJobData>) {
  const eventRecordId = job.data.eventRecordId || job.data.eventId;
  const { eventType, providerType } = job.data;

  if (!eventRecordId) {
    logger.error(`[Worker:Event] Job ${job.id} is missing eventRecordId or eventId`);
    throw new PermanentEmailError("Missing eventRecordId in job data");
  }

  logger.info(
    `[Worker:Event] Processing email event job ${job.id} (recordId: ${eventRecordId}, type: ${eventType || "unknown"}, provider: ${providerType || "unknown"}, attempt: ${job.attemptsMade + 1})`
  );

  try {
    const result = await EmailEventService.processEventFromWorker(eventRecordId);
    logger.info(
      `[Worker:Event] Successfully finished event job ${job.id} for event ${eventRecordId}`
    );
    return result;
  } catch (err) {
    if (isRetryableError(err)) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(
        `[Worker:Event] Transient failure processing event ${eventRecordId} (will retry): ${msg}`
      );
      throw err instanceof RetryableEmailError ? err : new RetryableEmailError(msg);
    }

    const msg = err instanceof Error ? err.message : String(err);
    logger.error(
      `[Worker:Event] Permanent terminal failure processing event ${eventRecordId}: ${msg}`
    );
    throw err instanceof PermanentEmailError ? err : new PermanentEmailError(msg);
  }
}

/**
 * Creates and configures the BullMQ Worker for email event jobs.
 */
export function createEventWorker(options?: {
  connection?: ReturnType<typeof createWorkerRedisConnection>;
  concurrency?: number;
}): Worker {
  const connection = options?.connection || createWorkerRedisConnection();
  const concurrency =
    options?.concurrency || parseInt(process.env.EMAIL_EVENTS_CONCURRENCY || "10", 10);

  const worker = new Worker<EmailEventJobData>(
    QUEUE_NAMES.EVENTS,
    async (job) => {
      return processEmailEventJob(job);
    },
    {
      connection,
      concurrency,
    }
  );

  worker.on("completed", (job) => {
    logger.info(`[Worker:Event] Job ${job.id} completed successfully`);
  });

  worker.on("failed", (job, err) => {
    logger.error(`[Worker:Event] Job ${job?.id} failed with error: ${err.message}`);
  });

  worker.on("error", (err) => {
    logger.error("[Worker:Event] Event worker runtime error:", err);
  });

  return worker;
}
