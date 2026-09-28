/**
 * Distributed Shared Rate Limiting & Abuse Protection Test Suite
 *
 * Verifies:
 * 1. Multi-instance concurrency safety across distributed serverless runtimes.
 * 2. Strict tenant quota isolation (Tenant A cannot consume Tenant B's quota).
 * 3. Instance-hopping defense (IP-aware rate limits persist across instances).
 * 4. Per-recipient abuse protection (harassment & spam prevention).
 * 5. Redis failure modes (fail-closed for CRITICAL endpoints, safe degradation for standard).
 * 6. Standardized HTTP 429/503 headers (Retry-After, X-RateLimit-*).
 * 7. End-to-end API integration tests.
 */

import assert from "node:assert/strict";
import { Redis } from "ioredis";
import { prisma } from "../src/lib/prisma";
import {
  checkRateLimit,
  setRateLimiterRedisClient,
  setRateLimiterForceFailure,
  getClientIp,
  rateLimitResponse,
  getRateLimiterHealth,
} from "../src/lib/rate-limit";
import { NextRequest } from "next/server";

const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";

async function main() {
  console.log("\n========================================================");
  console.log("  DISTRIBUTED RATE LIMITER & MULTI-INSTANCE ABUSE SUITE");
  console.log("========================================================\n");

  const runId = `rl_test_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

  // ---------------------------------------------------------------------------
  // [1] Health Check & Connectivity
  // ---------------------------------------------------------------------------
  console.log("-> [Step 1] Verifying Rate Limiter Health & Redis Backend...");
  const health = await getRateLimiterHealth();
  assert.equal(health.status, "HEALTHY", "Rate limiter health should be HEALTHY");
  assert.equal(health.backend, "redis", "Rate limiter backend should be Redis");
  assert.equal(health.redisConnected, true, "Redis should be connected");
  console.log(`  [PASS] Rate limiter is healthy (latency: ${health.latencyMs}ms).`);

  // ---------------------------------------------------------------------------
  // [2] Multi-Instance Concurrency Safety Simulation
  // ---------------------------------------------------------------------------
  console.log("-> [Step 2] Testing Multi-Instance Concurrency (4 Simulated Serverless Nodes)...");
  // Instantiate 4 distinct Redis client connections to simulate 4 serverless instances
  const instance1 = new Redis(REDIS_URL);
  const instance2 = new Redis(REDIS_URL);
  const instance3 = new Redis(REDIS_URL);
  const instance4 = new Redis(REDIS_URL);
  const instances = [instance1, instance2, instance3, instance4];

  const concurrentKey = `concurrent_${runId}`;
  const CONCURRENT_LIMIT = 10;
  const TOTAL_REQUESTS = 40;

  // Fire 40 simultaneous requests randomly distributed across all 4 instances
  const promises = Array.from({ length: TOTAL_REQUESTS }, async (_, i) => {
    const selectedInstance = instances[i % instances.length];
    setRateLimiterRedisClient(selectedInstance);
    return checkRateLimit(concurrentKey, CONCURRENT_LIMIT, 60000);
  });

  const results = await Promise.all(promises);
  setRateLimiterRedisClient(undefined); // Reset to default

  const successfulRequests = results.filter((r) => r.success);
  const rejectedRequests = results.filter((r) => !r.success);

  assert.equal(
    successfulRequests.length,
    CONCURRENT_LIMIT,
    `Exactly ${CONCURRENT_LIMIT} requests must succeed under concurrent multi-instance load`
  );
  assert.equal(
    rejectedRequests.length,
    TOTAL_REQUESTS - CONCURRENT_LIMIT,
    `Remaining ${TOTAL_REQUESTS - CONCURRENT_LIMIT} requests must be rejected with 429`
  );

  // Verify that all rejected requests received valid positive retry seconds
  for (const rejected of rejectedRequests) {
    assert(rejected.resetSeconds > 0, "Rejected request must return positive resetSeconds");
    assert.equal(rejected.remaining, 0, "Rejected request must report 0 remaining");
  }
  console.log(
    `  [PASS] Concurrency verified: exactly ${successfulRequests.length}/${TOTAL_REQUESTS} allowed across 4 instances.`
  );

  // ---------------------------------------------------------------------------
  // [3] Cross-Tenant Quota Isolation
  // ---------------------------------------------------------------------------
  console.log("-> [Step 3] Testing Cross-Tenant Quota Isolation...");
  const tenantA = `tenant_alpha_${runId}`;
  const tenantB = `tenant_beta_${runId}`;
  const tenantLimit = 5;

  // Exhaust Tenant A's quota
  for (let i = 0; i < tenantLimit; i++) {
    const r = await checkRateLimit(`rl:tenant:${tenantA}:send`, tenantLimit, 60000);
    assert.equal(r.success, true, `Tenant A request ${i + 1} should succeed`);
  }
  const tenantAExhausted = await checkRateLimit(`rl:tenant:${tenantA}:send`, tenantLimit, 60000);
  assert.equal(tenantAExhausted.success, false, "Tenant A must be rate-limited after exhausting quota");

  // Verify Tenant B has full quota unaffected by Tenant A
  const tenantBFirstReq = await checkRateLimit(`rl:tenant:${tenantB}:send`, tenantLimit, 60000);
  assert.equal(tenantBFirstReq.success, true, "Tenant B must not be affected by Tenant A's exhausted quota");
  assert.equal(tenantBFirstReq.remaining, tenantLimit - 1, "Tenant B must have full remaining quota");
  console.log("  [PASS] Tenant isolation verified: Tenant A depletion does not affect Tenant B.");

  // ---------------------------------------------------------------------------
  // [4] Instance-Hopping Defense (IP Persistence)
  // ---------------------------------------------------------------------------
  console.log("-> [Step 4] Testing Instance-Hopping Defense (Shared IP State across Instances)...");
  const attackerIp = `198.51.100.${Math.floor(Math.random() * 200) + 1}`;
  const ipLimitKey = `rl:ip:${attackerIp}:${runId}`;
  const ipLimit = 3;

  // Instance 1 consumes quota
  setRateLimiterRedisClient(instance1);
  for (let i = 0; i < ipLimit; i++) {
    const r = await checkRateLimit(ipLimitKey, ipLimit, 60000);
    assert.equal(r.success, true, `Instance 1 request ${i + 1} should succeed`);
  }

  // Attacker hops to Instance 2
  setRateLimiterRedisClient(instance2);
  const hopInstance2 = await checkRateLimit(ipLimitKey, ipLimit, 60000);
  assert.equal(hopInstance2.success, false, "Instance 2 must block attacker hopping from Instance 1");

  // Attacker hops to Instance 3
  setRateLimiterRedisClient(instance3);
  const hopInstance3 = await checkRateLimit(ipLimitKey, ipLimit, 60000);
  assert.equal(hopInstance3.success, false, "Instance 3 must block attacker hopping from Instance 2");

  setRateLimiterRedisClient(undefined);
  console.log("  [PASS] Instance-hopping defense verified: IP counter is durable across instances.");

  // ---------------------------------------------------------------------------
  // [5] Per-Recipient Abuse Protection
  // ---------------------------------------------------------------------------
  console.log("-> [Step 5] Testing Per-Recipient Abuse Protection...");
  const victimRecipient = `victim_${runId}@example.test`;
  const innocentRecipient = `innocent_${runId}@example.test`;
  const rcptLimit = 3;

  // Send 3 emails to victim -> reaches limit
  for (let i = 0; i < rcptLimit; i++) {
    const r = await checkRateLimit(`rl:rcpt:${tenantA}:${victimRecipient}:email_send`, rcptLimit, 60000);
    assert.equal(r.success, true, `Send ${i + 1} to victim should succeed`);
  }

  // 4th send to victim blocked
  const victimBlocked = await checkRateLimit(
    `rl:rcpt:${tenantA}:${victimRecipient}:email_send`,
    rcptLimit,
    60000
  );
  assert.equal(victimBlocked.success, false, "Further sends to victim must be blocked by abuse protection");

  // Send to innocent recipient must still succeed
  const innocentAllowed = await checkRateLimit(
    `rl:rcpt:${tenantA}:${innocentRecipient}:email_send`,
    rcptLimit,
    60000
  );
  assert.equal(innocentAllowed.success, true, "Sends to innocent recipient must succeed");
  console.log("  [PASS] Per-recipient abuse protection verified.");

  // ---------------------------------------------------------------------------
  // [6] Redis Failure Modes & Criticality Tiers
  // ---------------------------------------------------------------------------
  console.log("-> [Step 6] Testing Redis Failure Modes (Critical vs Standard Tiers)...");

  // Force Redis failure simulation
  setRateLimiterForceFailure(true);

  // 6a. CRITICAL endpoint (Auth/OTP/Verification) MUST FAIL CLOSED
  const criticalResult = await checkRateLimit(`login_test_${runId}`, 10, 60000, {
    criticality: "CRITICAL",
    failClosed: true,
  });
  assert.equal(criticalResult.success, false, "CRITICAL endpoint must FAIL CLOSED when Redis is down");
  assert.equal(criticalResult.failedClosed, true, "failedClosed flag must be set to true");
  assert.equal(criticalResult.error, "RATE_LIMITER_UNAVAILABLE", "Error code must indicate unavailability");

  // Construct response and verify 503 Service Unavailable with Retry-After header
  const criticalHttpRes = rateLimitResponse(criticalResult);
  assert.equal(criticalHttpRes.status, 503, "Fail-closed response must return HTTP 503 Service Unavailable");
  assert(criticalHttpRes.headers.get("Retry-After") !== null, "Retry-After header must be present on 503");

  // 6b. STANDARD / LOW endpoint DEGRADES SAFELY to secondary backend (Postgres/Memory)
  const standardResult = await checkRateLimit(`webhook_test_${runId}`, 100, 60000, {
    criticality: "LOW",
    failClosed: false,
  });
  assert.equal(standardResult.success, true, "LOW/STANDARD endpoint must degrade safely without failing");
  assert(
    standardResult.backend === "postgres" || standardResult.backend === "memory",
    "Degraded backend must be postgres or memory"
  );

  // Restore Redis
  setRateLimiterForceFailure(false);
  const restoredResult = await checkRateLimit(`restored_test_${runId}`, 10, 60000);
  assert.equal(restoredResult.success, true, "Rate limiter recovers when Redis is restored");
  assert.equal(restoredResult.backend, "redis", "Backend recovers to Redis");
  console.log("  [PASS] Redis failure behavior verified: Critical fail-closed, Standard safe degradation.");

  // ---------------------------------------------------------------------------
  // [7] Standardized HTTP Headers & Retry-After
  // ---------------------------------------------------------------------------
  console.log("-> [Step 7] Testing Standardized Rate Limit Headers...");
  const fakeRateLimitResult = {
    success: false,
    limit: 60,
    remaining: 0,
    resetSeconds: 42,
  };
  const http429 = rateLimitResponse(fakeRateLimitResult, "Custom rate limit message", "RATE_LIMITED");
  assert.equal(http429.status, 429, "Status must be 429");
  assert.equal(http429.headers.get("Retry-After"), "42", "Retry-After must equal resetSeconds");
  assert.equal(http429.headers.get("X-RateLimit-Limit"), "60", "X-RateLimit-Limit must equal limit");
  assert.equal(http429.headers.get("X-RateLimit-Remaining"), "0", "X-RateLimit-Remaining must equal remaining");
  assert.equal(http429.headers.get("X-RateLimit-Reset"), "42", "X-RateLimit-Reset must equal resetSeconds");
  console.log("  [PASS] Standardized headers verified (Retry-After, X-RateLimit-*).");

  // ---------------------------------------------------------------------------
  // [8] End-to-End API Route Protection Verification
  // ---------------------------------------------------------------------------
  console.log("-> [Step 8] Testing End-to-End API Routes with Hardened Abuse Protection...");

  // Create clean test tenant & API key
  const testTenant = await prisma.apiClient.create({
    data: {
      name: `RateLimit Tenant ${runId}`,
    },
  });

  const { generateApiKey } = await import("../src/lib/crypto");
  const { rawKey, keyPrefix, keyHash } = generateApiKey();
  const testApiKey = await prisma.apiKey.create({
    data: {
      clientId: testTenant.id,
      name: "RateLimit Key",
      keyPrefix,
      keyHash,
    },
  });

  // 8a. Test v1/email/send Recipient Abuse Protection
  const emailSendRoute = await import("../src/app/api/v1/email/send/route");
  const victimEmail = `victim_e2e_${runId}@example.test`;

  function makeSendReq(body: Record<string, unknown>, ip: string = "192.0.2.1") {
    return new NextRequest("http://localhost:3000/api/v1/email/send", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${rawKey}`,
        "x-forwarded-for": ip,
      },
      body: JSON.stringify(body),
    });
  }

  // Pre-exhaust the recipient rate limit for victimEmail
  for (let i = 0; i < 10; i++) {
    await checkRateLimit(`rl:rcpt:${testTenant.id}:${victimEmail}:email_send`, 10, 60000);
  }

  // Now attempt to dispatch an email to the victim via POST /api/v1/email/send
  const abusedSendRes = await emailSendRoute.POST(
    makeSendReq({
      to: victimEmail,
      subject: "Spam attempt",
      html: "<p>Should be blocked</p>",
      type: "TRANSACTIONAL",
    })
  );

  assert.equal(
    abusedSendRes.status,
    429,
    "API must return 429 when recipient abuse protection limit is exceeded"
  );
  const abusedJson = await abusedSendRes.json();
  assert.equal(
    abusedJson.error.code,
    "RECIPIENT_RATE_LIMITED",
    "Error code must be RECIPIENT_RATE_LIMITED"
  );
  assert(
    abusedSendRes.headers.get("Retry-After") !== null,
    "Retry-After header must be present on recipient rate limit rejection"
  );
  console.log("  [PASS] Public email send per-recipient abuse protection verified end-to-end.");

  // 8b. Test Auth Login Brute Force Account Protection
  const loginRoute = await import("../src/app/api/auth/login/route");
  const testAccountEmail = `target_acct_${runId}@example.test`;

  // Pre-exhaust account limit
  for (let i = 0; i < 25; i++) {
    await checkRateLimit(`rl:acct:${testAccountEmail}:login`, 25, 15 * 60 * 1000);
  }

  const bruteLoginReq = new NextRequest("http://localhost:3000/api/auth/login", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": "198.51.100.99",
    },
    body: JSON.stringify({
      email: testAccountEmail,
      password: "WrongPassword123!",
    }),
  });

  const bruteLoginRes = await loginRoute.POST(bruteLoginReq);
  assert.equal(bruteLoginRes.status, 429, "Login must reject with 429 for account brute force attack");
  const bruteLoginJson = await bruteLoginRes.json();
  assert.equal(bruteLoginJson.error.code, "ACCOUNT_RATE_LIMITED", "Error code must be ACCOUNT_RATE_LIMITED");
  console.log("  [PASS] Auth login account brute-force protection verified end-to-end.");

  // ---------------------------------------------------------------------------
  // CLEANUP
  // ---------------------------------------------------------------------------
  console.log("-> [Step 9] Cleaning up test artifacts...");
  await prisma.apiKey.deleteMany({ where: { clientId: testTenant.id } });
  await prisma.apiClient.delete({ where: { id: testTenant.id } });

  // Close simulated instances
  for (const inst of instances) {
    await inst.quit().catch(() => inst.disconnect());
  }

  console.log("\n========================================================");
  console.log("  ALL DISTRIBUTED RATE LIMITING TESTS PASSED (100%)!");
  console.log("========================================================\n");
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error("Distributed rate limiter verification failed:", err);
    process.exit(1);
  });
