/**
 * Dedicated Background Email Worker Process
 *
 * Hardened for production multi-instance operation:
 * - Comprehensive startup validation (Redis connectivity, PostgreSQL connectivity, schema tables).
 * - Startup and periodic job reconciliation for abandoned states (stale PROCESSING records).
 * - Multi-queue worker orchestration (transactional, promotional campaigns, promotional deliveries, events).
 * - Distributed worker heartbeats with auto-expiring keys in Redis for cluster visibility.
 * - Real-time telemetry: uptime, job counts, latencies, last success/error.
 * - Resilient Redis disconnect/reconnect event handling.
 * - Graceful shutdown on SIGTERM / SIGINT with bounded drain timeout (15s).
 * - Safe resource cleanup (pausing queues, closing workers, releasing Redis and PostgreSQL connections).
 * - Secret-redacting structured logging.
 *
 * NOTE: DO NOT deploy this worker to Netlify serverless.
 * Deploy as a long-running daemon on AWS ECS, Kubernetes, a dedicated VM, or via PM2 / systemd.
 */

import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

import { createEmailWorker } from "../src/lib/email/queue/worker";
import { createCampaignWorker } from "../src/lib/email/queue/campaign-worker";
import { createEventWorker } from "../src/lib/email/queue/event-worker";
import {
  createWorkerRedisConnection,
  closeRedisConnections,
  getRedisUrl,
  sanitizeRedisUrl,
} from "../src/lib/email/queue/connection";
import { workerLogger } from "../src/lib/email/queue/worker-logger";
import { workerTelemetry } from "../src/lib/email/queue/telemetry";
import { reconcileAbandonedJobs } from "../src/lib/email/queue/reconciliation";
import { prisma } from "../src/lib/prisma";
import type { Worker } from "bullmq";

const SHUTDOWN_TIMEOUT_MS = 15000;
const RECONCILIATION_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Validates dependencies before accepting any jobs:
 * 1. Redis connectivity and latency
 * 2. PostgreSQL connectivity and latency
 * 3. Required database tables existence
 */
async function validateEnvironment(): Promise<void> {
  workerLogger.info("[Startup:Validation] Commencing startup dependency validation...");

  // 1. Redis Ping Check
  const redisUrl = getRedisUrl();
  const safeRedisUrl = sanitizeRedisUrl(redisUrl);
  const testRedis = createWorkerRedisConnection();

  const redisStart = Date.now();
  try {
    const pong = await testRedis.ping();
    const redisLatency = Date.now() - redisStart;
    if (pong !== "PONG") {
      throw new Error(`Unexpected Redis ping response: ${pong}`);
    }
    workerLogger.info(`[Startup:Validation] ✅ Redis reachable (${safeRedisUrl}) - latency: ${redisLatency}ms`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    workerLogger.error(
      `[Startup:Validation] ❌ Redis validation failed for ${safeRedisUrl}: ${msg}`
    );
    throw new Error(`Redis startup validation failed: ${msg}`);
  }

  // 2. PostgreSQL Ping & Table Check
  const dbStart = Date.now();
  try {
    await prisma.$queryRawUnsafe("SELECT 1");
    const dbLatency = Date.now() - dbStart;
    workerLogger.info(`[Startup:Validation] ✅ PostgreSQL reachable - latency: ${dbLatency}ms`);

    // Verify critical tables exist and are queryable
    await prisma.emailDelivery.findFirst({ select: { id: true }, take: 1 });
    await prisma.emailCampaign.findFirst({ select: { id: true }, take: 1 });
    await prisma.emailCampaignRecipient.findFirst({ select: { id: true }, take: 1 });
    await prisma.emailEvent.findFirst({ select: { id: true }, take: 1 });
    await prisma.emailProviderConfig.findFirst({ select: { id: true }, take: 1 });
    workerLogger.info("[Startup:Validation] ✅ Core email schema tables verified successfully");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    workerLogger.error(`[Startup:Validation] ❌ PostgreSQL validation failed: ${msg}`);
    throw new Error(`PostgreSQL startup validation failed: ${msg}`);
  }
}

async function main() {
  const safeUrl = sanitizeRedisUrl(getRedisUrl());
  const workerConcurrency = parseInt(process.env.EMAIL_WORKER_CONCURRENCY || "5", 10);
  const campaignConcurrency = parseInt(
    process.env.EMAIL_CAMPAIGN_CONCURRENCY || String(Math.max(1, Math.floor(workerConcurrency / 2))),
    10
  );
  const eventConcurrency = parseInt(process.env.EMAIL_EVENTS_CONCURRENCY || "10", 10);

  workerLogger.info("=================================================");
  workerLogger.info("🚀 STARTING DEDICATED BULLMQ EMAIL WORKER DAEMON");
  workerLogger.info(`   Worker ID:            ${workerTelemetry.getWorkerId()}`);
  workerLogger.info(`   Redis Target:         ${safeUrl}`);
  workerLogger.info(`   Transactional Workers: ${workerConcurrency}`);
  workerLogger.info(`   Campaign Workers:     ${campaignConcurrency}`);
  workerLogger.info(`   Event Workers:        ${eventConcurrency}`);
  workerLogger.info(`   Node Version:         ${process.version}`);
  workerLogger.info(`   Process PID:          ${process.pid}`);
  workerLogger.info("=================================================");

  // 1. Dependency Validation
  try {
    await validateEnvironment();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    workerLogger.error("FATAL: Startup validation failed. Terminating process immediately.", {
      error: msg,
    });
    process.exit(1);
  }

  // 2. Startup Job Reconciliation
  try {
    workerLogger.info("[Startup:Reconciliation] Running initial recovery check for abandoned jobs...");
    const reconResults = await reconcileAbandonedJobs({
      batchSize: 100,
      staleThresholdMinutes: 10,
    });
    workerLogger.info(
      `[Startup:Reconciliation] Initial recovery complete. Recovered deliveries: ${reconResults.recoveredDeliveries}, Reset recipients: ${reconResults.recoveredRecipients}, Completed campaigns: ${reconResults.completedCampaigns}`
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    workerLogger.warn(
      `[Startup:Reconciliation] Startup reconciliation warning: ${msg}. Proceeding with worker initialization.`
    );
  }

  // 3. Shared connection for telemetry & heartbeats
  const heartbeatRedis = createWorkerRedisConnection();

  // Attach connection lifecycle logging
  heartbeatRedis.on("reconnecting", (delay: number) => {
    workerLogger.warn(`[Redis Lifecycle] Worker connection reconnecting in ${delay}ms...`);
  });
  heartbeatRedis.on("close", () => {
    workerLogger.warn("[Redis Lifecycle] Worker Redis connection closed.");
  });
  heartbeatRedis.on("ready", () => {
    workerLogger.info("[Redis Lifecycle] Worker Redis connection ready.");
  });

  // Start distributed worker heartbeat (every 10s with 30s TTL in Redis)
  workerTelemetry.startHeartbeat(heartbeatRedis, 10000);

  // 4. Initialize BullMQ Workers
  const workers: Worker[] = [];
  try {
    const transactionalWorker = createEmailWorker({ concurrency: workerConcurrency });
    const campaignWorker = createCampaignWorker({ concurrency: campaignConcurrency });
    const eventWorker = createEventWorker({ concurrency: eventConcurrency });

    workers.push(transactionalWorker, campaignWorker, eventWorker);
    workerLogger.info(`[Startup:Workers] All 3 BullMQ workers successfully initialized and listening.`);
  } catch (err: unknown) {
    workerLogger.error("FATAL: Failed to initialize BullMQ workers:", err);
    await workerTelemetry.stopHeartbeat();
    await closeRedisConnections();
    process.exit(1);
  }

  // 5. Periodic Abandoned Job Reconciliation Timer
  const reconciliationTimer = setInterval(async () => {
    try {
      workerLogger.info("[Periodic:Reconciliation] Running periodic check for abandoned jobs...");
      const results = await reconcileAbandonedJobs({
        batchSize: 100,
        staleThresholdMinutes: 10,
      });
      if (
        results.recoveredDeliveries > 0 ||
        results.recoveredRecipients > 0 ||
        results.completedCampaigns > 0
      ) {
        workerLogger.info(
          `[Periodic:Reconciliation] Recovered stale jobs: deliveries=${results.recoveredDeliveries}, recipients=${results.recoveredRecipients}, campaigns=${results.completedCampaigns}`
        );
      }
    } catch (err: unknown) {
      workerLogger.error("[Periodic:Reconciliation] Error during periodic reconciliation:", err);
    }
  }, RECONCILIATION_INTERVAL_MS);

  // Prevent interval from keeping the process alive during shutdown
  reconciliationTimer.unref();

  // 6. Graceful Shutdown Handler
  let isShuttingDown = false;
  async function gracefulShutdown(signal: string) {
    if (isShuttingDown) return;
    isShuttingDown = true;

    workerLogger.info(
      `[Shutdown] Received ${signal}. Initiating graceful shutdown (timeout: ${SHUTDOWN_TIMEOUT_MS}ms)...`
    );

    // Force exit timer if drain hangs
    const forceExitTimer = setTimeout(() => {
      workerLogger.error("[Shutdown] Forcefully terminating worker after timeout expiration.");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExitTimer.unref();

    try {
      // Clear timers
      clearInterval(reconciliationTimer);

      // Stop publishing heartbeats
      await workerTelemetry.stopHeartbeat();

      // Pause accepting new jobs from all queues
      workerLogger.info("[Shutdown] Pausing all BullMQ workers...");
      await Promise.allSettled(workers.map((w) => w.pause()));

      // Close all workers and await in-flight job drain
      workerLogger.info("[Shutdown] Awaiting in-flight job completion...");
      await Promise.allSettled(workers.map((w) => w.close()));

      // Disconnect Redis
      workerLogger.info("[Shutdown] Closing Redis connections...");
      await closeRedisConnections();

      // Disconnect Prisma
      workerLogger.info("[Shutdown] Disconnecting PostgreSQL client...");
      await prisma.$disconnect();

      clearTimeout(forceExitTimer);
      workerLogger.info("[Shutdown] All resources released cleanly. Worker shutdown complete.");
      process.exit(0);
    } catch (err: unknown) {
      workerLogger.error("[Shutdown] Error occurred during graceful shutdown:", err);
      process.exit(1);
    }
  }

  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));

  process.on("uncaughtException", (err) => {
    workerLogger.error("[Process:UncaughtException] Fatal unhandled exception:", err);
    gracefulShutdown("uncaughtException");
  });

  process.on("unhandledRejection", (reason) => {
    workerLogger.error("[Process:UnhandledRejection] Fatal unhandled promise rejection:", reason);
  });
}

main().catch((err) => {
  workerLogger.error("Fatal error starting email worker:", err);
  process.exit(1);
});
