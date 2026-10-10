/**
 * BullMQ Queue Producers & Queue Lifecycle Management
 *
 * Supports both:
 * 1. Distributed BullMQ execution with Redis (when Redis is available / configured)
 * 2. Workerless execution on Vercel + Supabase (when WORKERLESS_MODE=true or running in serverless without Redis)
 */

import { Queue, QueueOptions } from "bullmq";
import { getRedisConnection } from "./connection";
import {
  QUEUE_NAMES,
  TransactionalJobData,
  PromotionalJobData,
  CampaignJobData,
  AutomationJobData,
  EmailEventJobData,
} from "./types";
import { logger } from "../../logger";

import { prisma } from "../../prisma";
import { BackgroundJobStatus, Prisma } from "@prisma/client";

export function isWorkerlessMode(): boolean {
  if (process.env.WORKERLESS_MODE === "true") return true;
  // If running in Vercel or production without an external non-local Redis URL:
  if (!process.env.REDIS_URL || process.env.REDIS_URL.includes("127.0.0.1") || process.env.REDIS_URL.includes("localhost")) {
    return true;
  }
  return false;
}

class WorkerlessQueueAdapter<T = unknown> {
  readonly name: string;

  constructor(name: string) {
    this.name = name;
  }

  async add(name: string, data: T, opts?: { jobId?: string; delay?: number }) {
    const payloadObj = (data && typeof data === "object") ? (data as Record<string, unknown>) : { data };
    const clientId = (payloadObj.clientId as string) || "system";
    const delayMs = opts?.delay || 0;
    const availableAt = delayMs > 0 ? new Date(Date.now() + delayMs) : new Date();

    let jobType = "BACKGROUND_JOB";
    const lowerName = name.toLowerCase();
    if (lowerName.includes("transactional")) jobType = "TRANSACTIONAL_EMAIL";
    else if (lowerName.includes("promotional")) jobType = "PROMOTIONAL_EMAIL";
    else if (lowerName.includes("recipient")) jobType = "CAMPAIGN_RECIPIENT";
    else if (lowerName.includes("trigger")) jobType = "CAMPAIGN_TRIGGER";
    else if (lowerName.includes("automation")) jobType = "AUTOMATION_STEP";
    else if (lowerName.includes("event")) jobType = "EMAIL_EVENT";

    try {
      const bg = await prisma.backgroundJob.create({
        data: {
          clientId,
          type: jobType,
          status: BackgroundJobStatus.QUEUED,
          payload: JSON.stringify(payloadObj),
          scheduledAt: availableAt,
          availableAt,
          deduplicationKey: opts?.jobId || undefined,
        },
      });

      logger.info(`[WorkerlessQueue] Job '${name}' persisted durably as BackgroundJob ${bg.id}`);
      return {
        id: bg.id,
        name,
        data,
        getState: async () => "waiting",
        remove: async () => {
          await prisma.backgroundJob.deleteMany({ where: { id: bg.id } }).catch(() => {});
        },
      };
    } catch (err: unknown) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        if (opts?.jobId) {
          const existing = await prisma.backgroundJob.findFirst({
            where: { clientId, deduplicationKey: opts.jobId },
          });
          if (existing) {
            logger.info(
              `[WorkerlessQueue] Job '${name}' already exists with deduplicationKey '${opts.jobId}', returning existing job ${existing.id}`
            );
            return {
              id: existing.id,
              name,
              data,
              getState: async () => existing.status.toLowerCase(),
              remove: async () => {
                await prisma.backgroundJob.deleteMany({ where: { id: existing.id } }).catch(() => {});
              },
            };
          }
        }
      }
      logger.error(`[WorkerlessQueue] Failed to persist BackgroundJob for '${name}':`, err);
      throw err;
    }
  }

  async getJob(id: string) {
    try {
      const bg = await prisma.backgroundJob.findFirst({
        where: {
          OR: [
            { id },
            { deduplicationKey: id },
          ],
        },
      });
      if (!bg) return null;
      return {
        id: bg.id,
        name: bg.type,
        data: JSON.parse(bg.payload || "{}") as T,
        getState: async () => {
          if (bg.status === BackgroundJobStatus.COMPLETED) return "completed";
          if (bg.status === BackgroundJobStatus.FAILED) return "failed";
          if (bg.status === BackgroundJobStatus.PROCESSING) return "active";
          return "waiting";
        },
        remove: async () => {
          await prisma.backgroundJob.deleteMany({ where: { id: bg.id } }).catch(() => {});
        },
      };
    } catch {
      return null;
    }
  }

  async close() {}
}

let transactionalQueue: Queue<TransactionalJobData | PromotionalJobData> | null = null;
let campaignQueue: Queue<CampaignJobData | PromotionalJobData | AutomationJobData> | null = null;
let eventsQueue: Queue<EmailEventJobData> | null = null;

function getBaseQueueOptions(): QueueOptions {
  return {
    connection: getRedisConnection(),
    defaultJobOptions: {
      attempts: parseInt(process.env.EMAIL_QUEUE_MAX_ATTEMPTS || "3", 10),
      backoff: {
        type: "exponential",
        delay: parseInt(process.env.EMAIL_QUEUE_BACKOFF_MS || "2000", 10),
      },
      removeOnComplete: {
        count: 1000,
        age: 24 * 3600, // 24 hours
      },
      removeOnFail: {
        count: 5000,
        age: 7 * 24 * 3600, // 7 days
      },
    },
  };
}

/**
 * Accessor for the transactional email queue.
 */
export function getTransactionalQueue(): Queue<TransactionalJobData | PromotionalJobData> {
  if (isWorkerlessMode()) {
    return new WorkerlessQueueAdapter<TransactionalJobData | PromotionalJobData>(
      QUEUE_NAMES.TRANSACTIONAL
    ) as unknown as Queue<TransactionalJobData | PromotionalJobData>;
  }

  if (!transactionalQueue) {
    transactionalQueue = new Queue<TransactionalJobData | PromotionalJobData>(
      QUEUE_NAMES.TRANSACTIONAL,
      getBaseQueueOptions()
    );
  }
  return transactionalQueue;
}

/**
 * Accessor for the promotional campaign queue.
 */
export function getCampaignQueue(): Queue<CampaignJobData | PromotionalJobData | AutomationJobData> {
  if (isWorkerlessMode()) {
    return new WorkerlessQueueAdapter<CampaignJobData | PromotionalJobData | AutomationJobData>(
      QUEUE_NAMES.CAMPAIGN
    ) as unknown as Queue<CampaignJobData | PromotionalJobData | AutomationJobData>;
  }

  if (!campaignQueue) {
    campaignQueue = new Queue<CampaignJobData | PromotionalJobData | AutomationJobData>(
      QUEUE_NAMES.CAMPAIGN,
      getBaseQueueOptions()
    );
  }
  return campaignQueue;
}

/**
 * Accessor for the email events/webhook queue.
 */
export function getEventsQueue(): Queue<EmailEventJobData> {
  if (isWorkerlessMode()) {
    return new WorkerlessQueueAdapter<EmailEventJobData>(
      QUEUE_NAMES.EVENTS
    ) as unknown as Queue<EmailEventJobData>;
  }

  if (!eventsQueue) {
    eventsQueue = new Queue<EmailEventJobData>(
      QUEUE_NAMES.EVENTS,
      getBaseQueueOptions()
    );
  }
  return eventsQueue;
}

/**
 * Closes all active BullMQ queue producer connections cleanly.
 */
export async function closeAllQueues(): Promise<void> {
  const closeTasks: Promise<unknown>[] = [];
  if (transactionalQueue) {
    closeTasks.push(transactionalQueue.close());
    transactionalQueue = null;
  }
  if (campaignQueue) {
    closeTasks.push(campaignQueue.close());
    campaignQueue = null;
  }
  if (eventsQueue) {
    closeTasks.push(eventsQueue.close());
    eventsQueue = null;
  }
  await Promise.allSettled(closeTasks);
}
