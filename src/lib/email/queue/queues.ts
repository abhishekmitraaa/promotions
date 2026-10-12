/**
 * Durable Job Queues (PostgreSQL BackgroundJob table)
 *
 * Producers enqueue work here; ServerlessJobProcessor executes it when Supabase Cron calls
 * /api/internal/process-jobs. There is no Redis and no long-running worker process.
 */

import {
  QUEUE_NAMES,
  JOB_NAMES,
  EmailJobName,
  TransactionalJobData,
  PromotionalJobData,
  CampaignJobData,
  AutomationJobData,
  EmailEventJobData,
} from "./types";
import { logger } from "../../logger";
import { prisma } from "../../prisma";
import { BackgroundJob, BackgroundJobStatus, Prisma } from "@prisma/client";

/** BackgroundJob.type for each producer job name (the processor dispatches on this). */
const JOB_TYPE_BY_NAME: Record<EmailJobName, string> = {
  [JOB_NAMES.SEND_TRANSACTIONAL]: "TRANSACTIONAL_EMAIL",
  [JOB_NAMES.SEND_PROMOTIONAL]: "PROMOTIONAL_EMAIL",
  [JOB_NAMES.SEND_CAMPAIGN_RECIPIENT]: "CAMPAIGN_RECIPIENT",
  [JOB_NAMES.TRIGGER_SCHEDULED_CAMPAIGN]: "CAMPAIGN_TRIGGER",
  [JOB_NAMES.PROCESS_EMAIL_EVENT]: "EMAIL_EVENT",
  [JOB_NAMES.PROCESS_AUTOMATION_STEP]: "AUTOMATION_STEP",
  [JOB_NAMES.TRIGGER_RECURRING_AUTOMATION]: "RECURRING_AUTOMATION",
};

const JOB_NAME_BY_TYPE: Record<string, EmailJobName> = Object.fromEntries(
  Object.entries(JOB_TYPE_BY_NAME).map(([name, type]) => [type, name as EmailJobName])
);

/** BackgroundJob types belonging to each logical queue (all queues share one table). */
export const QUEUE_JOB_TYPES: Record<string, string[]> = {
  [QUEUE_NAMES.TRANSACTIONAL]: ["TRANSACTIONAL_EMAIL", "PROMOTIONAL_EMAIL", "EMAIL_DELIVERY"],
  [QUEUE_NAMES.CAMPAIGN]: ["CAMPAIGN_RECIPIENT", "CAMPAIGN_TRIGGER", "AUTOMATION_STEP", "RECURRING_AUTOMATION"],
  [QUEUE_NAMES.EVENTS]: ["EMAIL_EVENT"],
};

export interface EnqueueOptions {
  /** Stable business key; enqueueing the same key twice returns the existing job. */
  jobId?: string;
  delay?: number;
  attempts?: number;
  /** Accepted for call-site compatibility; retry backoff is computed by the processor. */
  backoff?: unknown;
}

export interface QueuedJob<T> {
  id: string;
  name: string;
  data: T;
  getState(): Promise<"waiting" | "active" | "completed" | "failed" | "cancelled">;
  remove(): Promise<void>;
}

export interface FailedQueueJob<T> {
  id: string;
  name: string;
  data: T;
  failedReason: string;
  attemptsMade: number;
  finishedOn?: number;
}

function stateOf(status: BackgroundJobStatus): "waiting" | "active" | "completed" | "failed" | "cancelled" {
  switch (status) {
    case BackgroundJobStatus.COMPLETED:
      return "completed";
    case BackgroundJobStatus.FAILED:
      return "failed";
    case BackgroundJobStatus.PROCESSING:
      return "active";
    case BackgroundJobStatus.CANCELLED:
      return "cancelled";
    default:
      return "waiting";
  }
}

function parsePayload<T>(payload: string | null): T {
  try {
    return JSON.parse(payload || "{}") as T;
  } catch {
    return {} as T;
  }
}

export class PostgresJobQueue<T = unknown> {
  readonly name: string;
  private readonly jobTypes: string[];

  constructor(name: string) {
    this.name = name;
    this.jobTypes = QUEUE_JOB_TYPES[name] || [];
  }

  private toQueuedJob(job: BackgroundJob, name: string, data: T): QueuedJob<T> {
    return {
      id: job.deduplicationKey || job.id,
      name,
      data,
      getState: async () => {
        const fresh = await prisma.backgroundJob.findUnique({ where: { id: job.id }, select: { status: true } });
        return stateOf(fresh?.status ?? job.status);
      },
      remove: async () => {
        await prisma.backgroundJob.deleteMany({ where: { id: job.id } });
      },
    };
  }

  async add(name: EmailJobName, data: T, opts: EnqueueOptions = {}): Promise<QueuedJob<T>> {
    const jobType = JOB_TYPE_BY_NAME[name];
    if (!jobType) {
      throw new Error(`Unknown job name '${name}' for queue '${this.name}'`);
    }

    const payloadObj = data && typeof data === "object" ? (data as Record<string, unknown>) : { data };
    const clientId = (payloadObj.clientId as string) || "system";
    const delayMs = Math.max(0, opts.delay || 0);
    const availableAt = new Date(Date.now() + delayMs);
    const deduplicationKey = opts.jobId || undefined;

    if (deduplicationKey) {
      const existing = await prisma.backgroundJob.findFirst({ where: { clientId, deduplicationKey } });
      if (existing) {
        logger.info(`[JobQueue] Job '${name}' already enqueued as ${existing.id} (key '${deduplicationKey}')`);
        return this.toQueuedJob(existing, name, data);
      }
    }

    try {
      const job = await prisma.backgroundJob.create({
        data: {
          clientId,
          type: jobType,
          status: BackgroundJobStatus.QUEUED,
          payload: JSON.stringify(payloadObj),
          scheduledAt: availableAt,
          availableAt,
          deduplicationKey,
          ...(opts.attempts ? { maxAttempts: opts.attempts } : {}),
        },
      });
      logger.info(`[JobQueue] Job '${name}' persisted as BackgroundJob ${job.id}`);
      return this.toQueuedJob(job, name, data);
    } catch (err: unknown) {
      // Concurrent enqueue with the same key: return the winner
      if (deduplicationKey && err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        const existing = await prisma.backgroundJob.findFirst({ where: { clientId, deduplicationKey } });
        if (existing) return this.toQueuedJob(existing, name, data);
      }
      logger.error(`[JobQueue] Failed to persist BackgroundJob for '${name}':`, err);
      throw err;
    }
  }

  async getJob(id: string): Promise<QueuedJob<T> | null> {
    const job = await prisma.backgroundJob.findFirst({
      where: { OR: [{ id }, { deduplicationKey: id }] },
    });
    if (!job) return null;
    return this.toQueuedJob(job, JOB_NAME_BY_TYPE[job.type] || job.type, parsePayload<T>(job.payload));
  }

  async getJobCounts(...types: string[]): Promise<Record<string, number>> {
    const now = new Date();
    const type = { in: this.jobTypes };
    const [waiting, active, completed, failed, delayed] = await Promise.all([
      prisma.backgroundJob.count({ where: { type, status: BackgroundJobStatus.QUEUED, availableAt: { lte: now } } }),
      prisma.backgroundJob.count({ where: { type, status: BackgroundJobStatus.PROCESSING } }),
      prisma.backgroundJob.count({ where: { type, status: BackgroundJobStatus.COMPLETED } }),
      prisma.backgroundJob.count({ where: { type, status: BackgroundJobStatus.FAILED } }),
      prisma.backgroundJob.count({ where: { type, status: BackgroundJobStatus.QUEUED, availableAt: { gt: now } } }),
    ]);
    const counts: Record<string, number> = { waiting, active, completed, failed, delayed };
    if (types.length === 0) return counts;
    return Object.fromEntries(types.map((t) => [t, counts[t] || 0]));
  }

  /** Deletes this queue's jobs that are still waiting (QUEUED). */
  async drain(): Promise<void> {
    await prisma.backgroundJob.deleteMany({
      where: { type: { in: this.jobTypes }, status: BackgroundJobStatus.QUEUED },
    });
  }

  /** Deletes up to `limit` of this queue's jobs in the given state older than `graceMs`. Returns their ids. */
  async clean(graceMs: number, limit = 1000, state: "completed" | "failed" | "wait" = "completed"): Promise<string[]> {
    const status = {
      completed: BackgroundJobStatus.COMPLETED,
      failed: BackgroundJobStatus.FAILED,
      wait: BackgroundJobStatus.QUEUED,
    }[state];
    const stale = await prisma.backgroundJob.findMany({
      where: { type: { in: this.jobTypes }, status, updatedAt: { lte: new Date(Date.now() - graceMs) } },
      select: { id: true },
      take: limit,
    });
    const ids = stale.map((j) => j.id);
    if (ids.length > 0) await prisma.backgroundJob.deleteMany({ where: { id: { in: ids } } });
    return ids;
  }

  async getFailed(start = 0, end = 10): Promise<FailedQueueJob<T>[]> {
    const failedJobs = await prisma.backgroundJob.findMany({
      where: { type: { in: this.jobTypes }, status: BackgroundJobStatus.FAILED },
      orderBy: { failedAt: "desc" },
      skip: start,
      take: Math.max(1, end - start + 1),
    });
    return failedJobs.map((j) => ({
      id: j.id,
      name: JOB_NAME_BY_TYPE[j.type] || j.type,
      data: parsePayload<T>(j.payload),
      failedReason: j.lastErrorMessage || "Execution failed",
      attemptsMade: j.attemptCount,
      finishedOn: j.failedAt ? j.failedAt.getTime() : undefined,
    }));
  }
}

let transactionalQueue: PostgresJobQueue<TransactionalJobData | PromotionalJobData> | null = null;
let campaignQueue: PostgresJobQueue<CampaignJobData | PromotionalJobData | AutomationJobData> | null = null;
let eventsQueue: PostgresJobQueue<EmailEventJobData> | null = null;

/** Transactional and single promotional email deliveries. */
export function getTransactionalQueue(): PostgresJobQueue<TransactionalJobData | PromotionalJobData> {
  if (!transactionalQueue) transactionalQueue = new PostgresJobQueue(QUEUE_NAMES.TRANSACTIONAL);
  return transactionalQueue;
}

/** Campaign recipients, scheduled campaign triggers and automation steps. */
export function getCampaignQueue(): PostgresJobQueue<CampaignJobData | PromotionalJobData | AutomationJobData> {
  if (!campaignQueue) campaignQueue = new PostgresJobQueue(QUEUE_NAMES.CAMPAIGN);
  return campaignQueue;
}

/** Inbound provider email events. */
export function getEventsQueue(): PostgresJobQueue<EmailEventJobData> {
  if (!eventsQueue) eventsQueue = new PostgresJobQueue(QUEUE_NAMES.EVENTS);
  return eventsQueue;
}
