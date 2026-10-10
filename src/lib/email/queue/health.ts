/**
 * BullMQ Queue & Worker Health Monitoring
 *
 * Provides comprehensive operational observability:
 * - Redis connectivity and round-trip ping latency.
 * - PostgreSQL connectivity and round-trip query latency.
 * - Live worker heartbeats and process telemetry.
 * - Accurate job depth (waiting, active, completed, failed, delayed) per queue.
 * - Dead-letter visibility: inspection of recent failed jobs.
 * - Complete redaction of Redis passwords, DB credentials, and sensitive payload tokens.
 */

import { Queue } from "bullmq";
import { getRedisConnection, getRedisUrl, sanitizeRedisUrl } from "./connection";
import {
  getTransactionalQueue,
  getCampaignQueue,
  getEventsQueue,
  isWorkerlessMode,
} from "./queues";
import { prisma } from "../../prisma";
import { workerLogger, sanitizeLogValue } from "./worker-logger";
import { getActiveWorkerHeartbeats, workerTelemetry, WorkerTelemetrySnapshot } from "./telemetry";

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
  redis: {
    connected: boolean;
    latencyMs?: number;
    target: string;
    error?: string;
  };
  postgres: {
    connected: boolean;
    latencyMs?: number;
    error?: string;
  };
  workers: {
    activeWorkerCount: number;
    cluster: WorkerTelemetrySnapshot[];
    localTelemetry: WorkerTelemetrySnapshot;
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

export async function getEmailQueueHealth(): Promise<EmailQueueHealthReport> {
  const isWorkerless = isWorkerlessMode();
  const safeTarget = isWorkerless ? "workerless (PostgreSQL backed)" : sanitizeRedisUrl(getRedisUrl());
  let redisConnected = false;
  let redisLatencyMs: number | undefined;
  let redisError: string | undefined;

  let postgresConnected = false;
  let postgresLatencyMs: number | undefined;
  let postgresError: string | undefined;

  // 1. Check Redis Ping
  try {
    const redis = getRedisConnection();
    const start = Date.now();
    const pong = await redis.ping();
    redisLatencyMs = Date.now() - start;
    redisConnected = pong === "PONG";
  } catch (err) {
    redisConnected = false;
    if (!isWorkerless) {
      redisError = err instanceof Error ? err.message : "Redis connection failed";
      workerLogger.error("[QueueHealth] Redis ping error", err);
    }
  }

  // 2. Check PostgreSQL Ping
  try {
    const start = Date.now();
    await prisma.$queryRawUnsafe("SELECT 1");
    postgresLatencyMs = Date.now() - start;
    postgresConnected = true;
  } catch (err) {
    postgresError = err instanceof Error ? err.message : "PostgreSQL connection failed";
    workerLogger.error("[QueueHealth] PostgreSQL ping error", err);
  }

  // 3. Helper to safely get counts
  async function safeJobCounts(queueGetter: () => Queue): Promise<QueueJobCounts> {
    try {
      if (!isWorkerless && !redisConnected) {
        return { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 };
      }
      const queue = queueGetter();
      const counts = await queue.getJobCounts(
        "waiting",
        "active",
        "completed",
        "failed",
        "delayed"
      );
      return {
        waiting: counts.waiting || 0,
        active: counts.active || 0,
        completed: counts.completed || 0,
        failed: counts.failed || 0,
        delayed: counts.delayed || 0,
      };
    } catch (err) {
      workerLogger.warn("[QueueHealth] Failed to get queue counts", {
        error: err instanceof Error ? err.message : String(err),
      });
      return { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 };
    }
  }

  // 4. Helper to inspect recent failed jobs (dead-letter visibility)
  async function getRecentFailedJobs(queueGetter: () => Queue): Promise<FailedJobSummary[]> {
    try {
      if (!isWorkerless && !redisConnected) return [];
      const queue = queueGetter();
      const failed = await queue.getFailed(0, 4); // Latest 5 failed jobs
      return failed.map((job) => ({
        id: job.id || "unknown",
        name: job.name,
        failedReason: (sanitizeLogValue("failedReason", job.failedReason) as string) || "Unknown failure",
        attemptsMade: job.attemptsMade,
        failedTimestamp: job.finishedOn,
      }));
    } catch {
      return [];
    }
  }

  const [transactionalCounts, campaignCounts, eventsCounts] = await Promise.all([
    safeJobCounts(getTransactionalQueue),
    safeJobCounts(getCampaignQueue),
    safeJobCounts(getEventsQueue),
  ]);

  const [failedTransactional, failedCampaign] = await Promise.all([
    getRecentFailedJobs(getTransactionalQueue),
    getRecentFailedJobs(getCampaignQueue),
  ]);

  // 5. Query active worker heartbeats from Redis
  let activeClusterWorkers: WorkerTelemetrySnapshot[] = [];
  if (redisConnected) {
    try {
      const redis = getRedisConnection();
      activeClusterWorkers = await getActiveWorkerHeartbeats(redis);
    } catch {
      activeClusterWorkers = [];
    }
  }

  const localTelemetry = workerTelemetry.getSnapshot();

  // 6. Overall Status Determination
  let status: "HEALTHY" | "DEGRADED" | "DOWN" = "HEALTHY";
  if (!postgresConnected || (!isWorkerless && !redisConnected)) {
    status = "DOWN";
  } else if (
    transactionalCounts.failed > 50 ||
    campaignCounts.failed > 50 ||
    (!isWorkerless && redisLatencyMs && redisLatencyMs > 500) ||
    (postgresLatencyMs && postgresLatencyMs > 500)
  ) {
    status = "DEGRADED";
  }

  return {
    status,
    redis: {
      connected: redisConnected,
      latencyMs: redisLatencyMs,
      target: safeTarget,
      error: redisError,
    },
    postgres: {
      connected: postgresConnected,
      latencyMs: postgresLatencyMs,
      error: postgresError,
    },
    workers: {
      activeWorkerCount: activeClusterWorkers.length,
      cluster: activeClusterWorkers,
      localTelemetry,
    },
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
