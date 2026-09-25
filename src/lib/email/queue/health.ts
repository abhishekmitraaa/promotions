/**
 * BullMQ Queue & Worker Health Monitoring
 *
 * Provides safe operational observability:
 * - Redis connectivity and round-trip ping latency.
 * - Accurate job depth (waiting, active, completed, failed, delayed) per queue.
 * - Redacts Redis credentials completely.
 */

import { Queue } from "bullmq";
import { getRedisConnection, getRedisUrl, sanitizeRedisUrl } from "./connection";
import {
  getTransactionalQueue,
  getCampaignQueue,
  getEventsQueue,
} from "./queues";
import { logger } from "../../logger";

export interface QueueJobCounts {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
}

export interface EmailQueueHealthReport {
  status: "HEALTHY" | "DEGRADED" | "DOWN";
  redis: {
    connected: boolean;
    latencyMs?: number;
    target: string;
    error?: string;
  };
  queues: {
    transactional: QueueJobCounts;
    campaign: QueueJobCounts;
    events: QueueJobCounts;
  };
  timestamp: string;
}

export async function getEmailQueueHealth(): Promise<EmailQueueHealthReport> {
  const safeTarget = sanitizeRedisUrl(getRedisUrl());
  let redisConnected = false;
  let latencyMs: number | undefined;
  let redisError: string | undefined;

  // 1. Check Redis Ping
  try {
    const redis = getRedisConnection();
    const start = Date.now();
    const pong = await redis.ping();
    latencyMs = Date.now() - start;
    redisConnected = pong === "PONG";
  } catch (err) {
    redisError = err instanceof Error ? err.message : "Redis connection failed";
    logger.error("[QueueHealth] Redis ping error:", redisError);
  }

  // Helper to safely get counts
  async function safeJobCounts(queueGetter: () => Queue): Promise<QueueJobCounts> {
    try {
      if (!redisConnected) {
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
      logger.warn("[QueueHealth] Failed to get queue counts:", err);
      return { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 };
    }
  }

  const [transactionalCounts, campaignCounts, eventsCounts] = await Promise.all([
    safeJobCounts(getTransactionalQueue),
    safeJobCounts(getCampaignQueue),
    safeJobCounts(getEventsQueue),
  ]);

  let status: "HEALTHY" | "DEGRADED" | "DOWN" = "HEALTHY";
  if (!redisConnected) {
    status = "DOWN";
  } else if (
    transactionalCounts.failed > 50 ||
    campaignCounts.failed > 50 ||
    (latencyMs && latencyMs > 500)
  ) {
    status = "DEGRADED";
  }

  return {
    status,
    redis: {
      connected: redisConnected,
      latencyMs,
      target: safeTarget,
      error: redisError,
    },
    queues: {
      transactional: transactionalCounts,
      campaign: campaignCounts,
      events: eventsCounts,
    },
    timestamp: new Date().toISOString(),
  };
}
