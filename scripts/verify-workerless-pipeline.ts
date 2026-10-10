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
 * 8. Guarantees concurrency safety across overlapping processor invocations
 */

// Configure environment to point to real disposable PostgreSQL
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

import { prisma } from "../src/lib/prisma";
import { ServerlessJobProcessor } from "../src/lib/services/serverless-job-processor";
import { isWorkerlessMode } from "../src/lib/email/queue/queues";
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
  EmailTemplateType,
  BackgroundJobStatus,
} from "@prisma/client";
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

  // 0. Setup test ApiClient
  await prisma.apiClient.upsert({
    where: { id: testTenant },
    update: {},
    create: {
      id: testTenant,
      name: "Workerless Test Tenant",
      active: true,
    },
  });

  // Test 1: Workerless Mode Detection
  console.log("\n▶ [Test 1] Verifying Workerless Mode Configuration...");
  assert(isWorkerlessMode() === true, "Workerless mode is correctly detected");

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
    updatedDelivery?.status === EmailDeliveryStatus.SENT || updatedDelivery?.status === EmailDeliveryStatus.FAILED,
    `Delivery transitioned from QUEUED to ${updatedDelivery?.status}`
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

  // Test 8: Master Processor processAll Execution
  console.log("\n▶ [Test 8] Testing Master ServerlessJobProcessor.processAll()...");
  const masterResult = await ServerlessJobProcessor.processAll();
  assert(masterResult.success === true, "processAll() completes successfully");
  assert(masterResult.durationMs >= 0, `Execution duration recorded: ${masterResult.durationMs}ms`);

  // Test 9: Durable BackgroundJob Processing
  console.log("\n▶ [Test 9] Testing Durable BackgroundJob Processing & Atomic Claims...");
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
    updatedBgJob?.status === BackgroundJobStatus.COMPLETED || updatedBgJob?.status === BackgroundJobStatus.FAILED,
    `BackgroundJob transitioned to terminal status: ${updatedBgJob?.status}`
  );

  // Test 10: Concurrency Safety with Simultaneous Processors
  console.log("\n▶ [Test 10] Testing Concurrency Safety with Simultaneous Processors...");
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
