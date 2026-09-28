/**
 * Distributed, Shared Abuse Protection & Rate Limiting Engine
 *
 * Implements high-throughput, race-safe sliding-window rate limiting backed by Redis.
 * Ensures consistent, deterministic enforcement across multi-instance serverless deployments:
 * - Prevents instance-hopping bypass attacks.
 * - Prevents cross-tenant quota depletion.
 * - Provides per-recipient abuse protection against harassment/denial-of-service.
 * - Enforces strict fail-closed security for critical endpoints (auth, OTP, verification).
 * - Gracefully degrades safely for lower-criticality endpoints during Redis connectivity issues.
 * - Synchronizes with PostgreSQL RateLimit model for auditability and backwards-compatibility.
 */

import { NextRequest, NextResponse } from "next/server";
import { Redis } from "ioredis";
import { prisma } from "./prisma";
import { logger } from "./logger";
import { getRedisConnection } from "./email/queue/connection";

export type RateLimitCriticality = "CRITICAL" | "HIGH" | "STANDARD" | "LOW";

export interface RateLimitResult {
  success: boolean;
  limit: number;
  remaining: number;
  resetSeconds: number;
  failedClosed?: boolean;
  error?: string;
  backend?: "redis" | "postgres" | "memory";
}

export interface RateLimitOptions {
  criticality?: RateLimitCriticality;
  failClosed?: boolean;
  clientIp?: string;
  clientId?: string;
  recipient?: string;
  route?: string;
  syncToDb?: boolean;
}

export interface RateLimitCheckItem {
  identifier: string;
  limit: number;
  windowMs: number;
  criticality?: RateLimitCriticality;
  failClosed?: boolean;
  errorMessage?: string;
  errorCode?: string;
}

export interface MultiRateLimitResult extends RateLimitResult {
  failedCheck?: {
    identifier: string;
    errorCode: string;
    errorMessage: string;
  };
}

// In-memory emergency fallback in case Redis and DB are both unreachable
interface MemoryRecord {
  timestamps: number[];
  resetAt: number;
}
const memoryStore = new Map<string, MemoryRecord>();

// Test overrides
let testRedisClientOverride: Redis | null | undefined = undefined;
let testForceRedisFailure = false;

export function setRateLimiterRedisClient(client: Redis | null | undefined) {
  testRedisClientOverride = client;
}

export function setRateLimiterForceFailure(force: boolean) {
  testForceRedisFailure = force;
}

/**
 * Standard Redis Sliding Window Lua Script
 * Atomically removes expired entries, counts active entries, records new timestamp,
 * and computes exact seconds until the oldest active entry expires.
 */
const SLIDING_WINDOW_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local member = ARGV[4]

local clearBefore = now - window
redis.call('ZREMRANGEBYSCORE', key, 0, clearBefore)
local current = redis.call('ZCARD', key)

if current < limit then
    redis.call('ZADD', key, now, member)
    redis.call('PEXPIRE', key, window)
    local remaining = limit - current - 1
    local resetSeconds = math.ceil(window / 1000)
    return {1, remaining, resetSeconds, current + 1}
else
    local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
    local resetSeconds = math.ceil(window / 1000)
    if oldest and #oldest >= 2 then
        local oldestScore = tonumber(oldest[2])
        local resetMs = math.max(1000, oldestScore + window - now)
        resetSeconds = math.ceil(resetMs / 1000)
    end
    redis.call('PEXPIRE', key, window)
    return {0, 0, resetSeconds, current}
end
`;

/**
 * Normalizes rate limit key with prefix
 */
export function formatRateLimitKey(identifier: string): string {
  if (identifier.startsWith("rl:")) return identifier;
  return `rl:${identifier}`;
}

/**
 * Resolves active Redis connection for rate limiting.
 */
function getRateLimiterRedis(): Redis | null {
  if (testForceRedisFailure) return null;
  if (testRedisClientOverride !== undefined) return testRedisClientOverride;
  try {
    return getRedisConnection();
  } catch (err) {
    logger.warn("[RateLimit] Failed to acquire Redis connection for rate limiting:", err);
    return null;
  }
}

/**
 * Distributed, race-safe atomic rate limiter.
 * Primary: Shared Redis sliding window (sub-millisecond, multi-instance synchronized).
 * Secondary / Failure modes:
 * - CRITICAL: Fails closed to protect security/auth tokens.
 * - HIGH / STANDARD: Falls back to PostgreSQL RateLimit table or emergency memory.
 */
export async function checkRateLimit(
  identifier: string,
  limit: number = 60,
  windowMs: number = 60000,
  options?: RateLimitOptions
): Promise<RateLimitResult> {
  const criticality = options?.criticality || "STANDARD";
  const shouldFailClosed = options?.failClosed ?? (criticality === "CRITICAL");
  const redis = getRateLimiterRedis();

  if (redis && !testForceRedisFailure) {
    try {
      const now = Date.now();
      const member = `${now}:${Math.random().toString(36).substring(2, 9)}`;
      const redisKey = formatRateLimitKey(identifier);

      // Bounded execution timeout: 1500ms max to prevent blocking client HTTP connections
      const evalPromise = redis.eval(
        SLIDING_WINDOW_LUA,
        1,
        redisKey,
        now,
        windowMs,
        limit,
        member
      ) as Promise<[number, number, number, number]>;

      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Redis rate limiter timeout")), 1500)
      );

      const [allowedNum, remaining, resetSeconds, count] = await Promise.race([
        evalPromise,
        timeoutPromise,
      ]);

      const success = allowedNum === 1;

      // Sync to PostgreSQL RateLimit table if requested or if DB is connected
      // (ensures full compatibility with legacy audit queries and verify-phase2 tests)
      if (options?.syncToDb !== false) {
        syncPostgresRateLimit(identifier, count, windowMs).catch((err) => {
          logger.debug?.("[RateLimit] Non-blocking PostgreSQL sync notice:", err?.message);
        });
      }

      return {
        success,
        limit,
        remaining: Math.max(0, remaining),
        resetSeconds: Math.max(1, resetSeconds),
        backend: "redis",
      };
    } catch (err) {
      logger.warn(
        `[RateLimit] Redis error for key '${identifier}' (criticality=${criticality}):`,
        err instanceof Error ? err.message : err
      );

      if (shouldFailClosed) {
        logger.error(
          `[RateLimit:FailClosed] Critical rate limiter failing closed for '${identifier}' due to Redis unavailability.`
        );
        return {
          success: false,
          limit,
          remaining: 0,
          resetSeconds: Math.ceil(windowMs / 1000),
          failedClosed: true,
          error: "RATE_LIMITER_UNAVAILABLE",
          backend: "redis",
        };
      }
    }
  } else if (shouldFailClosed) {
    logger.error(
      `[RateLimit:FailClosed] Critical rate limiter failing closed for '${identifier}' because Redis is offline.`
    );
    return {
      success: false,
      limit,
      remaining: 0,
      resetSeconds: Math.ceil(windowMs / 1000),
      failedClosed: true,
      error: "RATE_LIMITER_UNAVAILABLE",
      backend: "redis",
    };
  }

  // Graceful secondary fallback: PostgreSQL atomic upsert
  try {
    const pgResult = await checkRateLimitPostgres(identifier, limit, windowMs);
    return pgResult;
  } catch (pgErr) {
    logger.warn(
      `[RateLimit] PostgreSQL rate limiting unavailable for '${identifier}', falling back to memory:`,
      pgErr instanceof Error ? pgErr.message : pgErr
    );
  }

  // Final fallback: Local in-process memory
  return checkRateLimitMemory(identifier, limit, windowMs);
}

/**
 * Checks multiple rate limits sequentially.
 * If any check fails, immediately aborts further checks and returns the failure.
 */
export async function checkRateLimits(
  checks: RateLimitCheckItem[],
  defaultOptions?: RateLimitOptions
): Promise<MultiRateLimitResult> {
  for (const check of checks) {
    const res = await checkRateLimit(check.identifier, check.limit, check.windowMs, {
      ...defaultOptions,
      criticality: check.criticality || defaultOptions?.criticality,
      failClosed: check.failClosed || defaultOptions?.failClosed,
    });

    if (!res.success) {
      return {
        ...res,
        failedCheck: {
          identifier: check.identifier,
          errorCode: check.errorCode || "RATE_LIMITED",
          errorMessage:
            check.errorMessage ||
            `Rate limit exceeded for ${check.identifier}. Retry in ${res.resetSeconds} seconds.`,
        },
      };
    }
  }

  const lastCheck = checks[checks.length - 1];
  return {
    success: true,
    limit: lastCheck?.limit || 60,
    remaining: 1,
    resetSeconds: Math.ceil((lastCheck?.windowMs || 60000) / 1000),
    backend: "redis",
  };
}

/**
 * Secondary PostgreSQL RateLimiter
 */
async function checkRateLimitPostgres(
  identifier: string,
  limit: number,
  windowMs: number
): Promise<RateLimitResult> {
  const now = Date.now();
  const resetTimestamp = new Date(now + windowMs);

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
      backend: "postgres",
    };
  }

  throw new Error("Empty result from PostgreSQL rate limit query");
}

/**
 * Asynchronous sync to PostgreSQL RateLimit table to maintain compatibility with DB queries.
 */
async function syncPostgresRateLimit(
  identifier: string,
  count: number,
  windowMs: number
): Promise<void> {
  const resetTimestamp = new Date(Date.now() + windowMs);
  await prisma.$queryRawUnsafe(
    `
    INSERT INTO "RateLimit" ("key", "count", "resetAt", "createdAt", "updatedAt")
    VALUES ($1, $2, $3, NOW(), NOW())
    ON CONFLICT ("key") DO UPDATE
    SET "count" = GREATEST("RateLimit"."count", $2),
        "resetAt" = GREATEST("RateLimit"."resetAt", $3),
        "updatedAt" = NOW();
    `,
    identifier,
    count,
    resetTimestamp
  );
}

/**
 * In-memory fallback rate limiter using sliding timestamps
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
      timestamps: [now],
      resetAt: now + windowMs,
    });
    return {
      success: true,
      limit,
      remaining: limit - 1,
      resetSeconds: Math.ceil(windowMs / 1000),
      backend: "memory",
    };
  }

  // Filter timestamps within the sliding window
  const activeTimestamps = record.timestamps.filter((ts) => ts > now - windowMs);
  record.timestamps = activeTimestamps;

  if (activeTimestamps.length >= limit) {
    const oldest = activeTimestamps[0] || now;
    const resetMs = Math.max(1000, oldest + windowMs - now);
    return {
      success: false,
      limit,
      remaining: 0,
      resetSeconds: Math.max(1, Math.ceil(resetMs / 1000)),
      backend: "memory",
    };
  }

  record.timestamps.push(now);
  record.resetAt = Math.max(record.resetAt, now + windowMs);
  memoryStore.set(identifier, record);

  const oldest = record.timestamps[0] || now;
  const resetMs = Math.max(1000, oldest + windowMs - now);

  return {
    success: true,
    limit,
    remaining: limit - record.timestamps.length,
    resetSeconds: Math.max(1, Math.ceil(resetMs / 1000)),
    backend: "memory",
  };
}

/**
 * Helper to extract client IP safely from request headers
 */
export function getClientIp(req: Request | NextRequest): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first && first !== "::1") return first;
  }
  const realIp = req.headers.get("x-real-ip");
  if (realIp?.trim() && realIp.trim() !== "::1") return realIp.trim();
  return "127.0.0.1";
}

/**
 * Helper to construct standard HTTP 429 / 503 response with Retry-After and rate limit headers
 */
export function rateLimitResponse(
  result: RateLimitResult,
  customMessage?: string,
  customCode: string = "RATE_LIMITED"
): NextResponse {
  const isFailClosed = Boolean(result.failedClosed);
  const status = isFailClosed ? 503 : 429;
  const errorCode = isFailClosed ? "SERVICE_UNAVAILABLE" : customCode;
  const message =
    customMessage ||
    (isFailClosed
      ? "Security rate limiting service unavailable. Request blocked for protection."
      : `Rate limit exceeded. Retry in ${result.resetSeconds} seconds.`);

  return NextResponse.json(
    {
      success: false,
      error: {
        code: errorCode,
        message,
      },
    },
    {
      status,
      headers: {
        "Retry-After": String(result.resetSeconds),
        "X-RateLimit-Limit": String(result.limit),
        "X-RateLimit-Remaining": String(result.remaining),
        "X-RateLimit-Reset": String(result.resetSeconds),
      },
    }
  );
}

/**
 * Inspects rate limiter health and backend status
 */
export async function getRateLimiterHealth(): Promise<{
  status: "HEALTHY" | "DEGRADED" | "DOWN";
  backend: "redis" | "postgres" | "memory";
  redisConnected: boolean;
  latencyMs?: number;
}> {
  const redis = getRateLimiterRedis();
  if (!redis || testForceRedisFailure) {
    return {
      status: "DEGRADED",
      backend: "postgres",
      redisConnected: false,
    };
  }

  try {
    const start = performance.now();
    await redis.ping();
    const latencyMs = Math.round(performance.now() - start);
    return {
      status: "HEALTHY",
      backend: "redis",
      redisConnected: true,
      latencyMs,
    };
  } catch {
    return {
      status: "DEGRADED",
      backend: "postgres",
      redisConnected: false,
    };
  }
}
