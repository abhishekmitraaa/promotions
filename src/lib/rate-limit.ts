import { prisma } from "./prisma";
import { logger } from "./logger";

export interface RateLimitResult {
  success: boolean;
  limit: number;
  remaining: number;
  resetSeconds: number;
}

// In-memory fallback in case of transient DB disconnection
interface MemoryRecord {
  count: number;
  resetAt: number;
}
const memoryStore = new Map<string, MemoryRecord>();

/**
 * Distributed, race-safe atomic rate limiter backed by PostgreSQL RateLimit table.
 * Uses atomic INSERT ... ON CONFLICT DO UPDATE to ensure strict concurrency safety
 * across serverless execution contexts.
 */
export async function checkRateLimit(
  identifier: string,
  limit: number = 60,
  windowMs: number = 60000
): Promise<RateLimitResult> {
  const now = Date.now();
  const resetTimestamp = new Date(now + windowMs);

  try {
    const result: { count: number; resetAt: Date }[] = await prisma.$queryRawUnsafe(
      `
      INSERT INTO "RateLimit" ("key", "count", "resetAt", "createdAt", "updatedAt")
      VALUES ($1, 1, $2, NOW(), NOW())
      ON CONFLICT ("key") DO UPDATE
      SET "count" = CASE
            WHEN "RateLimit"."resetAt" < NOW() THEN 1
            ELSE "RateLimit"."count" + 1
          END,
          "resetAt" = CASE
            WHEN "RateLimit"."resetAt" < NOW() THEN $2
            ELSE "RateLimit"."resetAt"
          END,
          "updatedAt" = NOW()
      RETURNING "count", "resetAt";
      `,
      identifier,
      resetTimestamp
    );

    if (result && result.length > 0) {
      const { count, resetAt } = result[0];
      const resetSeconds = Math.max(1, Math.ceil((new Date(resetAt).getTime() - now) / 1000));
      const remaining = Math.max(0, limit - count);

      return {
        success: count <= limit,
        limit,
        remaining,
        resetSeconds,
      };
    }
  } catch (err) {
    logger.warn("Database rate limiting unavailable, falling back to local memory limiter:", err);
  }

  // Graceful in-memory fallback
  return checkRateLimitMemory(identifier, limit, windowMs);
}

/**
 * In-memory fallback rate limiter
 */
export function checkRateLimitMemory(
  identifier: string,
  limit: number = 60,
  windowMs: number = 60000
): RateLimitResult {
  const now = Date.now();
  const record = memoryStore.get(identifier);

  if (!record || now > record.resetAt) {
    memoryStore.set(identifier, {
      count: 1,
      resetAt: now + windowMs,
    });
    return {
      success: true,
      limit,
      remaining: limit - 1,
      resetSeconds: Math.ceil(windowMs / 1000),
    };
  }

  if (record.count >= limit) {
    return {
      success: false,
      limit,
      remaining: 0,
      resetSeconds: Math.max(1, Math.ceil((record.resetAt - now) / 1000)),
    };
  }

  record.count += 1;
  memoryStore.set(identifier, record);

  return {
    success: true,
    limit,
    remaining: limit - record.count,
    resetSeconds: Math.max(1, Math.ceil((record.resetAt - now) / 1000)),
  };
}
