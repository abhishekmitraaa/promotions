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
  JOB_NAMES,
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

    const deduplicationKey = opts?.jobId || undefined;
    if (deduplicationKey) {
      try {
        const existing = await prisma.backgroundJob.findFirst({
          where: { clientId, deduplicationKey },
        });
        if (existing) {
          logger.info(
            `[WorkerlessQueue] Job '${name}' already exists with deduplicationKey '${deduplicationKey}', returning existing job ${existing.id}`
          );
          return {
            id: deduplicationKey || existing.id,
            name,
            data,
            getState: async () => existing.status.toLowerCase(),
            remove: async () => {
              await prisma.backgroundJob.deleteMany({ where: { id: existing.id } }).catch(() => {});
            },
          };
        }
      } catch {
        // Table or query check failed, fall through to creation
      }
    }

    try {
      const bg = await prisma.backgroundJob.create({
        data: {
          clientId,
          type: jobType,
          status: BackgroundJobStatus.QUEUED,
          payload: JSON.stringify(payloadObj),
          scheduledAt: availableAt,
          availableAt,
          deduplicationKey,
        },
      });

      logger.info(`[WorkerlessQueue] Job '${name}' persisted durably as BackgroundJob ${bg.id}`);
      return {
        id: deduplicationKey || bg.id,
        name,
        data,
        getState: async () => "waiting",
        remove: async () => {
          await prisma.backgroundJob.deleteMany({ where: { id: bg.id } }).catch(() => {});
        },
      };
    } catch (err: unknown) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        if (deduplicationKey) {
          const existing = await prisma.backgroundJob.findFirst({
            where: { clientId, deduplicationKey },
          });
          if (existing) {
            logger.info(
              `[WorkerlessQueue] Job '${name}' already exists with deduplicationKey '${deduplicationKey}', returning existing job ${existing.id}`
            );
            return {
              id: deduplicationKey || existing.id,
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

      let jobName: string = bg.type;
      if (bg.type === "TRANSACTIONAL_EMAIL") jobName = JOB_NAMES.SEND_TRANSACTIONAL;
      else if (bg.type === "PROMOTIONAL_EMAIL") jobName = JOB_NAMES.SEND_PROMOTIONAL;
      else if (bg.type === "CAMPAIGN_RECIPIENT") jobName = JOB_NAMES.SEND_CAMPAIGN_RECIPIENT;
      else if (bg.type === "CAMPAIGN_TRIGGER") jobName = JOB_NAMES.TRIGGER_SCHEDULED_CAMPAIGN;
      else if (bg.type === "AUTOMATION_STEP") jobName = JOB_NAMES.PROCESS_AUTOMATION_STEP;
      else if (bg.type === "EMAIL_EVENT") jobName = JOB_NAMES.PROCESS_EMAIL_EVENT;

      return {
        id: bg.deduplicationKey || bg.id,
        name: jobName,
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

  async getJobCounts(...types: string[]): Promise<Record<string, number>> {
    try {
      const now = new Date();
      const [waiting, active, completed, failed, delayed] = await Promise.all([
        prisma.backgroundJob.count({
          where: { status: BackgroundJobStatus.QUEUED, availableAt: { lte: now } },
        }),
        prisma.backgroundJob.count({
          where: { status: BackgroundJobStatus.PROCESSING },
        }),
        prisma.backgroundJob.count({
          where: { status: BackgroundJobStatus.COMPLETED },
        }),
        prisma.backgroundJob.count({
          where: { status: BackgroundJobStatus.FAILED },
        }),
        prisma.backgroundJob.count({
          where: { status: BackgroundJobStatus.QUEUED, availableAt: { gt: now } },
        }),
      ]);

      const counts: Record<string, number> = {
        waiting,
        active,
        completed,
        failed,
        delayed,
      };

      if (types.length === 0) return counts;
      const filtered: Record<string, number> = {};
      for (const t of types) {
        filtered[t] = counts[t] || 0;
      }
      return filtered;
    } catch (err) {
      logger.error("[WorkerlessQueue] Failed to get job counts:", err);
      return { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 };
    }
  }

  async getFailed(start = 0, end = 10) {
    try {
      const take = Math.max(1, end - start + 1);
      const failedJobs = await prisma.backgroundJob.findMany({
        where: { status: BackgroundJobStatus.FAILED },
        orderBy: { failedAt: "desc" },
        skip: start,
        take,
      });

      return failedJobs.map((j) => ({
        id: j.id,
        name: j.type,
        data: JSON.parse(j.payload || "{}") as T,
        failedReason: j.lastErrorMessage || "Execution failed",
        attemptsMade: j.attemptCount,
        finishedOn: j.failedAt ? j.failedAt.getTime() : undefined,
      }));
    } catch {
      return [];
    }
  }

  async drain() {
    try {
      await prisma.backgroundJob.deleteMany({
        where: { status: BackgroundJobStatus.QUEUED },
      });
    } catch (err) {
      logger.warn("[WorkerlessQueue] Failed to drain queue:", err);
    }
  }

  async clean(grace: number, limit = 1000, type = "completed"): Promise<string[]> {
    try {
      const statusMap: Record<string, BackgroundJobStatus> = {
        completed: BackgroundJobStatus.COMPLETED,
        failed: BackgroundJobStatus.FAILED,
        active: BackgroundJobStatus.PROCESSING,
        wait: BackgroundJobStatus.QUEUED,
      };
      const targetStatus = statusMap[type.toLowerCase()] || BackgroundJobStatus.COMPLETED;
      const graceDate = new Date(Date.now() - grace);

      const toClean = await prisma.backgroundJob.findMany({
        where: {
          status: targetStatus,
          updatedAt: { lte: graceDate },
        },
        select: { id: true },
        take: limit,
      });

      if (toClean.length > 0) {
        const ids = toClean.map((j) => j.id);
        await prisma.backgroundJob.deleteMany({
          where: { id: { in: ids } },
        });
        return ids;
      }
      return [];
    } catch {
      return [];
    }
  }

  async isPaused(): Promise<boolean> {
    return false;
  }

  async pause(): Promise<void> {}

  async resume(): Promise<void> {}

  async close() {}
}

let transactionalQueue: Queue<TransactionalJobData | PromotionalJobData> | null = null;
let campaignQueue: Queue<CampaignJobData | PromotionalJobData | AutomationJobData> | null = null;
let eventsQueue: Queue<EmailEventJobData> | null = null;

let workerlessTransactionalQueue: WorkerlessQueueAdapter<TransactionalJobData | PromotionalJobData> | null = null;
let workerlessCampaignQueue: WorkerlessQueueAdapter<CampaignJobData | PromotionalJobData | AutomationJobData> | null = null;
let workerlessEventsQueue: WorkerlessQueueAdapter<EmailEventJobData> | null = null;

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
    if (!workerlessTransactionalQueue) {
      workerlessTransactionalQueue = new WorkerlessQueueAdapter<TransactionalJobData | PromotionalJobData>(
        QUEUE_NAMES.TRANSACTIONAL
      );
    }
    return workerlessTransactionalQueue as unknown as Queue<TransactionalJobData | PromotionalJobData>;
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
    if (!workerlessCampaignQueue) {
      workerlessCampaignQueue = new WorkerlessQueueAdapter<CampaignJobData | PromotionalJobData | AutomationJobData>(
        QUEUE_NAMES.CAMPAIGN
      );
    }
    return workerlessCampaignQueue as unknown as Queue<CampaignJobData | PromotionalJobData | AutomationJobData>;
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
    if (!workerlessEventsQueue) {
      workerlessEventsQueue = new WorkerlessQueueAdapter<EmailEventJobData>(
        QUEUE_NAMES.EVENTS
      );
    }
    return workerlessEventsQueue as unknown as Queue<EmailEventJobData>;
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
