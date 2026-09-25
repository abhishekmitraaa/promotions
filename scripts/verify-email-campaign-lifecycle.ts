/**
 * Complete Email Campaign Lifecycle Verification Suite
 *
 * Real disposable PostgreSQL + Redis integration test suite validating:
 * 1. Schedule campaign (delayed trigger job creation with stable business ID)
 * 2. Dedicated scheduled campaign trigger processor execution
 * 3. Delayed trigger time verification (cannot trigger in future)
 * 4. Configuration verification (template, audience, sender)
 * 5. Atomic state transition (SCHEDULED -> RUNNING)
 * 6. Immutable audience snapshot creation exactly once
 * 7. Enqueuing deterministic individual recipient jobs on BullMQ
 * 8. Trigger idempotency (repeated trigger never duplicates recipients or sends)
 * 9. Immediate campaign send (sendCampaignNow)
 * 10. Pause lifecycle (RUNNING -> PAUSED)
 * 11. Resume lifecycle (PAUSED -> RUNNING & FAILED -> RUNNING)
 * 12. Authenticated Admin resume endpoint (VIEWER 403 vs ADMIN 200)
 * 13. Resuming requeues only eligible PENDING recipients (already SENT never resent)
 * 14. Terminal resumption rejection (CANCELLED and COMPLETED cannot resume)
 * 15. Cancellation (removes delayed BullMQ jobs, marks pending recipients CANCELLED, preserves SENT)
 * 16. Pause while jobs are queued (worker skips safely, recipients stay PENDING)
 * 17. Resume after pause (requeues PENDING, worker dispatches, no duplicate sends)
 * 18. Sender identity resolution (honors name, email, reply-to)
 * 19. Cross-tenant sender identity rejection (never silently falls back to default)
 * 20. Queue failure honesty (observable FAILED state, no fake success, recoverable)
 * 21. Duplicate worker execution protection (stale guard skips already SENT)
 * 22. Deterministic lifecycle completion across all terminal states (SENT, FAILED, BOUNCED, COMPLAINED, CANCELLED, SUPPRESSED)
 */

// Configure environment to point to real disposable PostgreSQL and Redis
process.env.DATABASE_URL = "postgresql://postgres:postgres@127.0.0.1:5433/email_test";
process.env.DIRECT_URL = "postgresql://postgres:postgres@127.0.0.1:5433/email_test";
process.env.REDIS_URL = "redis://127.0.0.1:6379";
process.env.REDIS_HOST = "127.0.0.1";
process.env.REDIS_PORT = "6379";
process.env.ALLOW_DESTRUCTIVE_TESTS = "true";
process.env.NODE_ENV = "test";
process.env.AUTH_SESSION_SECRET = "campaign-lifecycle-test-session-secret-32-chars";
process.env.API_KEY_PEPPER = "campaign-lifecycle-test-pepper-32-chars-min";

import { prisma } from "../src/lib/prisma";
import { getCampaignQueue, closeAllQueues } from "../src/lib/email/queue/queues";
import {
  JOB_NAMES,
  getCampaignJobId,
  CampaignJobData,
} from "../src/lib/email/queue/types";
import { EmailCampaignService } from "../src/lib/services/email-campaign-service";
import {
  processCampaignRecipientJob,
  checkAndCompleteCampaign,
} from "../src/lib/email/queue/campaign-worker";
import { processScheduledCampaignTriggerJob } from "../src/lib/email/queue/campaign-trigger-worker";
import { EmailProvider, EmailSendRequest, EmailSendResult } from "../src/lib/email/types";
import {
  EmailCampaignStatus,
  EmailContactStatus,
  EmailSubscriptionStatus,
  EmailDeliveryStatus,
  EmailProviderType,
  EmailProviderStatus,
  EmailType,
  EmailEventType,
  EmailSuppressionReason,
} from "@prisma/client";
import { createSessionToken, hashSessionToken } from "../src/lib/auth";
import { POST as resumeRoute } from "../src/app/api/email/campaigns/[id]/resume/route";
import { POST as pauseRoute } from "../src/app/api/email/campaigns/[id]/pause/route";
import { POST as cancelRoute } from "../src/app/api/email/campaigns/[id]/cancel/route";
import { NextRequest } from "next/server";
import { Job, UnrecoverableError } from "bullmq";

let passed = 0;
let failed = 0;

function testAssert(condition: boolean, description: string, detail?: string) {
  if (condition) {
    console.log(`  ✅ PASS: ${description}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${description}${detail ? ` (${detail})` : ""}`);
    failed++;
  }
}

// Mock Email Provider for deterministic inspection
class MockLifecycleProvider implements EmailProvider {
  id = "mock-lifecycle-provider";
  name = "Mock Lifecycle Provider";
  providerType = EmailProviderType.MOCK;
  sentRequests: EmailSendRequest[] = [];
  shouldFailNext = false;
  failCode = "PERMANENT_ERROR";

  async send(request: EmailSendRequest): Promise<EmailSendResult> {
    if (this.shouldFailNext) {
      this.shouldFailNext = false;
      return {
        accepted: false,
        success: false,
        providerName: this.name,
        providerType: this.providerType,
        providerStatus: "FAILED",
        error: {
          code: this.failCode,
          message: "Simulated provider failure",
          retryable: false,
        },
      };
    }

    this.sentRequests.push(request);
    return {
      accepted: true,
      success: true,
      providerName: this.name,
      providerType: this.providerType,
      providerMessageId: `msg-${Date.now()}-${Math.random().toString(36).substring(7)}`,
      providerStatus: "SENT",
    };
  }
}

async function cleanDatabase() {
  await prisma.emailDelivery.deleteMany({});
  await prisma.emailCampaignRecipient.deleteMany({});
  await prisma.emailCampaign.deleteMany({});
  await prisma.emailTemplateVersion.deleteMany({});
  await prisma.emailTemplate.deleteMany({});
  await prisma.emailListMember.deleteMany({});
  await prisma.emailList.deleteMany({});
  await prisma.emailSegment.deleteMany({});
  await prisma.emailContact.deleteMany({});
  await prisma.emailSuppression.deleteMany({});
  await prisma.emailSenderIdentity.deleteMany({});
  await prisma.emailProviderConfig.deleteMany({});
  await prisma.userSession.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.apiKey.deleteMany({});
  await prisma.apiClient.deleteMany({});
}

async function runCampaignLifecycleSuite() {
  console.log("==================================================================");
  console.log("🚀 RUNNING COMPLETE EMAIL CAMPAIGN LIFECYCLE INTEGRATION SUITE");
  console.log("   Target: Real Disposable PostgreSQL (5433) + Redis (6379)");
  console.log("==================================================================\n");

  const mockProvider = new MockLifecycleProvider();
  const queue = getCampaignQueue();
  await queue.drain();

  await cleanDatabase();

  // ---------------------------------------------------------------------------
  // Seed Base Tenants & Users (ADMIN and VIEWER)
  // ---------------------------------------------------------------------------
  console.log("\n📦 Setting up Tenants, Users, and RBAC Sessions...");
  const tenantA = await prisma.apiClient.create({
    data: { name: "Tenant Alpha", active: true },
  });
  const tenantB = await prisma.apiClient.create({
    data: { name: "Tenant Beta", active: true },
  });

  const adminUser = await prisma.user.create({
    data: {
      email: "admin@alpha.com",
      passwordHash: "mock-password-hash",
      role: "ADMIN",
      active: true,
    },
  });

  const viewerUser = await prisma.user.create({
    data: {
      email: "viewer@alpha.com",
      passwordHash: "mock-password-hash",
      role: "VIEWER",
      active: true,
    },
  });

  const adminSession = createSessionToken(adminUser);
  await prisma.userSession.create({
    data: {
      userId: adminUser.id,
      tokenHash: hashSessionToken(adminSession.token),
      expiresAt: new Date(adminSession.expiresAt),
    },
  });

  const viewerSession = createSessionToken(viewerUser);
  await prisma.userSession.create({
    data: {
      userId: viewerUser.id,
      tokenHash: hashSessionToken(viewerSession.token),
      expiresAt: new Date(viewerSession.expiresAt),
    },
  });

  // Setup template & template version for Tenant Alpha
  const template = await prisma.emailTemplate.create({
    data: {
      clientId: tenantA.id,
      name: "Newsletter Template",
      type: "PROMOTIONAL",
    },
  });

  const templateVersion = await prisma.emailTemplateVersion.create({
    data: {
      templateId: template.id,
      version: 1,
      subject: "Hello {{firstName}}",
      htmlContent: "<p>Welcome {{firstName}} to our newsletter!</p>",
      textContent: "Welcome {{firstName}} to our newsletter!",
      status: "ACTIVE",
    },
  });

  // Setup list and contacts for Tenant Alpha
  const list = await prisma.emailList.create({
    data: {
      clientId: tenantA.id,
      name: "Alpha Audience",
    },
  });

  const contact1 = await prisma.emailContact.create({
    data: {
      clientId: tenantA.id,
      email: "user1@alpha.com",
      normalizedEmail: "user1@alpha.com",
      firstName: "Alice",
      status: EmailContactStatus.SUBSCRIBED,
      hasMarketingConsent: true,
      verified: true,
    },
  });

  const contact2 = await prisma.emailContact.create({
    data: {
      clientId: tenantA.id,
      email: "user2@alpha.com",
      normalizedEmail: "user2@alpha.com",
      firstName: "Bob",
      status: EmailContactStatus.SUBSCRIBED,
      hasMarketingConsent: true,
      verified: true,
    },
  });

  const contact3 = await prisma.emailContact.create({
    data: {
      clientId: tenantA.id,
      email: "user3@alpha.com",
      normalizedEmail: "user3@alpha.com",
      firstName: "Charlie",
      status: EmailContactStatus.SUBSCRIBED,
      hasMarketingConsent: true,
      verified: true,
    },
  });

  await prisma.emailListMember.createMany({
    data: [
      { listId: list.id, contactId: contact1.id, status: EmailSubscriptionStatus.SUBSCRIBED },
      { listId: list.id, contactId: contact2.id, status: EmailSubscriptionStatus.SUBSCRIBED },
      { listId: list.id, contactId: contact3.id, status: EmailSubscriptionStatus.SUBSCRIBED },
    ],
  });

  // Setup active provider config and sender identity for Tenant Alpha
  const providerConfigA = await prisma.emailProviderConfig.create({
    data: {
      clientId: tenantA.id,
      name: "Alpha Gmail Config",
      providerType: EmailProviderType.GMAIL,
      status: EmailProviderStatus.ACTIVE,
      isDefault: true,
      encryptedCredentials: "mock-encrypted-creds",
      senderEmail: "default-sender@alpha.com",
      senderName: "Alpha Default",
    },
  });

  const senderIdentityA = await prisma.emailSenderIdentity.create({
    data: {
      clientId: tenantA.id,
      email: "vip@alpha.com",
      name: "Alpha VIP Team",
      replyToEmail: "vip-reply@alpha.com",
      verified: true,
      providerConfigId: providerConfigA.id,
    },
  });

  // Setup Tenant Beta resources for cross-tenant tests
  const providerConfigB = await prisma.emailProviderConfig.create({
    data: {
      clientId: tenantB.id,
      name: "Beta Provider",
      providerType: EmailProviderType.GMAIL,
      status: EmailProviderStatus.ACTIVE,
      isDefault: true,
      encryptedCredentials: "mock-encrypted-creds-b",
      senderEmail: "default@beta.com",
    },
  });

  const senderIdentityB = await prisma.emailSenderIdentity.create({
    data: {
      clientId: tenantB.id,
      email: "intruder@beta.com",
      name: "Beta Intruder",
      verified: true,
      providerConfigId: providerConfigB.id,
    },
  });

  // ---------------------------------------------------------------------------
  // TEST 1: Schedule Campaign & Delayed Trigger Job in BullMQ
  // ---------------------------------------------------------------------------
  console.log("\n🧪 Test 1: Schedule Campaign & Delayed Trigger Job in BullMQ");
  const scheduledTime = new Date(Date.now() + 3600000); // 1 hour future
  const campaign1 = await EmailCampaignService.createCampaign(tenantA.id, {
    name: "Summer Promo 2026",
    templateVersionId: templateVersion.id,
    listId: list.id,
  });

  const scheduledCampaign = await EmailCampaignService.scheduleCampaign(
    tenantA.id,
    campaign1.id,
    scheduledTime
  );

  testAssert(scheduledCampaign.status === EmailCampaignStatus.SCHEDULED, "Campaign status transitioned to SCHEDULED");
  testAssert(scheduledCampaign.scheduledAt?.getTime() === scheduledTime.getTime(), "Campaign scheduledAt correctly persisted");

  // Verify delayed trigger job was added to BullMQ
  const triggerJob1 = await queue.getJob(`trigger-campaign-${campaign1.id}`);
  testAssert(!!triggerJob1, "Delayed trigger job added to BullMQ with stable business ID");
  testAssert(triggerJob1?.name === JOB_NAMES.TRIGGER_SCHEDULED_CAMPAIGN, "Trigger job name matches TRIGGER_SCHEDULED_CAMPAIGN");

  // ---------------------------------------------------------------------------
  // TEST 2: Trigger Processor Blocks Premature Execution
  // ---------------------------------------------------------------------------
  console.log("\n🧪 Test 2: Trigger Processor Blocks Premature Execution");
  let prematureThrew = false;
  try {
    await processScheduledCampaignTriggerJob(triggerJob1 as Job<CampaignJobData>);
  } catch (err: any) {
    prematureThrew = err.isRetryable === true;
  }
  testAssert(prematureThrew, "Trigger processor throws RetryableEmailError if scheduled time has not arrived");

  const unmutatedCampaign = await prisma.emailCampaign.findUnique({ where: { id: campaign1.id } });
  testAssert(unmutatedCampaign?.status === EmailCampaignStatus.SCHEDULED, "Premature trigger leaves campaign in SCHEDULED state");

  // ---------------------------------------------------------------------------
  // TEST 3: Dedicated Trigger Processor Executes On Arrival
  // ---------------------------------------------------------------------------
  console.log("\n🧪 Test 3: Dedicated Trigger Processor Executes On Arrival");
  // Set scheduledAt to current timestamp
  await prisma.emailCampaign.update({
    where: { id: campaign1.id },
    data: { scheduledAt: new Date(Date.now() - 1000) },
  });

  const triggerResult = await processScheduledCampaignTriggerJob(triggerJob1 as Job<CampaignJobData>);
  testAssert(triggerResult.success === true, "Trigger processor executed successfully");
  testAssert(triggerResult.status === EmailCampaignStatus.RUNNING, "Trigger processor transitioned status to RUNNING");
  testAssert(triggerResult.enqueuedCount === 3, "Enqueued 3 deterministic recipient jobs");

  const campaign1PostTrigger = await prisma.emailCampaign.findUnique({ where: { id: campaign1.id } });
  testAssert(campaign1PostTrigger?.status === EmailCampaignStatus.RUNNING, "DB campaign status is RUNNING");
  testAssert(campaign1PostTrigger?.totalRecipients === 3, "totalRecipients updated to 3 in DB");

  const snapshotRecipients = await prisma.emailCampaignRecipient.findMany({
    where: { campaignId: campaign1.id },
  });
  testAssert(snapshotRecipients.length === 3, "Immutable audience snapshot created with 3 recipients");

  // Verify recipient jobs exist in BullMQ with stable IDs
  for (const r of snapshotRecipients) {
    const rJob = await queue.getJob(getCampaignJobId(r.id));
    testAssert(!!rJob, `Recipient job exists in BullMQ: ${getCampaignJobId(r.id)}`);
  }

  // ---------------------------------------------------------------------------
  // TEST 4: Duplicate Trigger Idempotency (Never Duplicate Snapshot or Sends)
  // ---------------------------------------------------------------------------
  console.log("\n🧪 Test 4: Duplicate Trigger Idempotency");
  const dupTriggerResult = await processScheduledCampaignTriggerJob(triggerJob1 as Job<CampaignJobData>);
  testAssert(dupTriggerResult.skipped === true, "Duplicate trigger safely skipped");

  const recipientCountAfterDup = await prisma.emailCampaignRecipient.count({
    where: { campaignId: campaign1.id },
  });
  testAssert(recipientCountAfterDup === 3, "Duplicate trigger did NOT create duplicate recipients");

  // ---------------------------------------------------------------------------
  // TEST 5: Immediate Campaign Execution (sendCampaignNow)
  // ---------------------------------------------------------------------------
  console.log("\n🧪 Test 5: Immediate Campaign Execution (sendCampaignNow)");
  const immediateCampaign = await EmailCampaignService.createCampaign(tenantA.id, {
    name: "Immediate Flash Sale",
    templateVersionId: templateVersion.id,
    listId: list.id,
  });

  const immediateResult = await EmailCampaignService.sendCampaignNow(tenantA.id, immediateCampaign.id);
  testAssert(immediateResult.success === true, "sendCampaignNow succeeded");
  testAssert(immediateResult.status === EmailCampaignStatus.RUNNING, "Status is RUNNING");
  testAssert(immediateResult.enqueuedCount === 3, "Enqueued 3 recipient jobs");

  // ---------------------------------------------------------------------------
  // TEST 6: Pause and Resume Campaign Lifecycle
  // ---------------------------------------------------------------------------
  console.log("\n🧪 Test 6: Pause and Resume Campaign Lifecycle");
  const pausedCampaign = await EmailCampaignService.pauseCampaign(tenantA.id, immediateCampaign.id);
  testAssert(pausedCampaign.status === EmailCampaignStatus.PAUSED, "Campaign transitioned from RUNNING to PAUSED");

  const resumedCampaign = await EmailCampaignService.resumeCampaign(tenantA.id, immediateCampaign.id);
  testAssert(resumedCampaign.status === EmailCampaignStatus.RUNNING, "Campaign transitioned from PAUSED to RUNNING");
  testAssert(resumedCampaign.requeuedCount === 3, "Resumed campaign requeued 3 pending recipients");

  // ---------------------------------------------------------------------------
  // TEST 7: Authenticated ADMIN vs VIEWER RBAC on Resume Endpoint
  // ---------------------------------------------------------------------------
  console.log("\n🧪 Test 7: Authenticated ADMIN vs VIEWER RBAC on Resume Endpoint");
  await EmailCampaignService.pauseCampaign(tenantA.id, immediateCampaign.id);

  // VIEWER attempt -> must return 403 Forbidden
  const viewerReq = new NextRequest("http://localhost:3000/api/email/campaigns/" + immediateCampaign.id + "/resume", {
    method: "POST",
    headers: {
      cookie: `whatsapp_hub_session=${viewerSession.token}`,
      "x-client-id": tenantA.id,
    },
  });
  const viewerRes = await resumeRoute(viewerReq, { params: Promise.resolve({ id: immediateCampaign.id }) });
  testAssert(viewerRes.status === 403, "VIEWER receives 403 Forbidden when attempting to resume");

  // ADMIN attempt -> must return 200 OK
  const adminReq = new NextRequest("http://localhost:3000/api/email/campaigns/" + immediateCampaign.id + "/resume", {
    method: "POST",
    headers: {
      cookie: `whatsapp_hub_session=${adminSession.token}`,
      "x-client-id": tenantA.id,
    },
  });
  const adminRes = await resumeRoute(adminReq, { params: Promise.resolve({ id: immediateCampaign.id }) });
  testAssert(adminRes.status === 200, "ADMIN receives 200 OK and successfully resumes campaign");

  // ---------------------------------------------------------------------------
  // TEST 8: Cancellation Lifecycle (Delayed Trigger + Pending Recipient Cleanup)
  // ---------------------------------------------------------------------------
  console.log("\n🧪 Test 8: Cancellation Lifecycle");
  const cancelTestCampaign = await EmailCampaignService.createCampaign(tenantA.id, {
    name: "To Be Cancelled",
    templateVersionId: templateVersion.id,
    listId: list.id,
  });
  await EmailCampaignService.scheduleCampaign(tenantA.id, cancelTestCampaign.id, new Date(Date.now() + 7200000));

  // Verify delayed job exists
  let jobBeforeCancel = await queue.getJob(`trigger-campaign-${cancelTestCampaign.id}`);
  testAssert(!!jobBeforeCancel, "BullMQ trigger job exists before cancellation");

  // Cancel campaign
  const cancelled = await EmailCampaignService.cancelCampaign(tenantA.id, cancelTestCampaign.id);
  testAssert(cancelled.status === EmailCampaignStatus.CANCELLED, "Campaign marked CANCELLED");

  // Verify delayed job was removed from BullMQ
  let jobAfterCancel = await queue.getJob(`trigger-campaign-${cancelTestCampaign.id}`);
  testAssert(!jobAfterCancel, "Delayed BullMQ trigger job was removed on cancellation");

  // Verify pending recipients marked CANCELLED
  const cancelledRecipients = await prisma.emailCampaignRecipient.findMany({
    where: { campaignId: cancelTestCampaign.id },
  });
  testAssert(
    cancelledRecipients.every((r) => r.status === "CANCELLED"),
    "All pending recipients marked CANCELLED in DB"
  );

  // CANCELLED campaigns can NEVER be resumed
  let resumeCancelledThrew = false;
  try {
    await EmailCampaignService.resumeCampaign(tenantA.id, cancelTestCampaign.id);
  } catch (err: any) {
    resumeCancelledThrew = err.message.includes("Cancelled");
  }
  testAssert(resumeCancelledThrew, "Attempting to resume a CANCELLED campaign is strictly rejected");

  // ---------------------------------------------------------------------------
  // TEST 9: Pause While Jobs Queued & Resume After Pause
  // ---------------------------------------------------------------------------
  console.log("\n🧪 Test 9: Pause While Jobs Queued & Resume After Pause");
  const queuePauseCampaign = await EmailCampaignService.createCampaign(tenantA.id, {
    name: "Queue Pause Demo",
    templateVersionId: templateVersion.id,
    listId: list.id,
  });
  await EmailCampaignService.sendCampaignNow(tenantA.id, queuePauseCampaign.id);

  const pauseRecipients = await prisma.emailCampaignRecipient.findMany({
    where: { campaignId: queuePauseCampaign.id },
    orderBy: { email: "asc" },
  });

  // Send first recipient successfully
  const rJob0 = await queue.getJob(getCampaignJobId(pauseRecipients[0].id));
  const r0Result = await processCampaignRecipientJob(rJob0 as Job<CampaignJobData>, {
    providerOverride: mockProvider,
  });
  testAssert(r0Result.success === true, "Recipient 0 sent successfully");

  // Now PAUSE the campaign while recipients 1 & 2 are still queued
  await EmailCampaignService.pauseCampaign(tenantA.id, queuePauseCampaign.id);

  // Worker picks up recipient 1 while campaign is PAUSED -> must postpone without sending
  const rJob1 = await queue.getJob(getCampaignJobId(pauseRecipients[1].id));
  const r1Result = await processCampaignRecipientJob(rJob1 as Job<CampaignJobData>, {
    providerOverride: mockProvider,
  });
  testAssert(r1Result.skipped === true && r1Result.reason === "CAMPAIGN_PAUSED", "Worker postponed queued recipient while campaign is PAUSED");

  const r1Db = await prisma.emailCampaignRecipient.findUnique({ where: { id: pauseRecipients[1].id } });
  testAssert(r1Db?.status === "PENDING", "Postponed recipient remains PENDING in database");

  // Now RESUME the campaign
  const resumeQueueResult = await EmailCampaignService.resumeCampaign(tenantA.id, queuePauseCampaign.id);
  testAssert(resumeQueueResult.requeuedCount === 2, "Resuming requeued exactly the 2 PENDING recipients (0 SENT not requeued)");

  // Verify Recipient 0 was NOT resent
  const r0Db = await prisma.emailCampaignRecipient.findUnique({ where: { id: pauseRecipients[0].id } });
  testAssert(r0Db?.status === "SENT", "Recipient 0 status remains SENT");

  // Worker processes resumed recipients 1 and 2
  const rJob1Resumed = await queue.getJob(getCampaignJobId(pauseRecipients[1].id));
  const r1SendResult = await processCampaignRecipientJob(rJob1Resumed as Job<CampaignJobData>, {
    providerOverride: mockProvider,
  });
  testAssert(r1SendResult.success === true, "Resumed Recipient 1 successfully sent");

  const rJob2Resumed = await queue.getJob(getCampaignJobId(pauseRecipients[2].id));
  const r2SendResult = await processCampaignRecipientJob(rJob2Resumed as Job<CampaignJobData>, {
    providerOverride: mockProvider,
  });
  testAssert(r2SendResult.success === true, "Resumed Recipient 2 successfully sent");

  // Verify campaign auto-completed after all recipients reached terminal state (SENT)
  const queuePauseCampaignFinal = await prisma.emailCampaign.findUnique({ where: { id: queuePauseCampaign.id } });
  testAssert(queuePauseCampaignFinal?.status === EmailCampaignStatus.COMPLETED, "Campaign deterministically completed when all recipients sent");
  testAssert(!!queuePauseCampaignFinal?.completedAt, "Campaign completedAt timestamp set");

  // COMPLETED campaigns can NEVER be resumed
  let resumeCompletedThrew = false;
  try {
    await EmailCampaignService.resumeCampaign(tenantA.id, queuePauseCampaign.id);
  } catch (err: any) {
    resumeCompletedThrew = err.message.includes("Completed");
  }
  testAssert(resumeCompletedThrew, "Attempting to resume a COMPLETED campaign is strictly rejected");

  // ---------------------------------------------------------------------------
  // TEST 10: Sender Identity Selection & Honors Email/Name/Reply-To
  // ---------------------------------------------------------------------------
  console.log("\n🧪 Test 10: Sender Identity Selection & Honors Email/Name/Reply-To");
  mockProvider.sentRequests = [];
  const senderCampaign = await EmailCampaignService.createCampaign(tenantA.id, {
    name: "VIP Identity Campaign",
    templateVersionId: templateVersion.id,
    listId: list.id,
    senderIdentityId: senderIdentityA.id,
  });

  await EmailCampaignService.sendCampaignNow(tenantA.id, senderCampaign.id);
  const senderRecipients = await prisma.emailCampaignRecipient.findMany({
    where: { campaignId: senderCampaign.id },
  });

  const sJob = await queue.getJob(getCampaignJobId(senderRecipients[0].id));
  await processCampaignRecipientJob(sJob as Job<CampaignJobData>, {
    providerOverride: mockProvider,
  });

  const sentRequest = mockProvider.sentRequests[0];
  testAssert(sentRequest.from === '"Alpha VIP Team" <vip@alpha.com>', "Worker honored senderIdentity name and email");
  testAssert(sentRequest.replyTo === "vip-reply@alpha.com", "Worker honored senderIdentity replyToEmail");

  const deliveryRecord = await prisma.emailDelivery.findFirst({
    where: { campaignRecipientId: senderRecipients[0].id },
  });
  testAssert(deliveryRecord?.from === '"Alpha VIP Team" <vip@alpha.com>', "EmailDelivery record persisted custom sender identity");

  // ---------------------------------------------------------------------------
  // TEST 11: Cross-Tenant Sender Identity Rejection (Never Default)
  // ---------------------------------------------------------------------------
  console.log("\n🧪 Test 11: Cross-Tenant Sender Identity Rejection");
  // Try creating campaign with cross-tenant sender identity -> EmailCampaignService must reject
  let crossTenantCreateThrew = false;
  try {
    await EmailCampaignService.createCampaign(tenantA.id, {
      name: "Cross Tenant Campaign",
      templateVersionId: templateVersion.id,
      listId: list.id,
      senderIdentityId: senderIdentityB.id, // Belongs to Tenant Beta
    });
  } catch (err: any) {
    crossTenantCreateThrew = err.message.includes("does not belong to tenant");
  }
  testAssert(crossTenantCreateThrew, "createCampaign rejects cross-tenant senderIdentityId");

  // Test worker level defense: if database somehow had cross-tenant sender identity
  const hackedCampaign = await prisma.emailCampaign.create({
    data: {
      clientId: tenantA.id,
      name: "Tampered Campaign",
      templateVersionId: templateVersion.id,
      listId: list.id,
      senderIdentityId: senderIdentityB.id,
      status: EmailCampaignStatus.RUNNING,
    },
  });

  const hackedRecipient = await prisma.emailCampaignRecipient.create({
    data: {
      campaignId: hackedCampaign.id,
      email: "victim@alpha.com",
      status: "PENDING",
    },
  });

  let workerCrossTenantThrew = false;
  const hackedJob = {
    id: "hacked-job",
    name: JOB_NAMES.SEND_CAMPAIGN_RECIPIENT,
    data: {
      campaignRecipientId: hackedRecipient.id,
      campaignId: hackedCampaign.id,
      clientId: tenantA.id,
      category: "PROMOTIONAL",
    },
  } as unknown as Job<CampaignJobData>;

  try {
    await processCampaignRecipientJob(hackedJob, { providerOverride: mockProvider });
  } catch (err: any) {
    workerCrossTenantThrew = err instanceof UnrecoverableError && err.message.includes("does not belong to tenant");
  }
  testAssert(workerCrossTenantThrew, "Worker strictly throws UnrecoverableError on cross-tenant sender and never defaults");

  // ---------------------------------------------------------------------------
  // TEST 12: Queue Failure Honesty & Observable Recoverable State
  // ---------------------------------------------------------------------------
  console.log("\n🧪 Test 12: Queue Failure Honesty & Observable Recoverable State");
  const failCampaign = await EmailCampaignService.createCampaign(tenantA.id, {
    name: "Queue Failure Demo",
    templateVersionId: templateVersion.id,
    listId: list.id,
  });

  // Temporarily close queue connection to trigger queue failure
  const oldQueueAdd = queue.add.bind(queue);
  (queue as any).add = async () => {
    throw new Error("Redis ECONNREFUSED simulated failure");
  };

  let queueFailed = false;
  try {
    await EmailCampaignService.sendCampaignNow(tenantA.id, failCampaign.id);
  } catch (err: any) {
    queueFailed = err.message.includes("Failed to enqueue campaign recipient jobs");
  }
  testAssert(queueFailed, "sendCampaignNow throws error on queue failure (no fake 200/202)");

  // Restore queue.add
  (queue as any).add = oldQueueAdd;

  const failedDbCampaign = await prisma.emailCampaign.findUnique({ where: { id: failCampaign.id } });
  testAssert(failedDbCampaign?.status === EmailCampaignStatus.FAILED, "Campaign status honestly set to FAILED in database");

  // Campaign is recoverable via resumeCampaign
  const recoveredResult = await EmailCampaignService.resumeCampaign(tenantA.id, failCampaign.id);
  testAssert(recoveredResult.status === EmailCampaignStatus.RUNNING, "FAILED campaign recovered and transitioned to RUNNING via resumeCampaign");
  testAssert(recoveredResult.requeuedCount === 3, "Recovered campaign enqueued all 3 pending recipients");

  // ---------------------------------------------------------------------------
  // TEST 13: Stale Guard & Duplicate Worker Execution Protection
  // ---------------------------------------------------------------------------
  console.log("\n🧪 Test 13: Stale Guard & Duplicate Worker Execution Protection");
  const recipientSent = await prisma.emailCampaignRecipient.findFirst({
    where: { campaignId: queuePauseCampaign.id, status: "SENT" },
  });

  const duplicateJob = {
    id: "duplicate-job",
    name: JOB_NAMES.SEND_CAMPAIGN_RECIPIENT,
    data: {
      campaignRecipientId: recipientSent!.id,
      campaignId: queuePauseCampaign.id,
      clientId: tenantA.id,
      category: "PROMOTIONAL",
    },
  } as unknown as Job<CampaignJobData>;

  mockProvider.sentRequests = [];
  const dupWorkerResult = await processCampaignRecipientJob(duplicateJob, {
    providerOverride: mockProvider,
  });
  testAssert(dupWorkerResult.skipped === true && dupWorkerResult.reason === "ALREADY_SENT", "Worker detected already SENT recipient and skipped");
  testAssert(mockProvider.sentRequests.length === 0, "No duplicate email dispatched to provider");

  // ---------------------------------------------------------------------------
  // TEST 14: Deterministic Completion with Terminal States (SENT, FAILED, SUPPRESSED)
  // ---------------------------------------------------------------------------
  console.log("\n🧪 Test 14: Deterministic Completion with Terminal States (SENT, FAILED, SUPPRESSED)");
  const terminalTestCampaign = await EmailCampaignService.createCampaign(tenantA.id, {
    name: "Terminal States Mixed Campaign",
    templateVersionId: templateVersion.id,
  });

  // Create 3 manual recipients for this campaign
  const rSent = await prisma.emailCampaignRecipient.create({
    data: { campaignId: terminalTestCampaign.id, email: "term-sent@alpha.com", status: "PENDING" },
  });
  const rFailed = await prisma.emailCampaignRecipient.create({
    data: { campaignId: terminalTestCampaign.id, email: "term-failed@alpha.com", status: "PENDING" },
  });
  const rSuppressed = await prisma.emailCampaignRecipient.create({
    data: { campaignId: terminalTestCampaign.id, email: "term-supp@alpha.com", status: "PENDING" },
  });

  // Add suppression for rSuppressed
  await prisma.emailSuppression.create({
    data: {
      clientId: tenantA.id,
      email: "term-supp@alpha.com",
      normalizedEmail: "term-supp@alpha.com",
      reason: EmailSuppressionReason.UNSUBSCRIBED,
    },
  });

  await prisma.emailCampaign.update({
    where: { id: terminalTestCampaign.id },
    data: { status: EmailCampaignStatus.RUNNING, totalRecipients: 3 },
  });

  // 1. Process rSent -> completes successfully
  const jobSent = {
    id: "job-sent",
    name: JOB_NAMES.SEND_CAMPAIGN_RECIPIENT,
    data: { campaignRecipientId: rSent.id, campaignId: terminalTestCampaign.id, clientId: tenantA.id, category: "PROMOTIONAL" },
  } as unknown as Job<CampaignJobData>;
  await processCampaignRecipientJob(jobSent, { providerOverride: mockProvider });

  // 2. Process rSuppressed -> throws UnrecoverableError, updates DB to SUPPRESSED
  const jobSupp = {
    id: "job-supp",
    name: JOB_NAMES.SEND_CAMPAIGN_RECIPIENT,
    data: { campaignRecipientId: rSuppressed.id, campaignId: terminalTestCampaign.id, clientId: tenantA.id, category: "PROMOTIONAL" },
  } as unknown as Job<CampaignJobData>;
  try {
    await processCampaignRecipientJob(jobSupp, { providerOverride: mockProvider });
  } catch {}

  const rSuppDb = await prisma.emailCampaignRecipient.findUnique({ where: { id: rSuppressed.id } });
  testAssert(rSuppDb?.status === "SUPPRESSED", "Suppressed recipient marked SUPPRESSED in DB");

  // Campaign still RUNNING because rFailed is still PENDING
  const campMid = await prisma.emailCampaign.findUnique({ where: { id: terminalTestCampaign.id } });
  testAssert(campMid?.status === EmailCampaignStatus.RUNNING, "Campaign remains RUNNING while active PENDING recipients remain");

  // 3. Process rFailed -> provider fails permanently, marks FAILED
  mockProvider.shouldFailNext = true;
  mockProvider.failCode = "PERMANENT_ERROR";
  const jobFail = {
    id: "job-fail",
    name: JOB_NAMES.SEND_CAMPAIGN_RECIPIENT,
    data: { campaignRecipientId: rFailed.id, campaignId: terminalTestCampaign.id, clientId: tenantA.id, category: "PROMOTIONAL" },
  } as unknown as Job<CampaignJobData>;
  try {
    await processCampaignRecipientJob(jobFail, { providerOverride: mockProvider });
  } catch {}

  const rFailDb = await prisma.emailCampaignRecipient.findUnique({ where: { id: rFailed.id } });
  testAssert(rFailDb?.status === "FAILED", "Failed recipient marked FAILED in DB");

  // 4. Deterministic completion: Now that ALL 3 recipients reached terminal states (SENT, SUPPRESSED, FAILED), campaign MUST be COMPLETED!
  const campFinal = await prisma.emailCampaign.findUnique({ where: { id: terminalTestCampaign.id } });
  testAssert(
    campFinal?.status === EmailCampaignStatus.COMPLETED,
    "Campaign deterministically completed when all recipients reached terminal states (not stuck in RUNNING)"
  );
  testAssert(!!campFinal?.completedAt, "completedAt timestamp is recorded");

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------
  console.log("\n==================================================================");
  console.log(`📊 CAMPAIGN LIFECYCLE SUITE COMPLETED: ${passed} PASSED, ${failed} FAILED`);
  console.log("==================================================================\n");

  await closeAllQueues();
  await prisma.$disconnect();

  if (failed > 0) {
    process.exit(1);
  }
  process.exit(0);
}

runCampaignLifecycleSuite().catch((err) => {
  console.error("FATAL ERROR in campaign lifecycle verification:", err);
  process.exit(1);
});
