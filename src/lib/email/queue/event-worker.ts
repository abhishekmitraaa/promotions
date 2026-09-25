/**
 * BullMQ Email Event Worker Processor
 *
 * Processes asynchronous webhook event jobs from the 'email-events' queue.
 */

import { Job, Worker } from "bullmq";
import { EmailEventJobData, QUEUE_NAMES } from "./types";
import { createWorkerRedisConnection } from "./connection";
import { logger } from "../../logger";

export async function processEmailEventJob(job: Job<EmailEventJobData>) {
  const { eventId, eventType, providerType } = job.data;
  logger.info(
    `[Worker:Event] Processing email event job ${job.id} (eventId: ${eventId}, type: ${eventType}, provider: ${providerType})`
  );

  return { success: true, processedEventId: eventId };
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
