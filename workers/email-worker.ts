/**
 * Dedicated Background Email Worker Process
 *
 * Runs as a standalone Node.js process separate from Next.js web application:
 * - Listens on BullMQ queues.
 * - Handles graceful termination (SIGTERM, SIGINT).
 * - Disconnects Redis connections safely on shutdown.
 * - Suitable for Docker, Kubernetes, AWS ECS, or PM2 deployment.
 */

import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

import { createEmailWorker } from "../src/lib/email/queue/worker";
import { createCampaignWorker } from "../src/lib/email/queue/campaign-worker";
import { createEventWorker } from "../src/lib/email/queue/event-worker";
import { closeRedisConnections, getRedisUrl, sanitizeRedisUrl } from "../src/lib/email/queue/connection";
import { logger } from "../src/lib/logger";

async function main() {
  const safeUrl = sanitizeRedisUrl(getRedisUrl());
  const concurrency = parseInt(process.env.EMAIL_WORKER_CONCURRENCY || "5", 10);

  logger.info("=================================================");
  logger.info("🚀 STARTING DEDICATED BULLMQ EMAIL WORKERS");
  logger.info(`   Redis Target: ${safeUrl}`);
  logger.info(`   Concurrency:  ${concurrency}`);
  logger.info(`   Node Version: ${process.version}`);
  logger.info("=================================================");

  const transactionalWorker = createEmailWorker({ concurrency });
  const campaignWorker = createCampaignWorker({ concurrency });
  const eventWorker = createEventWorker({ concurrency });

  let isShuttingDown = false;
  async function gracefulShutdown(signal: string) {
    if (isShuttingDown) return;
    isShuttingDown = true;

    logger.info(`Received ${signal}. Shutting down BullMQ email workers gracefully...`);

    try {
      await Promise.allSettled([
        transactionalWorker.close(),
        campaignWorker.close(),
        eventWorker.close(),
      ]);
      await closeRedisConnections();
      logger.info("Email workers closed and Redis connections released cleanly. Exiting.");
      process.exit(0);
    } catch (err) {
      logger.error("Error during graceful shutdown:", err);
      process.exit(1);
    }
  }

  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
}

main().catch((err) => {
  logger.error("Fatal error starting email worker:", err);
  process.exit(1);
});
