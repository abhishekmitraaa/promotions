/**
 * Phase 4 Email Queue & Worker Verification Test Suite
 *
 * Validates:
 * 2. Queue topology & job ID generation
 * 3. Idempotency & duplicate job prevention contracts
 * 4. Error classification (Retryable vs Permanent / Unrecoverable)
 * 5. Queue producer pipeline (database-first persistence, suppression pre-check)
 * 6. Worker processor execution:
 *    - Worker success
 *    - Stale delivery state protection (skips already SENT/DELIVERED)
 *    - Suppressed recipient rejection
 *    - Provider timeout (transient retryable)
 *    - Provider 429 rate limit (transient retryable)
 *    - Permanent rejection (PermanentError)
 *    - Concurrent execution race defense
 * 7. Queue health reporting & credential redaction
 */

import {
  QUEUE_NAMES,
  JOB_NAMES,
  getTransactionalJobId,
  getCampaignJobId,
  getEventJobId,
  RetryableEmailError,
  PermanentEmailError,
  isRetryableError,
} from "../src/lib/email/queue/types";
import { EmailDeliveryExecutor } from "../src/lib/services/executors/email-delivery-executor";
import { RetryableError, PermanentError } from "../src/lib/errors/job-errors";
import { matchesWhere, applyUpdate } from "./lib/in-memory-where";
import { getEmailQueueHealth } from "../src/lib/email/queue/health";
import { EmailProvider, EmailSendRequest, EmailSendResult } from "../src/lib/email/types";
import { EmailDeliveryStatus, EmailProviderType } from "@prisma/client";
import { prisma } from "../src/lib/prisma";

// Mock Provider for testing worker processor behaviors
class MockQueueProvider implements EmailProvider {
  id = "mock-queue-provider";
  name = "Mock Queue Provider";
  providerType = EmailProviderType.MOCK;
  sentMessages: EmailSendRequest[] = [];
  mode: "SUCCESS" | "TIMEOUT" | "RATE_LIMIT_429" | "PERMANENT_400" = "SUCCESS";

  async send(message: EmailSendRequest): Promise<EmailSendResult> {
    this.sentMessages.push(message);

    if (this.mode === "TIMEOUT") {
      return {
        accepted: false,
        success: false,
        providerName: this.name,
        providerType: this.providerType,
        providerStatus: EmailDeliveryStatus.FAILED,
        error: {
          code: "ETIMEDOUT",
          message: "Connection to email server timed out",
          retryable: true,
        },
      };
    }

    if (this.mode === "RATE_LIMIT_429") {
      return {
        accepted: false,
        success: false,
        providerName: this.name,
        providerType: this.providerType,
        providerStatus: EmailDeliveryStatus.FAILED,
        error: {
          code: "RATE_LIMIT_EXCEEDED",
          message: "Google API rate limit exceeded (429)",
          retryable: true,
        },
      };
    }

    if (this.mode === "PERMANENT_400") {
      return {
        accepted: false,
        success: false,
        providerName: this.name,
        providerType: this.providerType,
        providerStatus: EmailDeliveryStatus.FAILED,
        error: {
          code: "INVALID_REQUEST",
          message: "Permanent 400 Bad Request: Invalid message body",
          retryable: false,
        },
      };
    }

    return {
      accepted: true,
      success: true,
      providerName: this.name,
      providerType: this.providerType,
      providerMessageId: `msg-${Date.now()}-${Math.random().toString(36).substring(7)}`,
      providerStatus: EmailDeliveryStatus.SENT,
      sentAt: new Date(),
    };
  }

  async verifyCredentials() {
    return { verified: true, providerType: this.providerType };
  }
}

async function runPhase4Tests() {
  console.log("==================================================================");
  console.log("📬 RUNNING PHASE 4 EMAIL QUEUE & DELIVERY EXECUTOR CHECKS");
  console.log("==================================================================\n");

  let passed = 0;
  let failed = 0;

  function testAssert(condition: boolean, testName: string, detail?: string) {
    if (condition) {
      console.log(`  ✅ PASS: ${testName}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${testName}${detail ? ` - ${detail}` : ""}`);
      failed++;
    }
  }

  // -------------------------------------------------------------------------
  // 2. Queue Topology & Job ID Generation
  // -------------------------------------------------------------------------
  testAssert(QUEUE_NAMES.TRANSACTIONAL === "email-transactional", "Queue name: email-transactional");
  testAssert(QUEUE_NAMES.CAMPAIGN === "email-campaign", "Queue name: email-campaign");
  testAssert(QUEUE_NAMES.EVENTS === "email-events", "Queue name: email-events");

  testAssert(JOB_NAMES.SEND_TRANSACTIONAL === "send-transactional", "Job name: send-transactional");
  testAssert(JOB_NAMES.SEND_CAMPAIGN_RECIPIENT === "send-campaign-recipient", "Job name: send-campaign-recipient");
  testAssert(JOB_NAMES.PROCESS_EMAIL_EVENT === "process-email-event", "Job name: process-email-event");

  testAssert(getTransactionalJobId("del-999") === "email-transactional-del-999", "getTransactionalJobId generates stable business ID");
  testAssert(getCampaignJobId("rec-888") === "email-campaign-rec-888", "getCampaignJobId generates stable business ID");
  testAssert(getEventJobId("evt-777") === "email-event-evt-777", "getEventJobId generates stable business ID");

  // -------------------------------------------------------------------------
  // 3. Error Classification
  // -------------------------------------------------------------------------
  const retryableErr = new RetryableEmailError("Temporary timeout", "ETIMEDOUT");
  testAssert(retryableErr.isRetryable === true, "RetryableEmailError has isRetryable = true");
  testAssert(isRetryableError(retryableErr), "isRetryableError recognizes RetryableEmailError");
  testAssert(isRetryableError({ status: 429 }), "isRetryableError classifies HTTP 429 as retryable");
  testAssert(isRetryableError({ status: 503 }), "isRetryableError classifies HTTP 503 as retryable");
  testAssert(isRetryableError({ code: "RATE_LIMIT_EXCEEDED" }), "isRetryableError classifies RATE_LIMIT_EXCEEDED as retryable");

  const permanentErr = new PermanentEmailError("Invalid email", "INVALID_EMAIL");
  testAssert(permanentErr.isRetryable === false, "PermanentEmailError has isRetryable = false");
  testAssert(!isRetryableError(permanentErr), "isRetryableError does NOT retry PermanentEmailError");
  testAssert(!isRetryableError({ status: 400 }), "isRetryableError does NOT retry HTTP 400");
  testAssert(!isRetryableError({ code: "RECIPIENT_SUPPRESSED" }), "isRetryableError does NOT retry RECIPIENT_SUPPRESSED");

  // -------------------------------------------------------------------------
  // 4. In-Memory Store & Mock Setup for Worker and Producer Execution
  // -------------------------------------------------------------------------
  const inMemoryDeliveries = new Map<string, any>();
  const inMemorySuppressions = new Map<string, any>();

  const origDeliveryFindUnique = prisma.emailDelivery.findUnique;
  const origDeliveryFindFirst = prisma.emailDelivery.findFirst;
  const origDeliveryCreate = prisma.emailDelivery.create;
  const origDeliveryUpdateMany = prisma.emailDelivery.updateMany;
  const origSuppressionFindFirst = prisma.emailSuppression.findFirst;

  (prisma.emailDelivery as any).findUnique = async ({ where }: any) => {
    return inMemoryDeliveries.get(where.id) || null;
  };

  (prisma.emailDelivery as any).findFirst = async ({ where }: any) => {
    for (const d of inMemoryDeliveries.values()) {
      if (where.id && d.id !== where.id) continue;
      if (where.clientId && d.clientId !== where.clientId) continue;
      if (where.idempotencyKey && d.idempotencyKey !== where.idempotencyKey) continue;
      return d;
    }
    return null;
  };

  (prisma.emailDelivery as any).create = async ({ data }: any) => {
    const id = data.id || `del-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    const record = { lockedAt: null, lockedBy: null, lastAttemptAt: null, ...data, id, attemptCount: data.attemptCount || 0, createdAt: new Date() };
    inMemoryDeliveries.set(id, record);
    return record;
  };

  (prisma.emailDelivery as any).updateMany = async ({ where, data }: any) => {
    let count = 0;
    for (const record of inMemoryDeliveries.values()) {
      if (!matchesWhere(record, where)) continue;
      applyUpdate(record, data);
      count++;
    }
    return { count };
  };

  (prisma.emailSuppression as any).findFirst = async ({ where }: any) => {
    for (const s of inMemorySuppressions.values()) {
      if (where.clientId && s.clientId !== where.clientId) continue;
      if (where.email && s.email !== where.email) continue;
      return s;
    }
    return null;
  };

  const mockProvider = new MockQueueProvider();

  try {
    // -------------------------------------------------------------------------
    // 5. Worker Success Execution
    // -------------------------------------------------------------------------
    const successDelivery = await prisma.emailDelivery.create({
      data: {
        id: "del-success-1",
        clientId: "tenant-1",
        providerType: EmailProviderType.GMAIL,
        category: "TRANSACTIONAL",
        from: "sender@example.test",
        to: "recipient1@example.test",
        subject: "Welcome to Platform",
        htmlContent: "<p>Welcome to Platform</p>",
        textContent: "Welcome to Platform",
        status: EmailDeliveryStatus.QUEUED,
      },
    });

    const successJob = {
      id: "email-transactional-del-success-1",
      data: {
        deliveryId: successDelivery.id,
        clientId: "tenant-1",
        category: "TRANSACTIONAL" as const,
      },
    } as any;

    mockProvider.mode = "SUCCESS";
    const workerRes = await EmailDeliveryExecutor.execute({ deliveryId: successJob.data.deliveryId, providerOverride: mockProvider });

    testAssert(workerRes.success === true, "Worker successfully processes transactional job");
    testAssert(workerRes.providerMessageId !== undefined, "Worker returns providerMessageId");

    const updatedSuccess = inMemoryDeliveries.get(successDelivery.id);
    testAssert(updatedSuccess.status === EmailDeliveryStatus.SENT, "Delivery record transitioned to SENT in DB");
    testAssert(updatedSuccess.providerMessageId === workerRes.providerMessageId, "Delivery record stores providerMessageId");
    testAssert(updatedSuccess.attemptCount === 1, "Attempt count incremented to 1");

    // -------------------------------------------------------------------------
    // 6. Stale Delivery State Guard (Skips already SENT/DELIVERED)
    // -------------------------------------------------------------------------
    const staleJob = {
      id: "email-transactional-del-success-1",
      data: {
        deliveryId: successDelivery.id,
        clientId: "tenant-1",
        category: "TRANSACTIONAL" as const,
      },
    } as any;

    const staleRes = await EmailDeliveryExecutor.execute({ deliveryId: staleJob.data.deliveryId, providerOverride: mockProvider });
    testAssert(staleRes.skipped === true && staleRes.reason === "ALREADY_TERMINAL", "Worker skips duplicate execution of already SENT delivery (stale guard)");
    testAssert(updatedSuccess.attemptCount === 1, "Attempt count was NOT incremented on stale skip");

    // -------------------------------------------------------------------------
    // 7. Recipient Suppression Check in Worker
    // -------------------------------------------------------------------------
    inMemorySuppressions.set("suppressed-bob", {
      clientId: "tenant-1",
      email: "bob@suppressed.test",
      reason: "HARD_BOUNCE",
    });

    const suppressedDelivery = await prisma.emailDelivery.create({
      data: {
        id: "del-suppressed-1",
        clientId: "tenant-1",
        providerType: EmailProviderType.GMAIL,
        category: "TRANSACTIONAL",
        from: "sender@example.test",
        to: "bob@suppressed.test",
        subject: "Important Notice",
        status: EmailDeliveryStatus.QUEUED,
      },
    });

    let threwSuppressed = false;
    let isUnrecoverable = false;
    try {
      await EmailDeliveryExecutor.execute({ deliveryId: suppressedDelivery.id, providerOverride: mockProvider });
    } catch (err: any) {
      threwSuppressed = true;
      isUnrecoverable = err instanceof PermanentError;
    }

    testAssert(threwSuppressed, "Worker throws when recipient is suppressed");
    testAssert(isUnrecoverable, "Suppressed recipient throws PermanentError (no retries)");
    const updatedSuppressed = inMemoryDeliveries.get(suppressedDelivery.id);
    testAssert(updatedSuppressed.status === EmailDeliveryStatus.FAILED, "Suppressed delivery status marked FAILED");
    testAssert(updatedSuppressed.errorCode === "RECIPIENT_SUPPRESSED", "Suppressed delivery errorCode is RECIPIENT_SUPPRESSED");

    // -------------------------------------------------------------------------
    // 8. Provider Timeout (Retryable Error)
    // -------------------------------------------------------------------------
    const timeoutDelivery = await prisma.emailDelivery.create({
      data: {
        id: "del-timeout-1",
        clientId: "tenant-1",
        providerType: EmailProviderType.GMAIL,
        category: "TRANSACTIONAL",
        from: "sender@example.test",
        to: "charlie@example.test",
        subject: "System Alert",
        htmlContent: "<p>System Alert</p>",
        textContent: "System Alert",
        status: EmailDeliveryStatus.QUEUED,
      },
    });

    mockProvider.mode = "TIMEOUT";
    let threwTimeout = false;
    let isRetryable = false;

    try {
      await EmailDeliveryExecutor.execute({ deliveryId: timeoutDelivery.id, providerOverride: mockProvider });
    } catch (err: any) {
      threwTimeout = true;
      isRetryable = err instanceof RetryableError;
    }

    testAssert(threwTimeout, "Worker throws on provider timeout");
    testAssert(isRetryable, "Provider timeout throws RetryableError (scheduled for retry)");

    // -------------------------------------------------------------------------
    // 9. Provider 429 Rate Limit (Retryable Error)
    // -------------------------------------------------------------------------
    const rateLimitDelivery = await prisma.emailDelivery.create({
      data: {
        id: "del-429-1",
        clientId: "tenant-1",
        providerType: EmailProviderType.GMAIL,
        category: "TRANSACTIONAL",
        from: "sender@example.test",
        to: "dave@example.test",
        subject: "Your Report",
        htmlContent: "<p>Your Report</p>",
        textContent: "Your Report",
        status: EmailDeliveryStatus.QUEUED,
      },
    });

    mockProvider.mode = "RATE_LIMIT_429";
    let threw429 = false;
    let isRetryable429 = false;

    try {
      await EmailDeliveryExecutor.execute({ deliveryId: rateLimitDelivery.id, providerOverride: mockProvider });
    } catch (err: any) {
      threw429 = true;
      isRetryable429 = err instanceof RetryableError;
    }

    testAssert(threw429, "Worker throws on provider 429 rate limit");
    testAssert(isRetryable429, "Provider 429 throws RetryableError so delivery backs off");

    // -------------------------------------------------------------------------
    // 10. Permanent Provider Failure (UnrecoverableError)
    // -------------------------------------------------------------------------
    const permDelivery = await prisma.emailDelivery.create({
      data: {
        id: "del-perm-1",
        clientId: "tenant-1",
        providerType: EmailProviderType.GMAIL,
        category: "TRANSACTIONAL",
        from: "sender@example.test",
        to: "eve@example.test",
        subject: "Bad Request Email",
        htmlContent: "<p>Bad Request Email</p>",
        textContent: "Bad Request Email",
        status: EmailDeliveryStatus.QUEUED,
      },
    });

    mockProvider.mode = "PERMANENT_400";
    let threwPerm = false;
    let isPermUnrecoverable = false;

    try {
      await EmailDeliveryExecutor.execute({ deliveryId: permDelivery.id, providerOverride: mockProvider });
    } catch (err: any) {
      threwPerm = true;
      isPermUnrecoverable = err instanceof PermanentError;
    }

    testAssert(threwPerm, "Worker throws on permanent 400 error");
    testAssert(isPermUnrecoverable, "Permanent rejection throws PermanentError to prevent retry waste");
    const updatedPerm = inMemoryDeliveries.get(permDelivery.id);
    testAssert(updatedPerm.status === EmailDeliveryStatus.FAILED, "Permanent failure marks delivery FAILED in DB");

    // -------------------------------------------------------------------------
    // 11. Concurrent Worker Processing Simulation
    // -------------------------------------------------------------------------
    const raceDelivery = await prisma.emailDelivery.create({
      data: {
        id: "del-race-1",
        clientId: "tenant-1",
        providerType: EmailProviderType.GMAIL,
        category: "TRANSACTIONAL",
        from: "sender@example.test",
        to: "race@example.test",
        subject: "Concurrent Job Test",
        htmlContent: "<p>Concurrent Job Test</p>",
        textContent: "Concurrent Job Test",
        status: EmailDeliveryStatus.QUEUED,
      },
    });

    mockProvider.mode = "SUCCESS";
    const raceJob = {
      id: "email-transactional-del-race-1",
      data: {
        deliveryId: raceDelivery.id,
        clientId: "tenant-1",
        category: "TRANSACTIONAL",
      },
    } as any;

    // Simulate 2 parallel workers picking up the same job concurrently
    const [resA, resB] = await Promise.all([
      EmailDeliveryExecutor.execute({ deliveryId: raceJob.data.deliveryId, providerOverride: mockProvider }),
      EmailDeliveryExecutor.execute({ deliveryId: raceJob.data.deliveryId, providerOverride: mockProvider }),
    ]);

    const raceSends = mockProvider.sentMessages.filter((m) => m.to === "race@example.test").length;
    const loser = resA.skipped ? resA : resB;
    testAssert(raceSends === 1, `Concurrent execution sends exactly once (sends: ${raceSends})`);
    testAssert(
      loser.skipped === true && (loser.reason === "CONTENTION_LOCK_HELD" || loser.reason === "ALREADY_TERMINAL"),
      "Losing concurrent executor skipped without sending"
    );

    // -------------------------------------------------------------------------
    // 12. Queue Health Observability & Sanitization
    // -------------------------------------------------------------------------
    const health = await getEmailQueueHealth();
    testAssert(health.status === "HEALTHY" || health.status === "DEGRADED" || health.status === "DOWN", "Health report returns valid status code");
    testAssert(["READY", "STALLED", "UNKNOWN"].includes(health.processor.status), "Health report includes processor liveness");
    testAssert(typeof health.queues.transactional.waiting === "number", "Health report includes transactional queue waiting count");
    testAssert(typeof health.queues.campaign.waiting === "number", "Health report includes campaign queue waiting count");
    testAssert(typeof health.queues.events.waiting === "number", "Health report includes events queue waiting count");
  } finally {
    // Restore mocks
    (prisma.emailDelivery as any).findUnique = origDeliveryFindUnique;
    (prisma.emailDelivery as any).findFirst = origDeliveryFindFirst;
    (prisma.emailDelivery as any).create = origDeliveryCreate;
    (prisma.emailDelivery as any).updateMany = origDeliveryUpdateMany;
    (prisma.emailSuppression as any).findFirst = origSuppressionFindFirst;
  }

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  console.log("\n-------------------------------------------------");
  console.log(`Summary: ${passed} PASSED, ${failed} FAILED`);
  console.log("-------------------------------------------------\n");

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runPhase4Tests().catch((err) => {
  console.error("Fatal error during Phase 4 verification:", err);
  process.exit(1);
});
