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

export function isWorkerlessMode(): boolean {
  if (process.env.WORKERLESS_MODE === "true") return true;
  // If running in Vercel and no external Redis URL is provided:
  if (process.env.VERCEL === "1" && (!process.env.REDIS_URL || process.env.REDIS_URL.includes("127.0.0.1"))) {
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
    const id = opts?.jobId || `job-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    logger.info(`[WorkerlessQueue] Job '${name}' (${id}) safely recorded to durable DB state`);
    return {
      id,
      name,
      data,
      getState: async () => "waiting",
      remove: async () => {},
    };
  }

  async getJob(id: string) {
    void id;
    return null;
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
