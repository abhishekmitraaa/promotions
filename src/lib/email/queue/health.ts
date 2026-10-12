/**
 * Job Queue & Processor Health (PostgreSQL)
 *
 * - PostgreSQL connectivity and round-trip latency
 * - Job depth per logical queue (waiting, active, completed, failed, delayed)
 * - Processor liveness: the cron-driven processor is considered stalled when runnable jobs
 *   have been waiting longer than PROCESSOR_STALL_THRESHOLD_MS
 * - Dead-letter visibility: most recent failed jobs, with secrets redacted
 */

import { BackgroundJobStatus } from "@prisma/client";
import { getTransactionalQueue, getCampaignQueue, getEventsQueue, PostgresJobQueue } from "./queues";
import { prisma } from "../../prisma";
import { logger } from "../../logger";
import { redactSecrets } from "../../crypto";

/** Cron runs every minute; a runnable job older than this means the processor is not running. */
export const PROCESSOR_STALL_THRESHOLD_MS = 5 * 60 * 1000;

export interface QueueJobCounts {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
}

export interface FailedJobSummary {
  id: string;
  name: string;
  failedReason: string;
  attemptsMade: number;
  failedTimestamp?: number;
}

export interface EmailQueueHealthReport {
  status: "HEALTHY" | "DEGRADED" | "DOWN";
  postgres: {
    connected: boolean;
    latencyMs?: number;
    error?: string;
  };
  processor: {
    status: "READY" | "STALLED" | "UNKNOWN";
    oldestRunnableJobAgeMs?: number;
    lastActivityAt?: string;
  };
  queues: {
    transactional: QueueJobCounts;
    campaign: QueueJobCounts;
    events: QueueJobCounts;
  };
  deadLetter: {
    recentFailedTransactional: FailedJobSummary[];
    recentFailedCampaign: FailedJobSummary[];
  };
  timestamp: string;
}

const EMPTY_COUNTS: QueueJobCounts = { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 };

async function safeJobCounts(queue: PostgresJobQueue<unknown>): Promise<QueueJobCounts> {
  try {
    const counts = await queue.getJobCounts("waiting", "active", "completed", "failed", "delayed");
    return {
      waiting: counts.waiting || 0,
      active: counts.active || 0,
      completed: counts.completed || 0,
      failed: counts.failed || 0,
      delayed: counts.delayed || 0,
    };
  } catch (err) {
    logger.warn("[QueueHealth] Failed to get queue counts:", err instanceof Error ? err.message : String(err));
    return { ...EMPTY_COUNTS };
  }
}

async function recentFailedJobs(queue: PostgresJobQueue<unknown>): Promise<FailedJobSummary[]> {
  try {
    const failed = await queue.getFailed(0, 4);
    return failed.map((job) => ({
      id: job.id,
      name: job.name,
      failedReason: redactSecrets(job.failedReason) || "Unknown failure",
      attemptsMade: job.attemptsMade,
      failedTimestamp: job.finishedOn,
    }));
  } catch {
    return [];
  }
}

export async function getEmailQueueHealth(): Promise<EmailQueueHealthReport> {
  let postgresConnected = false;
  let postgresLatencyMs: number | undefined;
  let postgresError: string | undefined;

  try {
    const start = Date.now();
    await prisma.$queryRawUnsafe("SELECT 1");
    postgresLatencyMs = Date.now() - start;
    postgresConnected = true;
  } catch (err) {
    postgresError = err instanceof Error ? redactSecrets(err.message) : "PostgreSQL connection failed";
    logger.error("[QueueHealth] PostgreSQL ping error", err);
  }

  const transactionalQueue = getTransactionalQueue() as PostgresJobQueue<unknown>;
  const campaignQueue = getCampaignQueue() as PostgresJobQueue<unknown>;
  const eventsQueue = getEventsQueue() as PostgresJobQueue<unknown>;

  const [transactionalCounts, campaignCounts, eventsCounts, failedTransactional, failedCampaign] = postgresConnected
    ? await Promise.all([
        safeJobCounts(transactionalQueue),
        safeJobCounts(campaignQueue),
        safeJobCounts(eventsQueue),
        recentFailedJobs(transactionalQueue),
        recentFailedJobs(campaignQueue),
      ])
    : [{ ...EMPTY_COUNTS }, { ...EMPTY_COUNTS }, { ...EMPTY_COUNTS }, [], []];

  // Processor liveness from job timestamps
  let processor: EmailQueueHealthReport["processor"] = { status: "UNKNOWN" };
  if (postgresConnected) {
    try {
      const now = Date.now();
      const [oldestRunnable, lastActive] = await Promise.all([
        prisma.backgroundJob.findFirst({
          where: { status: BackgroundJobStatus.QUEUED, availableAt: { lte: new Date(now) } },
          orderBy: { availableAt: "asc" },
          select: { availableAt: true },
        }),
        prisma.backgroundJob.findFirst({
          where: { lastAttemptAt: { not: null } },
          orderBy: { lastAttemptAt: "desc" },
          select: { lastAttemptAt: true },
        }),
      ]);
      const oldestAge = oldestRunnable ? now - oldestRunnable.availableAt.getTime() : undefined;
      processor = {
        status: oldestAge !== undefined && oldestAge > PROCESSOR_STALL_THRESHOLD_MS ? "STALLED" : "READY",
        oldestRunnableJobAgeMs: oldestAge,
        lastActivityAt: lastActive?.lastAttemptAt?.toISOString(),
      };
    } catch (err) {
      logger.warn("[QueueHealth] Processor liveness check failed:", err instanceof Error ? err.message : String(err));
    }
  }

  let status: EmailQueueHealthReport["status"] = "HEALTHY";
  if (!postgresConnected) {
    status = "DOWN";
  } else if (
    processor.status === "STALLED" ||
    transactionalCounts.failed > 50 ||
    campaignCounts.failed > 50 ||
    (postgresLatencyMs !== undefined && postgresLatencyMs > 500)
  ) {
    status = "DEGRADED";
  }

  return {
    status,
    postgres: {
      connected: postgresConnected,
      latencyMs: postgresLatencyMs,
      error: postgresError,
    },
    processor,
    queues: {
      transactional: transactionalCounts,
      campaign: campaignCounts,
      events: eventsCounts,
    },
    deadLetter: {
      recentFailedTransactional: failedTransactional,
      recentFailedCampaign: failedCampaign,
    },
    timestamp: new Date().toISOString(),
  };
}
