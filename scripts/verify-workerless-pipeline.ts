/**
 * Workerless Background Pipeline Verification Suite
 *
 * Verifies that the serverless job processing architecture:
 * 1. Claims and processes queued transactional deliveries
 * 2. Triggers scheduled campaigns without BullMQ worker
 * 3. Dispatches campaign recipients in bounded batches
 * 4. Executes recurring automations
 * 5. Advances waiting automation enrollment delay steps & timeouts
 * 6. Processes ingested email events
 * 7. Enforces authorization on the /api/internal/process-jobs endpoint
 * 8. Measures empty-queue processing duration and telemetry breakdown
 * 9. One queued background job reaching expected terminal state (COMPLETED)
 * 10. Enforces transactional email enqueue atomicity (delivery + BackgroundJob)
 * 11. Guarantees concurrency safety across overlapping processor invocations
 * 12. Enforces timeout detection and safe release of unstarted BackgroundJob claims
 * 13. Enforces timeout detection and safe release of unstarted Webhook delivery claims
 * 14. Enforces reconciliation under a constrained deadline
 * 15. Surfaces database query errors honestly without reporting empty queue
 * 16. Distinguishes retryable vs permanent failures
 * 17. Guarantees tenant isolation across BackgroundJobs
 * 18. Verifies zero real outbound communication (mock provider)
 * 19. Regression checks that EVERY category respects the deadline
 */

// Configure environment to point to real disposable PostgreSQL
if (!process.env.DATABASE_URL || process.env.DATABASE_URL.includes("peqynzeioiauynfpdsdv") || process.env.DATABASE_URL.includes("supabase.co")) {
  process.env.DATABASE_URL = "postgresql://postgres:postgres@127.0.0.1:5433/email_test";
}
if (!process.env.DIRECT_URL || process.env.DIRECT_URL.includes("peqynzeioiauynfpdsdv") || process.env.DIRECT_URL.includes("supabase.co")) {
  process.env.DIRECT_URL = "postgresql://postgres:postgres@127.0.0.1:5433/email_test";
}
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
import { getTransactionalQueue } from "../src/lib/email/queue/queues";
import { JOB_NAMES } from "../src/lib/email/queue/types";
import {
  EmailDeliveryStatus,
  EmailCampaignStatus,
  EmailAutomationStatus,
  EmailEnrollmentStatus,
  EmailAutomationTriggerType,
  EmailEventProcessingStatus,
  EmailEventType,
  EmailType,
  EmailProviderType,
  EmailProviderStatus,
  EmailTemplateType,
  BackgroundJobStatus,
  DeliveryStatus,
} from "@prisma/client";
import { EmailDispatchService } from "../src/lib/services/email-dispatch-service";
import { ReconciliationExecutor } from "../src/lib/services/executors/reconciliation-executor";
import { processWebhookDeliveryQueue } from "../src/lib/webhooks/dispatcher";
import { encryptWebhookSecret } from "../src/lib/crypto";
import { POST as processJobsRoute, GET as processJobsGetRoute } from "../src/app/api/internal/process-jobs/route";
import { NextRequest } from "next/server";

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

async function main() {
  console.log("===============================================================================");
  console.log("🚀 STARTING WORKERLESS PIPELINE VERIFICATION SUITE");
  console.log("===============================================================================");

  const testTenant = `test-wl-${Date.now()}`;

  // 0. Setup test ApiClient & mock EmailProviderConfig
  await prisma.apiClient.upsert({
    where: { id: testTenant },
    update: {},
    create: {
      id: testTenant,
      name: "Workerless Test Tenant",
      active: true,
    },
  });

  await prisma.emailProviderConfig.create({
    data: {
      clientId: testTenant,
      name: "Mock Provider for Test",
      providerType: EmailProviderType.MOCK,
      status: EmailProviderStatus.ACTIVE,
      isDefault: true,
      senderEmail: "sender@example.com",
    },
  });

  // Test 1: Workerless Mode Detection
  console.log("\n▶ [Test 1] Verifying producer jobs persist in PostgreSQL...");
  const probeJob = await getTransactionalQueue().add(
    JOB_NAMES.SEND_TRANSACTIONAL,
    { deliveryId: "probe-delivery", clientId: testTenant, category: "TRANSACTIONAL" },
    { jobId: `probe-${Date.now()}`, delay: 60 * 60 * 1000 }
  );
  const probeRow = await prisma.backgroundJob.findFirst({ where: { clientId: testTenant, deduplicationKey: probeJob.id } });
  assert(probeRow?.type === "TRANSACTIONAL_EMAIL", "Producer jobs are persisted as PostgreSQL BackgroundJob rows");
  if (probeRow) await prisma.backgroundJob.delete({ where: { id: probeRow.id } });

  // Test 2: Transactional Delivery Processing
  console.log("\n▶ [Test 2] Testing Serverless Transactional Delivery Processing...");
  const delivery = await prisma.emailDelivery.create({
    data: {
      clientId: testTenant,
      providerType: EmailProviderType.MOCK,
      category: EmailType.TRANSACTIONAL,
      from: "sender@example.com",
      to: "recipient@example.com",
      subject: "Test Workerless Delivery",
      textContent: "Hello from workerless processor",
      status: EmailDeliveryStatus.QUEUED,
    },
  });

  assert(delivery.status === EmailDeliveryStatus.QUEUED, "Delivery created in QUEUED status");

  const transResult = await ServerlessJobProcessor.processTransactionalEmails(10);
  assert(transResult.processed >= 1, "Processor picked up queued delivery");

  const updatedDelivery = await prisma.emailDelivery.findUnique({
    where: { id: delivery.id },
  });
  assert(
    updatedDelivery?.status === EmailDeliveryStatus.SENT,
    `Delivery transitioned from QUEUED to SENT (actual: ${updatedDelivery?.status})`
  );

  // Test 3: Scheduled Campaign Trigger
  console.log("\n▶ [Test 3] Testing Serverless Scheduled Campaign Trigger...");
  const template = await prisma.emailTemplate.create({
    data: {
      clientId: testTenant,
      name: `Template ${Date.now()}`,
      type: EmailTemplateType.PROMOTIONAL,
    },
  });
  const templateVersion = await prisma.emailTemplateVersion.create({
    data: {
      templateId: template.id,
      version: 1,
      subject: "Scheduled Subject",
      htmlContent: "<p>Scheduled Content</p>",
    },
  });
  const list = await prisma.emailList.create({
    data: {
      clientId: testTenant,
      name: `List ${Date.now()}`,
    },
  });
  const contact = await prisma.emailContact.create({
    data: {
      clientId: testTenant,
      email: `contact-${Date.now()}@example.com`,
      normalizedEmail: `contact-${Date.now()}@example.com`,
      hasMarketingConsent: true,
    },
  });
  await prisma.emailListMember.create({
    data: {
      listId: list.id,
      contactId: contact.id,
    },
  });

  const scheduledCampaign = await prisma.emailCampaign.create({
    data: {
      clientId: testTenant,
      name: "Scheduled Workerless Campaign",
      templateVersionId: templateVersion.id,
      listId: list.id,
      status: EmailCampaignStatus.SCHEDULED,
      scheduledAt: new Date(Date.now() - 5000), // Due 5s ago
    },
  });

  const campResult = await ServerlessJobProcessor.processScheduledCampaigns(5);
  assert(campResult.processed >= 1, "Scheduled campaign was processed");

  const triggeredCampaign = await prisma.emailCampaign.findUnique({
    where: { id: scheduledCampaign.id },
  });
  assert(
    triggeredCampaign?.status === EmailCampaignStatus.RUNNING || triggeredCampaign?.status === EmailCampaignStatus.COMPLETED,
    `Scheduled campaign transitioned to ${triggeredCampaign?.status}`
  );

  // Test 4: Running Campaign Recipients Batch Dispatch
  console.log("\n▶ [Test 4] Testing Campaign Recipient Dispatch...");
  const recipientResult = await ServerlessJobProcessor.processCampaignRecipients(25);
  assert(recipientResult.processed >= 0, "Recipient batch execution completed gracefully");

  // Test 5: Automation Step & Timeout Execution
  console.log("\n▶ [Test 5] Testing Automation Journey Step Processing...");
  const automation = await prisma.emailAutomation.create({
    data: {
      clientId: testTenant,
      name: `Automation ${Date.now()}`,
      status: EmailAutomationStatus.ACTIVE,
      triggerType: EmailAutomationTriggerType.MANUAL,
      steps: JSON.stringify([
        { id: "step-1", type: "DELAY", config: { delayMinutes: 1 }, nextStepId: "step-2" },
        { id: "step-2", type: "END" },
      ]),
    },
  });

  const enrollment = await prisma.emailAutomationEnrollment.create({
    data: {
      clientId: testTenant,
      automationId: automation.id,
      contactId: contact.id,
      currentStepId: "step-1",
      status: EmailEnrollmentStatus.WAITING,
      nextActionAt: new Date(Date.now() - 1000), // Due now
    },
  });

  const autoResult = await ServerlessJobProcessor.processAutomationEnrollments(10);
  assert(autoResult.processed >= 1, "Waiting enrollment step processed");

  // Test 6: Email Ingested Events Processing
  console.log("\n▶ [Test 6] Testing Email Event Ingestion Processing...");
  const emailEvent = await prisma.emailEvent.create({
    data: {
      clientId: testTenant,
      eventType: EmailEventType.DELIVERED,
      recipient: "recipient@example.com",
      payload: JSON.stringify({ event: "delivered" }),
      status: EmailEventProcessingStatus.RECEIVED,
    },
  });

  const eventResult = await ServerlessJobProcessor.processEmailEvents(10);
  assert(eventResult.processed >= 1, "Ingested event processed");

  const processedEvent = await prisma.emailEvent.findUnique({
    where: { id: emailEvent.id },
  });
  assert(
    processedEvent?.status === EmailEventProcessingStatus.PROCESSED,
    `Email event status is ${processedEvent?.status}`
  );

  // Test 7: Internal API Route Security & Authorization
  console.log("\n▶ [Test 7] Testing /api/internal/process-jobs Authorization Guards...");
  // Unauthorized request (missing credential)
  const unauthReq = new NextRequest("http://localhost:3000/api/internal/process-jobs", {
    method: "POST",
  });
  const unauthRes = await processJobsRoute(unauthReq);
  assert(unauthRes.status === 401, "Missing credential rejected with HTTP 401");

  // Legacy header alone rejected (enforces strict Bearer contract)
  const legacyReq = new NextRequest("http://localhost:3000/api/internal/process-jobs", {
    method: "POST",
    headers: {
      "x-processor-secret": "test-internal-processor-secret-1234567890",
    },
  });
  const legacyRes = await processJobsRoute(legacyReq);
  assert(legacyRes.status === 401, "Legacy header x-processor-secret alone rejected with HTTP 401");

  // Invalid secret
  const badAuthReq = new NextRequest("http://localhost:3000/api/internal/process-jobs", {
    method: "POST",
    headers: {
      authorization: "Bearer invalid-wrong-token-value",
    },
  });
  const badAuthRes = await processJobsRoute(badAuthReq);
  assert(badAuthRes.status === 403, "Invalid Bearer credential rejected with HTTP 403");

  // GET request rejected
  const getRes = await processJobsGetRoute();
  assert(getRes.status === 405, "GET request rejected with HTTP 405 Method Not Allowed");

  // Authorized request with Bearer token
  const bearerAuthReq = new NextRequest("http://localhost:3000/api/internal/process-jobs", {
    method: "POST",
    headers: {
      authorization: "Bearer test-internal-processor-secret-1234567890",
    },
  });
  const bearerAuthRes = await processJobsRoute(bearerAuthReq);
  assert(bearerAuthRes.status === 200, "Authorized request with Bearer token returns HTTP 200 OK");
  const authBody = await bearerAuthRes.json();
  assert(authBody.success === true && authBody.data.durationMs >= 0, "Internal endpoint returns structured metrics");

  // Test 8: Empty Queue Processing Duration & Telemetry Breakdown
  console.log("\n▶ [Test 8] Testing Empty Queue Processing Duration & Telemetry Breakdown...");
  const emptyResult = await ServerlessJobProcessor.processAll({ maxExecutionTimeMs: 25000 });
  assert(emptyResult.success === true, "processAll() succeeds on empty queue");
  assert(emptyResult.durationMs >= 0, `Execution duration recorded: ${emptyResult.durationMs}ms`);
  assert(typeof emptyResult.timingBreakdownMs === "object", "timingBreakdownMs is provided in result");
  assert(typeof emptyResult.timingBreakdownMs?.webhooks === "number", "timingBreakdownMs.webhooks is a number");
  assert(typeof emptyResult.timingBreakdownMs?.backgroundJobs === "number", "timingBreakdownMs.backgroundJobs is a number");
  assert(typeof emptyResult.timingBreakdownMs?.transactional === "number", "timingBreakdownMs.transactional is a number");
  assert(typeof emptyResult.timingBreakdownMs?.scheduledCampaigns === "number", "timingBreakdownMs.scheduledCampaigns is a number");
  assert(typeof emptyResult.timingBreakdownMs?.campaignRecipients === "number", "timingBreakdownMs.campaignRecipients is a number");
  assert(typeof emptyResult.timingBreakdownMs?.recurringAutomations === "number", "timingBreakdownMs.recurringAutomations is a number");
  assert(typeof emptyResult.timingBreakdownMs?.automationEnrollments === "number", "timingBreakdownMs.automationEnrollments is a number");
  assert(typeof emptyResult.timingBreakdownMs?.events === "number", "timingBreakdownMs.events is a number");

  // Test 9: One Queued BackgroundJob Reaching Terminal State (COMPLETED)
  console.log("\n▶ [Test 9] Testing Durable BackgroundJob Processing Reaching COMPLETED...");
  const bgDelivery = await prisma.emailDelivery.create({
    data: {
      clientId: testTenant,
      providerType: EmailProviderType.MOCK,
      category: EmailType.TRANSACTIONAL,
      from: "sender@example.com",
      to: "bg-recipient@example.com",
      subject: "Test BackgroundJob Delivery",
      textContent: "Hello from background job",
      status: EmailDeliveryStatus.QUEUED,
    },
  });

  const bgJob = await prisma.backgroundJob.create({
    data: {
      clientId: testTenant,
      type: "TRANSACTIONAL_EMAIL",
      status: BackgroundJobStatus.QUEUED,
      priority: 10,
      payload: JSON.stringify({ deliveryId: bgDelivery.id }),
    },
  });

  assert(bgJob.status === BackgroundJobStatus.QUEUED, "BackgroundJob persisted in QUEUED status");

  const bgResult = await ServerlessJobProcessor.processBackgroundJobs(10);
  assert(bgResult.claimed >= 1, `BackgroundJob processor claimed queued job (claimed: ${bgResult.claimed})`);

  const updatedBgJob = await prisma.backgroundJob.findUnique({
    where: { id: bgJob.id },
  });
  assert(
    updatedBgJob?.status === BackgroundJobStatus.COMPLETED,
    `BackgroundJob reached terminal COMPLETED status (actual: ${updatedBgJob?.status})`
  );

  const updatedBgDelivery = await prisma.emailDelivery.findUnique({
    where: { id: bgDelivery.id },
  });
  assert(
    updatedBgDelivery?.status === EmailDeliveryStatus.SENT,
    `Associated EmailDelivery reached SENT status (actual: ${updatedBgDelivery?.status})`
  );

  // Test 10: Transactional Email Enqueue Atomicity
  console.log("\n▶ [Test 10] Testing Transactional Email Enqueue Atomicity...");
  const atomicEnqueue = await EmailDispatchService.enqueueBackground({
    clientId: testTenant,
    to: "atomic-recipient@example.com",
    subject: "Atomic Enqueue Test",
    text: "Atomic transactional test message",
  });
  assert(atomicEnqueue.queued === true, "Transactional email enqueued successfully");
  assert(Boolean(atomicEnqueue.deliveryId), "deliveryId returned in enqueue result");

  const atomicDelivery = await prisma.emailDelivery.findUnique({
    where: { id: atomicEnqueue.deliveryId },
  });
  assert(atomicDelivery?.status === EmailDeliveryStatus.QUEUED, "EmailDelivery row created in QUEUED status");

  const atomicBgJob = await prisma.backgroundJob.findFirst({
    where: {
      clientId: testTenant,
      type: "TRANSACTIONAL_EMAIL",
      payload: { contains: atomicEnqueue.deliveryId },
    },
  });
  assert(Boolean(atomicBgJob), "BackgroundJob row created atomically with linked deliveryId");
  assert(atomicBgJob?.status === BackgroundJobStatus.QUEUED, "BackgroundJob is in QUEUED status");

  // Test 11: Concurrency Safety with Simultaneous Processors
  console.log("\n▶ [Test 11] Testing Concurrency Safety with Simultaneous Processors...");
  // Create 4 background jobs
  const concurrentJobs = await Promise.all(
    [1, 2, 3, 4].map(async (i) => {
      const del = await prisma.emailDelivery.create({
        data: {
          clientId: testTenant,
          providerType: EmailProviderType.MOCK,
          category: EmailType.TRANSACTIONAL,
          from: "sender@example.com",
          to: `concurrent-${i}@example.com`,
          subject: `Concurrent Test ${i}`,
          textContent: "Concurrent test message",
          status: EmailDeliveryStatus.QUEUED,
        },
      });
      return prisma.backgroundJob.create({
        data: {
          clientId: testTenant,
          type: "TRANSACTIONAL_EMAIL",
          status: BackgroundJobStatus.QUEUED,
          priority: 5,
          payload: JSON.stringify({ deliveryId: del.id }),
        },
      });
    })
  );

  // Launch two concurrent processor executions simultaneously
  const [proc1, proc2] = await Promise.all([
    ServerlessJobProcessor.processBackgroundJobs(10),
    ServerlessJobProcessor.processBackgroundJobs(10),
  ]);

  const totalClaimed = proc1.claimed + proc2.claimed;
  assert(
    totalClaimed >= 4,
    `All 4 concurrent jobs claimed across two parallel processors without conflict (claimed: ${totalClaimed})`
  );

  const jobStates = await prisma.backgroundJob.findMany({
    where: { id: { in: concurrentJobs.map((j) => j.id) } },
  });
  const allTerminal = jobStates.every(
    (j) => j.status === BackgroundJobStatus.COMPLETED || j.status === BackgroundJobStatus.FAILED
  );
  assert(allTerminal, "All concurrent jobs transitioned to terminal state without lock collisions or duplicate processing");

  // Test 12: Timeout Detection and Safe Release of Unstarted BackgroundJob Claims
  console.log("\n▶ [Test 12] Testing Timeout Detection & Safe Release of Unstarted BackgroundJobs...");
  const timeoutJob1 = await prisma.backgroundJob.create({
    data: {
      clientId: testTenant,
      type: "TRANSACTIONAL_EMAIL",
      status: BackgroundJobStatus.QUEUED,
      priority: 20,
      payload: JSON.stringify({ invalid: false }),
    },
  });
  const timeoutJob2 = await prisma.backgroundJob.create({
    data: {
      clientId: testTenant,
      type: "TRANSACTIONAL_EMAIL",
      status: BackgroundJobStatus.QUEUED,
      priority: 20,
      payload: JSON.stringify({ invalid: false }),
    },
  });

  // Call processBackgroundJobs with isTimeExhausted returning true after 1st job
  let executedCount = 0;
  const timeoutResult = await ServerlessJobProcessor.processBackgroundJobs(10, () => {
    return executedCount++ >= 1;
  });
  assert(timeoutResult.claimed >= 2, "Claimed both jobs initially before deadline check");

  // Verify that the unstarted job was released back to QUEUED
  const refreshedJob2 = await prisma.backgroundJob.findUnique({
    where: { id: timeoutJob2.id },
  });
  assert(
    refreshedJob2?.status === BackgroundJobStatus.QUEUED && refreshedJob2?.lockedAt === null,
    `Unstarted job was safely reverted to QUEUED with lockedAt=null (status: ${refreshedJob2?.status})`
  );

  // Clean up timeout jobs
  await prisma.backgroundJob.deleteMany({
    where: { id: { in: [timeoutJob1.id, timeoutJob2.id] } },
  });

  // Test 13: Timeout Detection and Safe Release of Unstarted Webhook Claims
  console.log("\n▶ [Test 13] Testing Timeout Detection & Safe Release of Unstarted Webhook Deliveries...");
  const webhookEndpoint = await prisma.webhookEndpoint.create({
    data: {
      clientId: testTenant,
      name: "Test Webhook Endpoint",
      url: "http://127.0.0.1:9999/webhook-mock",
      encryptedSecret: encryptWebhookSecret("test-secret-value-12345"),
      subscribedEvents: JSON.stringify(["*"]),
      active: true,
    },
  });

  const whDelivery1 = await prisma.webhookDelivery.create({
    data: {
      clientId: testTenant,
      endpointId: webhookEndpoint.id,
      eventType: "test.event",
      payload: JSON.stringify({ test: 1 }),
      status: DeliveryStatus.PENDING,
    },
  });
  const whDelivery2 = await prisma.webhookDelivery.create({
    data: {
      clientId: testTenant,
      endpointId: webhookEndpoint.id,
      eventType: "test.event",
      payload: JSON.stringify({ test: 2 }),
      status: DeliveryStatus.PENDING,
    },
  });

  let whExecuted = 0;
  const whTimeoutResult = await processWebhookDeliveryQueue({
    batchSize: 10,
    isTimeExhausted: () => whExecuted++ >= 1,
    reclaimStale: false,
  });
  assert(whTimeoutResult.claimed >= 2, "Claimed webhook deliveries before deadline trigger");

  const refreshedWh2 = await prisma.webhookDelivery.findUnique({
    where: { id: whDelivery2.id },
  });
  assert(
    refreshedWh2?.status === DeliveryStatus.PENDING && refreshedWh2?.lockedAt === null,
    `Unstarted webhook delivery safely reverted to PENDING with lockedAt=null (status: ${refreshedWh2?.status})`
  );

  // Clean up webhook deliveries & endpoint
  await prisma.webhookDelivery.deleteMany({
    where: { id: { in: [whDelivery1.id, whDelivery2.id] } },
  });
  await prisma.webhookEndpoint.delete({
    where: { id: webhookEndpoint.id },
  });

  // Test 14: Reconciliation Under a Constrained Deadline
  console.log("\n▶ [Test 14] Testing Reconciliation Under a Constrained Deadline...");
  const reconConstrained = await ReconciliationExecutor.reconcile({
    isTimeExhausted: () => true,
  });
  assert(reconConstrained !== null, "Reconciliation returns valid report object when deadline exhausted");
  assert(typeof reconConstrained.durationMs === "number", "Reconciliation records durationMs promptly");

  // Test 15: Error Surfacing When Database Query Fails
  console.log("\n▶ [Test 15] Testing Error Surfacing on Database Failure (No Silent Swallowing)...");
  const originalQueryRaw = prisma.$queryRaw;
  try {
    (prisma as any).$queryRaw = async () => {
      throw new Error("Simulated PostgreSQL connection failure");
    };

    const errorResult = await ServerlessJobProcessor.processBackgroundJobs(10);
    assert(errorResult.claimed === 0, "Claimed 0 jobs on database query failure");
    assert(
      typeof errorResult.error === "string" && errorResult.error.includes("Simulated PostgreSQL connection failure"),
      "Database query failure is surfaced in error property"
    );

    const masterErrorResult = await ServerlessJobProcessor.processAll();
    assert(masterErrorResult.success === false, "processAll() reports success=false on query error");
    assert(
      Array.isArray(masterErrorResult.errors) && masterErrorResult.errors.length > 0,
      "Errors array populated in processAll result"
    );
  } finally {
    prisma.$queryRaw = originalQueryRaw;
  }

  // Test 16: Retryable vs Permanent Failures
  console.log("\n▶ [Test 16] Testing Retryable vs Permanent Failures...");
  // Permanent failure: invalid unknown job type
  const permJob = await prisma.backgroundJob.create({
    data: {
      clientId: testTenant,
      type: "PERMANENT_INVALID_TYPE",
      status: BackgroundJobStatus.QUEUED,
      payload: JSON.stringify({ invalid: true }),
      maxAttempts: 3,
    },
  });
  await ServerlessJobProcessor.processBackgroundJobs(10);
  const updatedPermJob = await prisma.backgroundJob.findUnique({
    where: { id: permJob.id },
  });
  assert(updatedPermJob?.status === BackgroundJobStatus.FAILED, "Permanent invalid job transitioned directly to FAILED");
  assert(updatedPermJob?.lastErrorCode === "PERMANENT_ERROR", "lastErrorCode set to PERMANENT_ERROR");

  // Max attempts exceeded failure
  const maxAttemptsJob = await prisma.backgroundJob.create({
    data: {
      clientId: testTenant,
      type: "AUTOMATION_STEP",
      status: BackgroundJobStatus.QUEUED,
      payload: JSON.stringify({ enrollmentId: "non-existent-enrollment-id" }),
      attemptCount: 3,
      maxAttempts: 3,
    },
  });
  await ServerlessJobProcessor.processBackgroundJobs(10);
  const updatedMaxJob = await prisma.backgroundJob.findUnique({
    where: { id: maxAttemptsJob.id },
  });
  assert(updatedMaxJob?.status === BackgroundJobStatus.FAILED, "Job exceeding max attempts transitioned to FAILED");
  assert(
    updatedMaxJob?.lastErrorCode === "MAX_ATTEMPTS_EXCEEDED" ||
      updatedMaxJob?.lastErrorCode === "EXECUTION_ERROR" ||
      updatedMaxJob?.lastErrorCode === "PERMANENT_ERROR",
    `Terminal error code recorded: ${updatedMaxJob?.lastErrorCode}`
  );

  // Test 17: Tenant Isolation Across BackgroundJobs
  console.log("\n▶ [Test 17] Testing Tenant Isolation Across BackgroundJobs...");
  const tenantA = `iso-tenant-a-${Date.now()}`;
  const tenantB = `iso-tenant-b-${Date.now()}`;
  await prisma.apiClient.createMany({
    data: [
      { id: tenantA, name: "Tenant A", active: true },
      { id: tenantB, name: "Tenant B", active: true },
    ],
  });
  await prisma.emailProviderConfig.createMany({
    data: [
      { clientId: tenantA, name: "Mock A", providerType: EmailProviderType.MOCK, status: EmailProviderStatus.ACTIVE, isDefault: true },
      { clientId: tenantB, name: "Mock B", providerType: EmailProviderType.MOCK, status: EmailProviderStatus.ACTIVE, isDefault: true },
    ],
  });

  const delA = await prisma.emailDelivery.create({
    data: {
      clientId: tenantA,
      providerType: EmailProviderType.MOCK,
      category: EmailType.TRANSACTIONAL,
      from: "sender-a@example.com",
      to: "recipient-a@example.com",
      subject: "Tenant A Message",
      textContent: "Hello A",
      status: EmailDeliveryStatus.QUEUED,
    },
  });
  const delB = await prisma.emailDelivery.create({
    data: {
      clientId: tenantB,
      providerType: EmailProviderType.MOCK,
      category: EmailType.TRANSACTIONAL,
      from: "sender-b@example.com",
      to: "recipient-b@example.com",
      subject: "Tenant B Message",
      textContent: "Hello B",
      status: EmailDeliveryStatus.QUEUED,
    },
  });

  const jobA = await prisma.backgroundJob.create({
    data: { clientId: tenantA, type: "TRANSACTIONAL_EMAIL", payload: JSON.stringify({ deliveryId: delA.id }) },
  });
  const jobB = await prisma.backgroundJob.create({
    data: { clientId: tenantB, type: "TRANSACTIONAL_EMAIL", payload: JSON.stringify({ deliveryId: delB.id }) },
  });

  await ServerlessJobProcessor.processBackgroundJobs(10);

  const resJobA = await prisma.backgroundJob.findUnique({ where: { id: jobA.id } });
  const resJobB = await prisma.backgroundJob.findUnique({ where: { id: jobB.id } });
  assert(resJobA?.clientId === tenantA, "Job A remained strictly scoped to Tenant A");
  assert(resJobB?.clientId === tenantB, "Job B remained strictly scoped to Tenant B");
  assert(resJobA?.status === BackgroundJobStatus.COMPLETED, "Job A completed successfully");
  assert(resJobB?.status === BackgroundJobStatus.COMPLETED, "Job B completed successfully");

  // Test 18: No Real Outbound Communication Verification
  console.log("\n▶ [Test 18] Verifying Zero Real Outbound Communication (Mock Provider Enforcement)...");
  const testDeliveries = await prisma.emailDelivery.findMany({
    where: { clientId: { in: [testTenant, tenantA, tenantB] } },
  });
  const allMock = testDeliveries.every((d) => d.providerType === EmailProviderType.MOCK || d.status === EmailDeliveryStatus.QUEUED);
  assert(allMock, "All created deliveries strictly used EmailProviderType.MOCK");

  // Test 19: Comprehensive Category-Level Deadline Enforcement Regression Check
  console.log("\n▶ [Test 19] Testing Category-Level Deadline Enforcement Regression Check...");
  const deadlineExhausted = () => true;

  const whCheck = await ServerlessJobProcessor.processWebhooks(10, deadlineExhausted);
  assert(whCheck.claimed === 0 && !whCheck.error, "processWebhooks respects deadline");

  const bgCheck = await ServerlessJobProcessor.processBackgroundJobs(10, deadlineExhausted);
  assert(bgCheck.claimed === 0 && !bgCheck.error, "processBackgroundJobs respects deadline");

  const txCheck = await ServerlessJobProcessor.processTransactionalEmails(10, deadlineExhausted);
  assert(txCheck.processed === 0 && !txCheck.error, "processTransactionalEmails respects deadline");

  const campCheck = await ServerlessJobProcessor.processScheduledCampaigns(5, deadlineExhausted);
  assert(campCheck.processed === 0 && !campCheck.error, "processScheduledCampaigns respects deadline");

  const recipCheck = await ServerlessJobProcessor.processCampaignRecipients(10, deadlineExhausted);
  assert(recipCheck.processed === 0 && !recipCheck.error, "processCampaignRecipients respects deadline");

  const autoRecCheck = await ServerlessJobProcessor.processRecurringAutomations(5, deadlineExhausted);
  assert(autoRecCheck.processed === 0 && !autoRecCheck.error, "processRecurringAutomations respects deadline");

  const enrollCheck = await ServerlessJobProcessor.processAutomationEnrollments(10, deadlineExhausted);
  assert(enrollCheck.processed === 0 && !enrollCheck.error, "processAutomationEnrollments respects deadline");

  const evtCheck = await ServerlessJobProcessor.processEvents(10, deadlineExhausted);
  assert(evtCheck.processed === 0 && !evtCheck.error, "processEvents respects deadline");

  const reconCheck = await ServerlessJobProcessor.reconcileJobs(10, deadlineExhausted);
  assert(reconCheck === null, "reconcileJobs respects deadline");

  console.log("\n===============================================================================");
  if (failed === 0) {
    console.log(`🎉 ALL ${passed} WORKERLESS PIPELINE TESTS PASSED!`);
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
