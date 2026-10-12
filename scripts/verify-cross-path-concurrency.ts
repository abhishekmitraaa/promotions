/**
 * Cross-Path Adversarial Concurrency Verification Suite
 *
 * Verifies that the dual execution paths (BackgroundJob vs Direct Sweeps):
 * 1. Concurrent BackgroundJob and direct transactional sweep targeting the same EmailDelivery results in exactly ONE provider send.
 * 2. Concurrent BackgroundJob and direct campaign recipient sweep targeting the same recipient results in exactly ONE dispatch and ONE delivery.
 * 3. Concurrent BackgroundJob and direct event sweep targeting the same EmailEvent results in exactly ONE processing execution without duplicate suppression/metrics side effects.
 * 4. Stale lock recovery safely reclaims abandoned PROCESSING records (>10m) without duplicating or interrupting active work (<10m).
 * 5. Losing claimants produce zero external side effects and cleanly yield contention.
 * 6. Reconciliation database failures surface transparently in structured results with success=false.
 */

if (!process.env.DATABASE_URL || process.env.DATABASE_URL.includes("peqynzeioiauynfpdsdv") || process.env.DATABASE_URL.includes("supabase.co")) {
  process.env.DATABASE_URL = "postgresql://postgres:postgres@127.0.0.1:5433/email_test";
}
if (!process.env.DIRECT_URL || process.env.DIRECT_URL.includes("peqynzeioiauynfpdsdv") || process.env.DIRECT_URL.includes("supabase.co")) {
  process.env.DIRECT_URL = "postgresql://postgres:postgres@127.0.0.1:5433/email_test";
}
process.env.WORKERLESS_MODE = "true";
process.env.NODE_ENV = "test";
process.env.ALLOW_DESTRUCTIVE_TESTS = "true";
process.env.INTERNAL_PROCESSOR_SECRET = "test-internal-processor-secret-1234567890";
process.env.INTERNAL_WORKER_SECRET = "test-internal-processor-secret-1234567890";
process.env.AUTH_SESSION_SECRET = "test-session-secret-32-chars-minimum-length";
process.env.API_KEY_PEPPER = "test-pepper-32-chars-minimum-length";
process.env.WEBHOOK_SECRET_ENCRYPTION_KEY = "test-webhook-encryption-key-32ch";
process.env.EMAIL_CREDENTIALS_ENCRYPTION_KEY = "test-email-encryption-key-32cha";

import { prisma } from "../src/lib/prisma";
import { ServerlessJobProcessor } from "../src/lib/services/serverless-job-processor";
import { EmailDeliveryExecutor } from "../src/lib/services/executors/email-delivery-executor";
import { CampaignRecipientExecutor } from "../src/lib/services/executors/campaign-recipient-executor";
import { EmailEventProcessor } from "../src/lib/services/executors/email-event-processor";
import { EmailEventService } from "../src/lib/services/email-event-service";
import { ReconciliationExecutor } from "../src/lib/services/executors/reconciliation-executor";
import { providerRegistry } from "../src/lib/email/registry";
import { EmailProvider, EmailSendRequest, EmailSendResult, EmailProviderHealthResult } from "../src/lib/email/types";
import { RetryableError, isRetryableError } from "../src/lib/errors/job-errors";
import { checkRateLimit } from "../src/lib/rate-limit";
import { RetryableEmailError } from "../src/lib/email/queue/types";
import { SEND_IN_FLIGHT_SUFFIX, SEND_OUTCOME_UNKNOWN } from "../src/lib/services/executors/claim-lock";
import { isWorkerlessMode } from "../src/lib/email/queue/queues";
import * as envModule from "../src/lib/env";
import { NextRequest } from "next/server";
import {
  EmailDeliveryStatus,
  EmailCampaignStatus,
  EmailEventProcessingStatus,
  EmailEventType,
  EmailType,
  EmailProviderType,
  EmailProviderStatus,
  BackgroundJobStatus,
  EmailTemplateType,
} from "@prisma/client";

let passed = 0;
let failed = 0;

function assert(condition: boolean, name: string, detail?: string) {
  if (condition) {
    passed++;
    console.log(`   ✅ ${name}`);
  } else {
    failed++;
    console.error(`   ❌ FAIL: ${name}`);
    if (detail) console.error(`      Detail: ${detail}`);
  }
}

class TrackingMockProvider implements EmailProvider {
  readonly id = "tracking-mock";
  readonly name = "Tracking Mock Provider";
  readonly providerType = EmailProviderType.MOCK;
  sendCount = 0;
  sentPayloads: EmailSendRequest[] = [];
  // Test hooks: run a side effect during send (e.g. simulate a stale reclaim), or fail the next send
  onSend: (() => Promise<void>) | null = null;
  nextError: Error | null = null;

  async send(request: EmailSendRequest): Promise<EmailSendResult> {
    this.sendCount++;
    this.sentPayloads.push(request);
    if (this.onSend) await this.onSend();
    if (this.nextError) {
      const err = this.nextError;
      this.nextError = null;
      throw err;
    }
    // Add artificial jitter to expose concurrent race windows
    await new Promise((resolve) => setTimeout(resolve, 30));
    return {
      accepted: true,
      success: true,
      providerName: this.name,
      providerType: this.providerType,
      providerMessageId: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      providerStatus: "SENT",
      sentAt: new Date(),
    };
  }

  async verifyCredentials(): Promise<{ valid: boolean; error?: string }> {
    return { valid: true };
  }

  async checkHealth(): Promise<EmailProviderHealthResult> {
    return {
      healthy: true,
      latencyMs: 1,
      message: "Tracking mock provider healthy",
      checkedAt: new Date(),
    };
  }
}

async function main() {
  console.log("===============================================================================");
  console.log("⚔️  STARTING CROSS-PATH ADVERSARIAL CONCURRENCY VERIFICATION SUITE");
  console.log("===============================================================================");

  // 0. Clean up any leftover active/queued test records in disposable db
  await prisma.backgroundJob.deleteMany({
    where: { status: { in: [BackgroundJobStatus.QUEUED, BackgroundJobStatus.PROCESSING] } },
  });
  await prisma.emailDelivery.deleteMany({
    where: { status: { in: [EmailDeliveryStatus.QUEUED, EmailDeliveryStatus.PROCESSING] } },
  });
  await prisma.emailCampaignRecipient.deleteMany({
    where: { status: { in: ["PENDING", "PROCESSING", "RETRYING"] } },
  });
  await prisma.emailEvent.deleteMany({
    where: { status: { in: [EmailEventProcessingStatus.RECEIVED, EmailEventProcessingStatus.PROCESSING] } },
  });

  const testTenant = `adv-race-${Date.now()}`;
  await prisma.apiClient.create({
    data: { id: testTenant, name: "Adversarial Tenant", active: true },
  });

  const trackingProvider = new TrackingMockProvider();
  providerRegistry.register(EmailProviderType.MOCK, () => trackingProvider);

  await prisma.emailProviderConfig.create({
    data: {
      clientId: testTenant,
      name: "Adversarial Mock Provider",
      providerType: EmailProviderType.MOCK,
      status: EmailProviderStatus.ACTIVE,
      isDefault: true,
    },
  });

  // ============================================================================
  // Test 1: Cross-Path Race on EmailDelivery
  // BackgroundJob vs processTransactionalEmails targeting the SAME delivery
  // ============================================================================
  console.log("\n▶ [Race Test 1] Cross-Path Race: BackgroundJob vs Direct Transactional Sweep...");
  trackingProvider.sendCount = 0;

  const raceDelivery = await prisma.emailDelivery.create({
    data: {
      clientId: testTenant,
      providerType: EmailProviderType.MOCK,
      category: EmailType.TRANSACTIONAL,
      from: "tx-race@example.com",
      to: "recipient-race@example.com",
      subject: "Concurrent Transactional Email",
      textContent: "Hello from concurrent race test",
      status: EmailDeliveryStatus.QUEUED,
    },
  });

  const raceBgJob = await prisma.backgroundJob.create({
    data: {
      clientId: testTenant,
      type: "TRANSACTIONAL_EMAIL",
      payload: JSON.stringify({ deliveryId: raceDelivery.id }),
      status: BackgroundJobStatus.QUEUED,
    },
  });

  // Launch BOTH execution paths simultaneously targeting the exact same work item
  await Promise.all([
    ServerlessJobProcessor.processBackgroundJobs(10),
    ServerlessJobProcessor.processTransactionalEmails(10),
  ]);

  let finalDelivery = await prisma.emailDelivery.findUnique({ where: { id: raceDelivery.id } });
  let finalBgJob = await prisma.backgroundJob.findUnique({ where: { id: raceBgJob.id } });

  // If BackgroundJob yielded due to contention while direct sweep was sending:
  // Trigger BackgroundJobs again to let it cleanly discover terminal state and complete without re-sending
  if (finalBgJob?.status === BackgroundJobStatus.QUEUED) {
    await prisma.backgroundJob.update({
      where: { id: raceBgJob.id },
      data: { availableAt: new Date(Date.now() - 1000) },
    });
    await ServerlessJobProcessor.processBackgroundJobs(10);
    finalBgJob = await prisma.backgroundJob.findUnique({ where: { id: raceBgJob.id } });
  }

  assert(finalDelivery?.status === EmailDeliveryStatus.SENT, "Delivery reached terminal SENT state");
  assert(
    trackingProvider.sendCount === 1,
    `Provider send was initiated exactly once (actual sendCount: ${trackingProvider.sendCount})`
  );
  assert(
    finalBgJob?.status === BackgroundJobStatus.COMPLETED,
    `BackgroundJob reached terminal COMPLETED status without re-sending (actual: ${finalBgJob?.status})`
  );
  assert(finalDelivery?.lockedAt === null, "Delivery lock cleared cleanly");

  // ============================================================================
  // Test 2: Cross-Path Race on Campaign Recipient
  // BackgroundJob vs processCampaignRecipients targeting the SAME recipient
  // ============================================================================
  console.log("\n▶ [Race Test 2] Cross-Path Race: BackgroundJob vs Direct Campaign Recipient Sweep...");
  trackingProvider.sendCount = 0;

  const template = await prisma.emailTemplate.create({
    data: {
      clientId: testTenant,
      name: "Race Campaign Template",
      type: EmailTemplateType.PROMOTIONAL,
    },
  });

  const tmplVersion = await prisma.emailTemplateVersion.create({
    data: {
      templateId: template.id,
      version: 1,
      subject: "Race Campaign Subject",
      htmlContent: "<p>Hello {{email}}</p>",
      textContent: "Hello {{email}}",
    },
  });

  const campaign = await prisma.emailCampaign.create({
    data: {
      clientId: testTenant,
      name: "Adversarial Campaign",
      templateVersionId: tmplVersion.id,
      status: EmailCampaignStatus.RUNNING,
      sentCount: 0,
      totalRecipients: 1,
    },
  });

  const recipient = await prisma.emailCampaignRecipient.create({
    data: {
      campaignId: campaign.id,
      email: "campaign-winner@example.com",
      status: "PENDING",
    },
  });

  const recipBgJob = await prisma.backgroundJob.create({
    data: {
      clientId: testTenant,
      type: "CAMPAIGN_RECIPIENT",
      payload: JSON.stringify({ campaignRecipientId: recipient.id }),
      status: BackgroundJobStatus.QUEUED,
    },
  });

  // Launch BOTH campaign recipient execution paths simultaneously
  await Promise.all([
    ServerlessJobProcessor.processBackgroundJobs(10),
    ServerlessJobProcessor.processCampaignRecipients(10),
  ]);

  let finalRecipient = await prisma.emailCampaignRecipient.findUnique({ where: { id: recipient.id } });
  let finalRecipJob = await prisma.backgroundJob.findUnique({ where: { id: recipBgJob.id } });
  const finalCampaign = await prisma.emailCampaign.findUnique({ where: { id: campaign.id } });
  const recipientDeliveries = await prisma.emailDelivery.findMany({
    where: { campaignRecipientId: recipient.id },
  });

  // If BackgroundJob yielded due to contention while direct sweep was sending:
  if (finalRecipJob?.status === BackgroundJobStatus.QUEUED) {
    await prisma.backgroundJob.update({
      where: { id: recipBgJob.id },
      data: { availableAt: new Date(Date.now() - 1000) },
    });
    await ServerlessJobProcessor.processBackgroundJobs(10);
    finalRecipJob = await prisma.backgroundJob.findUnique({ where: { id: recipBgJob.id } });
  }

  assert(finalRecipient?.status === "SENT", "Campaign recipient reached SENT status");
  assert(
    recipientDeliveries.length === 1,
    `Exactly one authoritative EmailDelivery created for recipient (actual: ${recipientDeliveries.length})`
  );
  assert(
    trackingProvider.sendCount === 1,
    `Campaign recipient dispatched via provider exactly once (actual: ${trackingProvider.sendCount})`
  );
  assert(
    finalCampaign?.sentCount === 1,
    `Campaign sentCount incremented exactly once (actual: ${finalCampaign?.sentCount})`
  );
  assert(
    finalRecipJob?.status === BackgroundJobStatus.COMPLETED,
    `Campaign recipient BackgroundJob completed cleanly without re-dispatching (actual: ${finalRecipJob?.status})`
  );
  assert(finalRecipient?.lockedAt === null, "Recipient lock cleared cleanly");

  // ============================================================================
  // Test 3: Cross-Path Race on EmailEvent
  // BackgroundJob vs processEvents targeting the SAME event
  // ============================================================================
  console.log("\n▶ [Race Test 3] Cross-Path Race: BackgroundJob vs Direct Event Sweep...");

  const raceEvent = await prisma.emailEvent.create({
    data: {
      clientId: testTenant,
      eventType: EmailEventType.BOUNCED,
      recipient: "bounce-race@example.com",
      payload: JSON.stringify({
        bounce: { reason: "550 5.1.1 User unknown", description: "Hard bounce" },
        _normalized: { bounceType: "HARD_BOUNCE", bounceReason: "550 User unknown" },
      }),
      status: EmailEventProcessingStatus.RECEIVED,
    },
  });

  const eventBgJob = await prisma.backgroundJob.create({
    data: {
      clientId: testTenant,
      type: "EMAIL_EVENT",
      payload: JSON.stringify({ eventId: raceEvent.id }),
      status: BackgroundJobStatus.QUEUED,
    },
  });

  // Launch BOTH event processors simultaneously
  await Promise.all([
    ServerlessJobProcessor.processBackgroundJobs(10),
    ServerlessJobProcessor.processEvents(10),
  ]);

  let finalEvent = await prisma.emailEvent.findUnique({ where: { id: raceEvent.id } });
  let finalEventJob = await prisma.backgroundJob.findUnique({ where: { id: eventBgJob.id } });
  const suppressions = await prisma.emailSuppression.findMany({
    where: { clientId: testTenant, email: "bounce-race@example.com" },
  });

  if (finalEventJob?.status === BackgroundJobStatus.QUEUED) {
    await prisma.backgroundJob.update({
      where: { id: eventBgJob.id },
      data: { availableAt: new Date(Date.now() - 1000) },
    });
    await ServerlessJobProcessor.processBackgroundJobs(10);
    finalEventJob = await prisma.backgroundJob.findUnique({ where: { id: eventBgJob.id } });
  }

  assert(finalEvent?.status === EmailEventProcessingStatus.PROCESSED, "EmailEvent reached PROCESSED state");
  assert(
    suppressions.length === 1,
    `Suppression policy created exactly once without duplicates (actual: ${suppressions.length})`
  );
  assert(
    finalEventJob?.status === BackgroundJobStatus.COMPLETED,
    `Event BackgroundJob completed without re-running side effects (actual: ${finalEventJob?.status})`
  );

  // ============================================================================
  // Test 4: Stale Lock Recovery vs Active Lock Protection
  // ============================================================================
  console.log("\n▶ [Race Test 4] Testing Stale-Lock Recovery vs Active-Lock Protection...");

  // A. Stale Delivery (locked 15 minutes ago)
  const staleDelivery = await prisma.emailDelivery.create({
    data: {
      clientId: testTenant,
      providerType: EmailProviderType.MOCK,
      category: EmailType.TRANSACTIONAL,
      from: "stale@example.com",
      to: "stale-recipient@example.com",
      subject: "Stale Delivery Test",
      textContent: "Recover me",
      status: EmailDeliveryStatus.PROCESSING,
      lockedAt: new Date(Date.now() - 15 * 60 * 1000), // 15m ago (stale)
      lockedBy: "dead-worker-1",
      attemptCount: 1,
    },
  });

  trackingProvider.sendCount = 0;
  const staleRecoverResult = await EmailDeliveryExecutor.execute({
    deliveryId: staleDelivery.id,
  });

  assert(staleRecoverResult.success === true, "Stale delivery claimed and executed successfully");
  assert(staleRecoverResult.skipped !== true, "Stale delivery was not incorrectly skipped");
  assert(trackingProvider.sendCount === 1, "Stale delivery sent exactly once on recovery");

  // B. Active Delivery (locked 30 seconds ago)
  const activeDelivery = await prisma.emailDelivery.create({
    data: {
      clientId: testTenant,
      providerType: EmailProviderType.MOCK,
      category: EmailType.TRANSACTIONAL,
      from: "active@example.com",
      to: "active-recipient@example.com",
      subject: "Active Delivery Test",
      textContent: "Don't steal me",
      status: EmailDeliveryStatus.PROCESSING,
      lockedAt: new Date(Date.now() - 30 * 1000), // 30s ago (active)
      lockedBy: "active-worker-99",
      attemptCount: 1,
    },
  });

  trackingProvider.sendCount = 0;
  const activeContentionResult = await EmailDeliveryExecutor.execute({
    deliveryId: activeDelivery.id,
  });

  assert(activeContentionResult.skipped === true, "Active delivery correctly skipped by competing claimant");
  assert(
    activeContentionResult.reason === "CONTENTION_LOCK_HELD",
    `Contention reason recorded: ${activeContentionResult.reason}`
  );
  assert(trackingProvider.sendCount === 0, "Competing claimant made zero external sends");

  const preservedDelivery = await prisma.emailDelivery.findUnique({ where: { id: activeDelivery.id } });
  assert(
    preservedDelivery?.lockedBy === "active-worker-99",
    "Original worker lock preserved untouched"
  );

  // ============================================================================
  // Test 5: Reconciliation Failure Surfacing (Item 4)
  // ============================================================================
  console.log("\n▶ [Race Test 5] Testing Reconciliation Database Error Surfacing...");

  const originalReconcile = ReconciliationExecutor.reconcile;
  ReconciliationExecutor.reconcile = async () => {
    throw new Error("Simulated database connection failure during reconciliation query");
  };

  try {
    const reconReport = await ServerlessJobProcessor.reconcileJobs(10);
    assert(
      reconReport !== null && reconReport.error !== undefined,
      "reconcileJobs returns structured report with error (never silently null)"
    );
    assert(
      reconReport?.error?.includes("Simulated database connection failure") ?? false,
      "Reconciliation error details captured in report"
    );

    const fullCycleResult = await ServerlessJobProcessor.processAll({
      runReconciliation: true,
      maxExecutionTimeMs: 10000,
    });

    assert(fullCycleResult.success === false, "processAll() reports success=false when reconciliation fails");
    assert(
      fullCycleResult.errors?.some((e) => e.includes("reconciliation:")) ?? false,
      "Errors array includes reconciliation failure"
    );
    assert(
      fullCycleResult.results.reconciliation?.error !== undefined,
      "reconciliation.error property populated in result payload"
    );
  } finally {
    ReconciliationExecutor.reconcile = originalReconcile;
  }

  // ============================================================================
  // Test 6: Retryable event error releases the event for immediate retry
  // ============================================================================
  console.log("\n▶ [Regression 6] Retryable EmailEvent error releases claim...");

  const retryEvent = await prisma.emailEvent.create({
    data: {
      clientId: testTenant,
      eventType: EmailEventType.DELIVERED,
      recipient: "retry-event@example.com",
      payload: JSON.stringify({}),
      status: EmailEventProcessingStatus.RECEIVED,
    },
  });

  const eventServiceInternals = EmailEventService as unknown as { resolveDelivery: (...args: unknown[]) => Promise<unknown> };
  const originalResolveDelivery = eventServiceInternals.resolveDelivery;
  eventServiceInternals.resolveDelivery = async () => {
    throw new RetryableEmailError("Simulated transient database timeout");
  };
  let retryEventThrew = false;
  try {
    await EmailEventService.processEventFromWorker(retryEvent.id);
  } catch {
    retryEventThrew = true;
  } finally {
    eventServiceInternals.resolveDelivery = originalResolveDelivery;
  }

  const releasedEvent = await prisma.emailEvent.findUnique({ where: { id: retryEvent.id } });
  assert(retryEventThrew, "Retryable error propagated to caller");
  assert(
    releasedEvent?.status === EmailEventProcessingStatus.RECEIVED,
    `Event released to RECEIVED after retryable error (actual: ${releasedEvent?.status})`
  );
  const immediateRetry = await EmailEventService.processEventFromWorker(retryEvent.id);
  const retriedEvent = await prisma.emailEvent.findUnique({ where: { id: retryEvent.id } });
  assert(
    immediateRetry.success === true && !(immediateRetry as { skipped?: boolean }).skipped,
    "Immediate retry claims and processes the event (no 10-minute stall)"
  );
  assert(retriedEvent?.status === EmailEventProcessingStatus.PROCESSED, "Retried event reached PROCESSED");

  // ============================================================================
  // Test 7: Contention yields must not consume BackgroundJob attempts
  // ============================================================================
  console.log("\n▶ [Regression 7] Contention yields do not burn BackgroundJob attempts...");

  const heldDelivery = await prisma.emailDelivery.create({
    data: {
      clientId: testTenant,
      providerType: EmailProviderType.MOCK,
      category: EmailType.TRANSACTIONAL,
      from: "held@example.com",
      to: "held-recipient@example.com",
      subject: "Held Delivery",
      textContent: "Held by another worker",
      status: EmailDeliveryStatus.PROCESSING,
      lockedAt: new Date(Date.now() - 30 * 1000),
      lockedBy: "holder-worker",
      attemptCount: 1,
    },
  });
  const yieldingJob = await prisma.backgroundJob.create({
    data: {
      clientId: testTenant,
      type: "TRANSACTIONAL_EMAIL",
      payload: JSON.stringify({ deliveryId: heldDelivery.id }),
      status: BackgroundJobStatus.QUEUED,
      maxAttempts: 5,
    },
  });

  for (let i = 0; i < 7; i++) {
    await prisma.backgroundJob.update({
      where: { id: yieldingJob.id },
      data: { availableAt: new Date(Date.now() - 1000) },
    });
    await ServerlessJobProcessor.processBackgroundJobs(10);
  }
  const yieldedJob = await prisma.backgroundJob.findUnique({ where: { id: yieldingJob.id } });
  assert(
    yieldedJob?.status === BackgroundJobStatus.QUEUED,
    `Job still QUEUED after 7 contention yields (actual: ${yieldedJob?.status})`
  );
  assert(yieldedJob?.attemptCount === 0, `Yields did not consume attempts (actual attemptCount: ${yieldedJob?.attemptCount})`);
  await prisma.backgroundJob.delete({ where: { id: yieldingJob.id } });
  await prisma.emailDelivery.update({
    where: { id: heldDelivery.id },
    data: { status: EmailDeliveryStatus.FAILED, lockedAt: null, lockedBy: null },
  });

  // ============================================================================
  // Test 8: Permanently FAILED deliveries are terminal
  // ============================================================================
  console.log("\n▶ [Regression 8] FAILED delivery is never re-sent...");

  const failedDelivery = await prisma.emailDelivery.create({
    data: {
      clientId: testTenant,
      providerType: EmailProviderType.MOCK,
      category: EmailType.TRANSACTIONAL,
      from: "failed@example.com",
      to: "rejected@example.com",
      subject: "Permanently rejected",
      textContent: "Do not resend",
      status: EmailDeliveryStatus.FAILED,
      errorCode: "PERMANENT_REJECT",
      attemptCount: 1,
    },
  });
  trackingProvider.sendCount = 0;
  const failedResult = await EmailDeliveryExecutor.execute({ deliveryId: failedDelivery.id });
  assert(trackingProvider.sendCount === 0, `FAILED delivery not re-sent (sendCount: ${trackingProvider.sendCount})`);
  assert(failedResult.reason === "ALREADY_TERMINAL", `FAILED treated as terminal (reason: ${failedResult.reason})`);

  // ============================================================================
  // Test 9: Sweep path counts attempts correctly (no off-by-one)
  // ============================================================================
  console.log("\n▶ [Regression 9] Sweep-claimed delivery uses the real attempt number...");

  const attemptDelivery = await prisma.emailDelivery.create({
    data: {
      clientId: testTenant,
      providerType: EmailProviderType.MOCK,
      category: EmailType.TRANSACTIONAL,
      from: "attempts@example.com",
      to: "attempts-recipient@example.com",
      subject: "Attempt counting",
      textContent: "Fourth attempt",
      status: EmailDeliveryStatus.QUEUED,
      attemptCount: 3,
    },
  });
  trackingProvider.nextError = new RetryableError("Simulated provider 503");
  await ServerlessJobProcessor.processTransactionalEmails(10);
  trackingProvider.nextError = null;
  const attemptAfter = await prisma.emailDelivery.findUnique({ where: { id: attemptDelivery.id } });
  assert(attemptAfter?.attemptCount === 4, `Attempt count is 4 after the fourth attempt (actual: ${attemptAfter?.attemptCount})`);
  assert(
    attemptAfter?.status === EmailDeliveryStatus.QUEUED,
    `Transient error on attempt 4 of 5 is retried, not failed (actual: ${attemptAfter?.status})`
  );
  await prisma.emailDelivery.update({
    where: { id: attemptDelivery.id },
    data: { status: EmailDeliveryStatus.FAILED, lockedAt: null, lockedBy: null },
  });

  // ============================================================================
  // Test 10: Campaign recipient retry after a delivery was already recorded
  // ============================================================================
  console.log("\n▶ [Regression 10] Campaign recipient retry does not re-send an already-sent email...");

  const retryCampaign = await prisma.emailCampaign.create({
    data: {
      clientId: testTenant,
      name: "Retry Campaign",
      templateVersionId: tmplVersion.id,
      status: EmailCampaignStatus.RUNNING,
      sentCount: 0,
      totalRecipients: 1,
    },
  });
  const retryRecipient = await prisma.emailCampaignRecipient.create({
    data: { campaignId: retryCampaign.id, email: "campaign-retry@example.com", status: "PENDING", attemptCount: 1 },
  });
  await prisma.emailDelivery.create({
    data: {
      clientId: testTenant,
      providerType: EmailProviderType.MOCK,
      campaignId: retryCampaign.id,
      campaignRecipientId: retryRecipient.id,
      category: EmailType.PROMOTIONAL,
      from: "campaigns@example.com",
      to: retryRecipient.email,
      subject: "Race Campaign Subject",
      textContent: "Hello",
      status: EmailDeliveryStatus.SENT,
      sentAt: new Date(),
      idempotencyKey: `campaign-${retryCampaign.id}-recipient-${retryRecipient.id}`,
    },
  });

  trackingProvider.sendCount = 0;
  let retryRecipientError: unknown = null;
  try {
    await CampaignRecipientExecutor.executeRecipient({ recipientId: retryRecipient.id });
  } catch (err) {
    retryRecipientError = err;
  }
  const retriedRecipient = await prisma.emailCampaignRecipient.findUnique({ where: { id: retryRecipient.id } });
  const retryDeliveries = await prisma.emailDelivery.count({ where: { campaignRecipientId: retryRecipient.id } });
  const retryCampaignAfter = await prisma.emailCampaign.findUnique({ where: { id: retryCampaign.id } });
  assert(retryRecipientError === null, `Retry completes without error (error: ${retryRecipientError instanceof Error ? retryRecipientError.message : "none"})`);
  assert(trackingProvider.sendCount === 0, `No second provider send (sendCount: ${trackingProvider.sendCount})`);
  assert(retriedRecipient?.status === "SENT", `Recipient marked SENT (actual: ${retriedRecipient?.status})`);
  assert(retryDeliveries === 1, `Still exactly one delivery row (actual: ${retryDeliveries})`);
  assert(retryCampaignAfter?.sentCount === 1, `sentCount incremented once (actual: ${retryCampaignAfter?.sentCount})`);

  // ============================================================================
  // Test 11: Early errors after claim release the recipient lock
  // ============================================================================
  console.log("\n▶ [Regression 11] Early recipient errors release the lock and finish the campaign...");

  const brokenCampaign = await prisma.emailCampaign.create({
    data: {
      clientId: testTenant,
      name: "Campaign Without Template",
      status: EmailCampaignStatus.RUNNING,
      totalRecipients: 1,
    },
  });
  const brokenRecipient = await prisma.emailCampaignRecipient.create({
    data: { campaignId: brokenCampaign.id, email: "no-template@example.com", status: "PENDING" },
  });
  let brokenThrew = false;
  try {
    await CampaignRecipientExecutor.executeRecipient({ recipientId: brokenRecipient.id });
  } catch {
    brokenThrew = true;
  }
  const brokenAfter = await prisma.emailCampaignRecipient.findUnique({ where: { id: brokenRecipient.id } });
  const brokenCampaignAfter = await prisma.emailCampaign.findUnique({ where: { id: brokenCampaign.id } });
  assert(brokenThrew, "Missing template surfaces as an error");
  assert(brokenAfter?.status === "FAILED", `Recipient moved to FAILED (actual: ${brokenAfter?.status})`);
  assert(brokenAfter?.lockedBy === null, `Recipient lock released (lockedBy: ${brokenAfter?.lockedBy})`);
  assert(
    brokenCampaignAfter?.status === EmailCampaignStatus.COMPLETED,
    `Campaign does not stay RUNNING forever (actual: ${brokenCampaignAfter?.status})`
  );

  // ============================================================================
  // Test 12: Stale delivery with an in-flight send is not re-sent
  // ============================================================================
  console.log("\n▶ [Regression 12] Crashed mid-send delivery is flagged, not re-sent...");

  const inFlightDelivery = await prisma.emailDelivery.create({
    data: {
      clientId: testTenant,
      providerType: EmailProviderType.MOCK,
      category: EmailType.TRANSACTIONAL,
      from: "inflight@example.com",
      to: "inflight-recipient@example.com",
      subject: "Crashed during send",
      textContent: "Maybe already delivered",
      status: EmailDeliveryStatus.PROCESSING,
      lockedAt: new Date(Date.now() - 15 * 60 * 1000),
      lockedBy: `crashed-worker${SEND_IN_FLIGHT_SUFFIX}`,
      attemptCount: 1,
    },
  });
  trackingProvider.sendCount = 0;
  await EmailDeliveryExecutor.execute({ deliveryId: inFlightDelivery.id });
  assert(trackingProvider.sendCount === 0, `In-flight stale delivery not re-sent (sendCount: ${trackingProvider.sendCount})`);
  await ReconciliationExecutor.reconcile({ staleMinutes: 10 });
  const inFlightAfter = await prisma.emailDelivery.findUnique({ where: { id: inFlightDelivery.id } });
  assert(
    inFlightAfter?.status === EmailDeliveryStatus.FAILED && inFlightAfter?.errorCode === SEND_OUTCOME_UNKNOWN,
    `Reconciliation flags it ${SEND_OUTCOME_UNKNOWN} (actual: ${inFlightAfter?.status}/${inFlightAfter?.errorCode})`
  );

  // ============================================================================
  // Test 13: A worker that lost its lock cannot overwrite the new owner
  // ============================================================================
  console.log("\n▶ [Regression 13] Final writes are bound to the claim token...");

  const stolenDelivery = await prisma.emailDelivery.create({
    data: {
      clientId: testTenant,
      providerType: EmailProviderType.MOCK,
      category: EmailType.TRANSACTIONAL,
      from: "stolen@example.com",
      to: "stolen-recipient@example.com",
      subject: "Lock stolen mid-send",
      textContent: "Slow send",
      status: EmailDeliveryStatus.QUEUED,
    },
  });
  trackingProvider.onSend = async () => {
    await prisma.emailDelivery.update({
      where: { id: stolenDelivery.id },
      data: { lockedBy: "reclaiming-worker", lockedAt: new Date() },
    });
  };
  trackingProvider.nextError = new RetryableError("Simulated provider timeout");
  try {
    await EmailDeliveryExecutor.execute({ deliveryId: stolenDelivery.id });
  } catch {
    // expected retryable error
  } finally {
    trackingProvider.onSend = null;
    trackingProvider.nextError = null;
  }
  const stolenAfter = await prisma.emailDelivery.findUnique({ where: { id: stolenDelivery.id } });
  assert(
    stolenAfter?.lockedBy === "reclaiming-worker" && stolenAfter?.status === EmailDeliveryStatus.PROCESSING,
    `New owner's lock left intact (actual: ${stolenAfter?.status}/${stolenAfter?.lockedBy})`
  );
  await prisma.emailDelivery.update({
    where: { id: stolenDelivery.id },
    data: { status: EmailDeliveryStatus.FAILED, lockedAt: null, lockedBy: null },
  });

  // ============================================================================
  // Test 14: Processor endpoint returns non-200 when processing fails
  // ============================================================================
  console.log("\n▶ [Regression 14] /api/internal/process-jobs reports failures in the HTTP status...");

  const { POST: processJobsPost } = await import("../src/app/api/internal/process-jobs/route");
  ReconciliationExecutor.reconcile = async () => {
    throw new Error("Simulated reconciliation failure");
  };
  try {
    const res = await processJobsPost(
      new NextRequest("http://localhost/api/internal/process-jobs?reconcile=true", {
        method: "POST",
        headers: { authorization: `Bearer ${process.env.INTERNAL_PROCESSOR_SECRET}` },
      })
    );
    const body = await res.json();
    assert(res.status === 500, `HTTP status is 500 on processing failure (actual: ${res.status})`);
    assert(body.success === false, `Response body success=false (actual: ${body.success})`);
  } finally {
    ReconciliationExecutor.reconcile = originalReconcile;
  }

  // ============================================================================
  // Test 15: Configuration safety (queue mode, public URL)
  // ============================================================================
  console.log("\n▶ [Regression 15] Configuration safety defaults...");

  const savedWorkerless = process.env.WORKERLESS_MODE;
  const savedRedis = process.env.REDIS_URL;
  try {
    delete process.env.WORKERLESS_MODE;
    process.env.REDIS_URL = "rediss://default:secret@example-remote.upstash.io:6379";
    assert(isWorkerlessMode() === true, "Remote REDIS_URL alone does not switch async email to BullMQ");
    process.env.WORKERLESS_MODE = "false";
    assert(isWorkerlessMode() === false, "WORKERLESS_MODE=false explicitly opts into BullMQ");

    delete process.env.REDIS_URL;
    const criticalLimit = await checkRateLimit(`rl:regression-${Date.now()}`, 5, 60000, {
      criticality: "CRITICAL",
      failClosed: true,
    });
    assert(
      criticalLimit.success === true && criticalLimit.backend === "postgres",
      `Without REDIS_URL, critical limits use PostgreSQL instead of failing closed (success: ${criticalLimit.success}, backend: ${criticalLimit.backend})`
    );

    const transientDbError = Object.assign(new Error("Can't reach database server"), { code: "P1001" });
    assert(isRetryableError(transientDbError) === true, "Prisma connection errors (P1001) are retryable");
  } finally {
    if (savedWorkerless === undefined) delete process.env.WORKERLESS_MODE;
    else process.env.WORKERLESS_MODE = savedWorkerless;
    if (savedRedis === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = savedRedis;
  }

  const getPublicAppUrl = (envModule as { getPublicAppUrl?: () => string }).getPublicAppUrl;
  const savedAppUrl = process.env.APP_URL;
  const savedPublicUrl = process.env.NEXT_PUBLIC_APP_URL;
  try {
    delete process.env.NEXT_PUBLIC_APP_URL;
    process.env.APP_URL = "https://hub.example.test/";
    assert(
      typeof getPublicAppUrl === "function" && getPublicAppUrl() === "https://hub.example.test",
      `Public links use APP_URL when no override is set (actual: ${typeof getPublicAppUrl === "function" ? getPublicAppUrl() : "missing"})`
    );
  } finally {
    if (savedAppUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = savedAppUrl;
    if (savedPublicUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
    else process.env.NEXT_PUBLIC_APP_URL = savedPublicUrl;
  }

  // ============================================================================
  // Summary
  // ============================================================================
  console.log("\n===============================================================================");
  if (failed === 0) {
    console.log(`🎉 ALL ${passed} CROSS-PATH ADVERSARIAL CONCURRENCY TESTS PASSED!`);
  } else {
    console.error(`❌ ${failed} TESTS FAILED out of ${passed + failed}`);
    process.exit(1);
  }
  console.log("===============================================================================");
}

main()
  .catch((err) => {
    console.error("Fatal test error:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
