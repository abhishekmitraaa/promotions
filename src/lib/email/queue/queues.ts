/**
 * BullMQ Queue Producers & Queue Lifecycle Management
 */

import { Queue, QueueOptions } from "bullmq";
import { getRedisConnection } from "./connection";
import {
  QUEUE_NAMES,
  TransactionalJobData,
  PromotionalJobData,
  CampaignJobData,
  EmailEventJobData,
} from "./types";

let transactionalQueue: Queue<TransactionalJobData | PromotionalJobData> | null = null;
let campaignQueue: Queue<CampaignJobData | PromotionalJobData> | null = null;
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
export function getCampaignQueue(): Queue<CampaignJobData | PromotionalJobData> {
  if (!campaignQueue) {
    campaignQueue = new Queue<CampaignJobData | PromotionalJobData>(
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
