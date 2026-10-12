/**
 * Shared Abuse Protection & Rate Limiting Engine (PostgreSQL)
 *
 * Fixed-window counters in the PostgreSQL RateLimit table, updated with a single atomic upsert,
 * so limits hold across every serverless instance:
 * - Prevents instance-hopping bypass attacks.
 * - Prevents cross-tenant quota depletion.
 * - Provides per-recipient abuse protection against harassment/denial-of-service.
 * - Fails closed for critical endpoints (auth, OTP, verification) when the database is unavailable.
 * - Degrades to a per-instance memory limiter for lower-criticality endpoints during outages.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "./prisma";
import { logger } from "./logger";

export type RateLimitCriticality = "CRITICAL" | "HIGH" | "STANDARD" | "LOW";

export interface RateLimitResult {
  success: boolean;
  limit: number;
  remaining: number;
  resetSeconds: number;
  failedClosed?: boolean;
  error?: string;
  backend?: "postgres" | "memory";
}

export interface RateLimitOptions {
  criticality?: RateLimitCriticality;
  failClosed?: boolean;
  clientIp?: string;
  clientId?: string;
  recipient?: string;
  route?: string;
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

// In-memory emergency fallback for non-critical limits when the database is unreachable
interface MemoryRecord {
  timestamps: number[];
  resetAt: number;
}
const memoryStore = new Map<string, MemoryRecord>();

// Test hook: simulate the database limiter being unavailable
let testForceBackendFailure = false;

export function setRateLimiterForceFailure(force: boolean) {
  testForceBackendFailure = force;
}

/**
 * Race-safe rate limiter.
 * Primary: PostgreSQL atomic fixed-window counter (shared across instances).
 * On database failure:
 * - CRITICAL (or failClosed): request is refused (503) rather than unprotected.
 * - Otherwise: per-instance memory limiter.
 */
export async function checkRateLimit(
  identifier: string,
  limit: number = 60,
  windowMs: number = 60000,
  options?: RateLimitOptions
): Promise<RateLimitResult> {
  const criticality = options?.criticality || "STANDARD";
  const shouldFailClosed = options?.failClosed ?? (criticality === "CRITICAL");

  try {
    if (testForceBackendFailure) {
      throw new Error("Simulated rate limiter backend failure");
    }
    return await checkRateLimitPostgres(identifier, limit, windowMs);
  } catch (pgErr) {
    logger.warn(
      `[RateLimit] PostgreSQL rate limiting unavailable for '${identifier}' (criticality=${criticality}):`,
      pgErr instanceof Error ? pgErr.message : pgErr
    );
    if (shouldFailClosed) {
      logger.error(`[RateLimit:FailClosed] Critical rate limiter failing closed for '${identifier}'.`);
      // Per-instance memory is not a safe limiter for auth/OTP endpoints on serverless.
      return {
        success: false,
        limit,
        remaining: 0,
        resetSeconds: Math.ceil(windowMs / 1000),
        failedClosed: true,
        error: "RATE_LIMITER_UNAVAILABLE",
        backend: "postgres",
      };
    }
  }

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
    backend: "postgres",
  };
}

/**
 * PostgreSQL fixed-window rate limiter (single atomic upsert)
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
  status: "HEALTHY" | "DOWN";
  backend: "postgres";
  latencyMs?: number;
}> {
  if (testForceBackendFailure) {
    return { status: "DOWN", backend: "postgres" };
  }
  try {
    const start = performance.now();
    await prisma.$queryRawUnsafe("SELECT 1");
    return { status: "HEALTHY", backend: "postgres", latencyMs: Math.round(performance.now() - start) };
  } catch {
    return { status: "DOWN", backend: "postgres" };
  }
}
