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

  async send(request: EmailSendRequest): Promise<EmailSendResult> {
    this.sendCount++;
    this.sentPayloads.push(request);
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
