/**
 * Centralized Redis Connection Management for Email Queues
 *
 * Implements hardened connection handling for BullMQ:
 * - Validates REDIS_URL strictly.
 * - Redacts credentials from all logs and error messages.
 * - Provides worker-specific connection settings (maxRetriesPerRequest: null).
 * - Implements connection reuse (singleton for producers, managed factories for workers).
 * - Prevents uncontrolled connection proliferation across serverless/worker runtimes.
 */

import { Redis, RedisOptions } from "ioredis";
import { logger } from "../../logger";

/**
 * Sanitizes a Redis connection URL to strip passwords/credentials before logging.
 * Example: 'redis://:supersecret@127.0.0.1:6379/0' -> 'redis://:***@127.0.0.1:6379/0'
 */
export function sanitizeRedisUrl(rawUrl: string): string {
  if (!rawUrl || typeof rawUrl !== "string") return "";
  try {
    const parsed = new URL(rawUrl);
    if (parsed.password) parsed.password = "***";
    if (parsed.username) parsed.username = "***";
    return parsed.toString();
  } catch {
    // If URL parsing fails, mask any :password@ patterns
    return rawUrl.replace(/:([^@]+)@/, ":***@");
  }
}

/**
 * Validates and retrieves the Redis connection URL from environment.
 */
export function getRedisUrl(): string {
  const url = process.env.REDIS_URL || "redis://127.0.0.1:6379";
  if (!url.startsWith("redis://") && !url.startsWith("rediss://")) {
    throw new Error(
      `Invalid REDIS_URL protocol: '${sanitizeRedisUrl(url)}'. Must start with redis:// or rediss://`
    );
  }
  return url;
}

const DEFAULT_REDIS_OPTIONS: RedisOptions = {
  connectTimeout: 10000,
  enableReadyCheck: false,
  autoResubscribe: true,
  lazyConnect: true,
  retryStrategy(times: number) {
    if (times > 10) {
      logger.error(`Redis reconnection failed after ${times} attempts. Giving up.`);
      return null; // Stop reconnecting
    }
    // Exponential backoff with jitter (100ms, 200ms, 400ms... Up to 3000ms)
    const delay = Math.min(times * 100 * Math.pow(1.5, times), 3000);
    const jitter = Math.floor(Math.random() * 200);
    return delay + jitter;
  },
};

// Singleton Redis instance for Queue producers
let producerConnection: Redis | null = null;
const workerConnections: Set<Redis> = new Set();

/**
 * Obtains the shared Redis connection for BullMQ Queue producers.
 */
export function getRedisConnection(customUrl?: string): Redis {
  if (producerConnection) {
    return producerConnection;
  }

  const url = customUrl || getRedisUrl();
  const safeUrl = sanitizeRedisUrl(url);

  producerConnection = new Redis(url, {
    ...DEFAULT_REDIS_OPTIONS,
    maxRetriesPerRequest: 3, // Bounded retries for queue producers
  });

  producerConnection.on("error", (err) => {
    logger.error(`[Redis Producer Error] [${safeUrl}]:`, err?.message || err);
  });

  producerConnection.on("connect", () => {
    logger.info(`[Redis Producer] Connected successfully to ${safeUrl}`);
  });

  return producerConnection;
}

/**
 * Creates a dedicated Redis connection for BullMQ Workers.
 * BullMQ requires workers to have maxRetriesPerRequest: null.
 */
export function createWorkerRedisConnection(customUrl?: string): Redis {
  const url = customUrl || getRedisUrl();
  const safeUrl = sanitizeRedisUrl(url);

  const client = new Redis(url, {
    ...DEFAULT_REDIS_OPTIONS,
    maxRetriesPerRequest: null, // Required by BullMQ workers
  });

  client.on("error", (err) => {
    logger.error(`[Redis Worker Error] [${safeUrl}]:`, err?.message || err);
  });

  workerConnections.add(client);
  return client;
}

/**
 * Gracefully disconnects all tracked Redis clients.
 */
export async function closeRedisConnections(): Promise<void> {
  const closePromises: Promise<unknown>[] = [];

  if (producerConnection) {
    closePromises.push(
      producerConnection.quit().catch(() => producerConnection?.disconnect())
    );
    producerConnection = null;
  }

  for (const client of workerConnections) {
    closePromises.push(client.quit().catch(() => client.disconnect()));
  }
  workerConnections.clear();

  await Promise.allSettled(closePromises);
}
