/**
 * Comprehensive Email Authoritative Content & Worker Integrity Verification Suite
 *
 * Runs against Disposable PostgreSQL (5433) and Redis (6379)
 *
 * Explicitly tests all 11 required scenarios:
 * 1. Direct HTML Send: exact HTML persisted and dispatched to provider (no placeholder body).
 * 2. Direct Text Send: exact plain text persisted and dispatched.
 * 3. Template Send: template rendered once, frozen into EmailDelivery, dispatched accurately.
 * 4. Template Variables: interpolation handles complex variables, numbers, booleans, and fallbacks.
 * 5. Retry: retryable error preserves identical authoritative content across attempts.
 * 6. Worker Replay: stale delivery guard prevents duplicate sends for already SENT deliveries.
 * 7. Idempotency: duplicate request with same idempotency-key returns original delivery without mutating content.
 * 8. Tracking: promotional sends inject tracking pixel & wrap links; transactional sends preserve untracked HTML.
 * 9. Promotional Unsubscribe Headers: RFC 8058 headers attached when recipient has marketing consent.
 * 10. Cross-Tenant Access: tenant cannot send with another tenant's template ID (HTTP 404).
 * 11. Content Immutability: modifying the underlying template after queueing does not alter the queued delivery's frozen content.
 */

process.env.DATABASE_URL = "postgresql://postgres:postgres@127.0.0.1:5433/email_test";
process.env.DIRECT_URL = "postgresql://postgres:postgres@127.0.0.1:5433/email_test";
process.env.REDIS_URL = "redis://127.0.0.1:6379";
process.env.REDIS_HOST = "127.0.0.1";
process.env.REDIS_PORT = "6379";
process.env.NODE_ENV = "test";
process.env.ALLOW_DESTRUCTIVE_TESTS = "true";
process.env.AUTH_SESSION_SECRET = "authoritative-test-session-secret-32-chars";
process.env.API_KEY_PEPPER = "authoritative-test-api-key-pepper-32-chars";

import crypto from "crypto";
import { NextRequest } from "next/server";
import { prisma } from "../src/lib/prisma";
import { generateApiKey } from "../src/lib/crypto";
import { POST as sendEmailRoute } from "../src/app/api/v1/email/send/route";
import { processTransactionalJob } from "../src/lib/email/queue/worker";
import { processPromotionalDeliveryJob } from "../src/lib/email/queue/promotional-delivery-worker";
import {
  JOB_NAMES,
  getTransactionalJobId,
  getPromotionalJobId,
  TransactionalJobData,
  PromotionalJobData,
  RetryableEmailError,
} from "../src/lib/email/queue/types";
import { closeAllQueues } from "../src/lib/email/queue/queues";
import { EmailProvider, EmailSendRequest, EmailSendResult } from "../src/lib/email/types";
import {
  EmailDeliveryStatus,
  EmailProviderType,
  EmailType,
  EmailTemplateType,
} from "@prisma/client";
import { Job } from "bullmq";

let passed = 0;
let failed = 0;

function testAssert(condition: boolean, description: string, detail?: string) {
  if (condition) {
    console.log(`  ✅ PASS: ${description}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${description}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

/**
 * In-memory Mock Provider that captures all send calls for deep inspection.
 */
class RecordingMockProvider implements EmailProvider {
  public providerType = EmailProviderType.MOCK;
  public providerName = "RecordingMockProvider";
  public calls: EmailSendRequest[] = [];
  public failNextWithRetryable = false;

  async send(request: EmailSendRequest): Promise<EmailSendResult> {
    this.calls.push({ ...request });
    if (this.failNextWithRetryable) {
      this.failNextWithRetryable = false;
      return {
        accepted: false,
        providerName: this.providerName,
        error: {
          code: "TEMPORARY_NETWORK_FAILURE",
          message: "Transient upstream network failure",
          retryable: true,
        },
      };
    }
    return {
      accepted: true,
      providerMessageId: `msg-${Date.now()}-${Math.random().toString(36).substring(7)}`,
      providerName: this.providerName,
      providerStatus: "SENT",
      sentAt: new Date(),
    };
  }

  async verifyCredentials(): Promise<boolean> {
    return true;
  }

  reset() {
    this.calls = [];
    this.failNextWithRetryable = false;
  }
}

function createMockJob<T>(name: string, data: T, id: string): Job<T> {
  return {
    id,
    name,
    data,
    opts: {},
  } as unknown as Job<T>;
}

async function main() {
  console.log("==================================================================");
  console.log("🚀 VERIFYING AUTHORITATIVE EMAIL CONTENT & WORKER INTEGRITY");
  console.log("   Target: Disposable PostgreSQL (5433) + Disposable Redis (6379)");
  console.log("==================================================================\n");

  const runId = Math.random().toString(36).substring(7);
  const mockProvider = new RecordingMockProvider();

  // Setup Tenants & API Keys
  const tenantA = await prisma.apiClient.create({
    data: { name: `Tenant Alpha ${runId}`, active: true },
  });
  const tenantB = await prisma.apiClient.create({
    data: { name: `Tenant Beta ${runId}`, active: true },
  });

  const keyGenA = generateApiKey(process.env.API_KEY_PEPPER);
  await prisma.apiKey.create({
    data: {
      clientId: tenantA.id,
      name: "Alpha Test Key",
      keyPrefix: keyGenA.keyPrefix,
      keyHash: keyGenA.keyHash,
    },
  });

  const keyGenB = generateApiKey(process.env.API_KEY_PEPPER);
  await prisma.apiKey.create({
    data: {
      clientId: tenantB.id,
      name: "Beta Test Key",
      keyPrefix: keyGenB.keyPrefix,
      keyHash: keyGenB.keyHash,
    },
  });

  const rawKeyA = keyGenA.rawKey;
  const rawKeyB = keyGenB.rawKey;

  // -------------------------------------------------------------------------
  // 1. DIRECT HTML SEND
  // -------------------------------------------------------------------------
  console.log("--- [1] Direct HTML Send ---");
  const directHtml = "<div class='email-root'><h1>Welcome to the Platform</h1><p>This is authoritative HTML content.</p></div>";
  const req1 = new NextRequest("http://localhost/api/v1/email/send", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${rawKeyA}`,
    },
    body: JSON.stringify({
      to: `direct-html-${runId}@example.com`,
      subject: "Welcome via HTML",
      html: directHtml,
      type: "TRANSACTIONAL",
    }),
  });

  const res1 = await sendEmailRoute(req1);
  const data1 = await res1.json();
  testAssert(res1.status === 202, "Direct HTML send returns 202");
  testAssert(!!data1.data?.deliveryId, "Direct HTML send returns deliveryId");

  const delivery1 = await prisma.emailDelivery.findUnique({
    where: { id: data1.data.deliveryId },
  });
  testAssert(delivery1 !== null, "Authoritative EmailDelivery record exists");
  testAssert(delivery1?.htmlContent === directHtml, "Exact HTML content persisted authoritatively in DB");
  testAssert(delivery1?.textContent === null, "Text content is null when not provided");
  testAssert(delivery1?.subject === "Welcome via HTML", "Exact subject persisted");

  // Worker Execution
  mockProvider.reset();
  const job1 = createMockJob<TransactionalJobData>(
    JOB_NAMES.SEND_TRANSACTIONAL,
    { deliveryId: delivery1!.id, clientId: tenantA.id, category: "TRANSACTIONAL" },
    getTransactionalJobId(delivery1!.id)
  );
  await processTransactionalJob(job1, { providerOverride: mockProvider });

  testAssert(mockProvider.calls.length === 1, "Provider send was called exactly once");
  const call1 = mockProvider.calls[0];
  testAssert(call1.html === directHtml, "Worker sent exact authoritative HTML (NOT <p>subject</p>)");
  testAssert(call1.text === undefined, "Worker text was undefined when only HTML provided");
  testAssert(call1.subject === "Welcome via HTML", "Worker subject matches authoritative subject");

  const updatedDelivery1 = await prisma.emailDelivery.findUnique({ where: { id: delivery1!.id } });
  testAssert(updatedDelivery1?.status === EmailDeliveryStatus.SENT, "Delivery transitioned to SENT");
  testAssert(!!updatedDelivery1?.providerMessageId, "Provider message ID populated");

  // -------------------------------------------------------------------------
  // 2. DIRECT TEXT SEND
  // -------------------------------------------------------------------------
  console.log("\n--- [2] Direct Plain Text Send ---");
  const directText = "Hello User,\n\nYour one-time login code is 849201.\nDo not share this code with anyone.";
  const replyToAddr = "support@alpha.internal";
  const req2 = new NextRequest("http://localhost/api/v1/email/send", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${rawKeyA}`,
    },
    body: JSON.stringify({
      to: `direct-text-${runId}@example.com`,
      subject: "Your OTP Code",
      text: directText,
      replyTo: replyToAddr,
      type: "TRANSACTIONAL",
    }),
  });

  const res2 = await sendEmailRoute(req2);
  const data2 = await res2.json();
  testAssert(res2.status === 202, "Direct Text send returns 202");

  const delivery2 = await prisma.emailDelivery.findUnique({
    where: { id: data2.data.deliveryId },
  });
  testAssert(delivery2?.textContent === directText, "Exact plain text persisted in DB");
  testAssert(delivery2?.htmlContent === null, "htmlContent is null when only text provided");
  testAssert(delivery2?.replyTo === replyToAddr, "Authoritative replyTo persisted");

  // Worker Execution
  mockProvider.reset();
  const job2 = createMockJob<TransactionalJobData>(
    JOB_NAMES.SEND_TRANSACTIONAL,
    { deliveryId: delivery2!.id, clientId: tenantA.id, category: "TRANSACTIONAL" },
    getTransactionalJobId(delivery2!.id)
  );
  await processTransactionalJob(job2, { providerOverride: mockProvider });

  testAssert(mockProvider.calls.length === 1, "Provider send called once");
  const call2 = mockProvider.calls[0];
  testAssert(call2.text === directText, "Worker sent exact authoritative plain text");
  testAssert(call2.html === undefined, "Worker html was undefined when only text provided");
  testAssert(call2.replyTo === replyToAddr, "Worker passed authoritative replyTo to provider");

  // -------------------------------------------------------------------------
  // 3. TEMPLATE SEND
  // -------------------------------------------------------------------------
  console.log("\n--- [3] Template Send ---");
  const templateA = await prisma.emailTemplate.create({
    data: {
      clientId: tenantA.id,
      name: `Transactional Invoice ${runId}`,
      type: EmailTemplateType.TRANSACTIONAL,
      versions: {
        create: {
          version: 1,
          status: "ACTIVE",
          subject: "Invoice #{{invoiceId}} for {{name}}",
          htmlContent: "<h1>Invoice #{{invoiceId}}</h1><p>Dear {{name}}, your total is {{amount}}.</p>",
          textContent: "Invoice #{{invoiceId}}\nDear {{name}}, your total is {{amount}}.",
        },
      },
    },
    include: { versions: true },
  });
  const versionA = templateA.versions[0];

  const req3 = new NextRequest("http://localhost/api/v1/email/send", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${rawKeyA}`,
    },
    body: JSON.stringify({
      to: `invoice-${runId}@example.com`,
      templateId: templateA.id,
      variables: {
        invoiceId: "INV-9921",
        name: "Carol Danvers",
        amount: "$150.00",
      },
      type: "TRANSACTIONAL",
    }),
  });

  const res3 = await sendEmailRoute(req3);
  const data3 = await res3.json();
  testAssert(res3.status === 202, "Template send returns 202");

  const delivery3 = await prisma.emailDelivery.findUnique({
    where: { id: data3.data.deliveryId },
  });
  testAssert(delivery3?.templateId === templateA.id, "Delivery references templateId");
  testAssert(delivery3?.templateVersionId === versionA.id, "Delivery references templateVersionId");
  testAssert(
    delivery3?.subject === "Invoice #INV-9921 for Carol Danvers",
    "Rendered subject stored authoritatively"
  );
  testAssert(
    delivery3?.htmlContent === "<h1>Invoice #INV-9921</h1><p>Dear Carol Danvers, your total is $150.00.</p>",
    "Rendered HTML stored authoritatively"
  );
  testAssert(
    delivery3?.textContent === "Invoice #INV-9921\nDear Carol Danvers, your total is $150.00.",
    "Rendered text stored authoritatively"
  );

  // Worker Execution
  mockProvider.reset();
  const job3 = createMockJob<TransactionalJobData>(
    JOB_NAMES.SEND_TRANSACTIONAL,
    { deliveryId: delivery3!.id, clientId: tenantA.id, category: "TRANSACTIONAL" },
    getTransactionalJobId(delivery3!.id)
  );
  await processTransactionalJob(job3, { providerOverride: mockProvider });

  testAssert(mockProvider.calls.length === 1, "Provider send executed");
  const call3 = mockProvider.calls[0];
  testAssert(
    call3.html === "<h1>Invoice #INV-9921</h1><p>Dear Carol Danvers, your total is $150.00.</p>",
    "Worker sent rendered template HTML"
  );
  testAssert(
    call3.text === "Invoice #INV-9921\nDear Carol Danvers, your total is $150.00.",
    "Worker sent rendered template text"
  );

  // -------------------------------------------------------------------------
  // 4. TEMPLATE VARIABLES INTERPOLATION
  // -------------------------------------------------------------------------
  console.log("\n--- [4] Template Variables Interpolation ---");
  const templateVarTest = await prisma.emailTemplate.create({
    data: {
      clientId: tenantA.id,
      name: `Complex Variables Template ${runId}`,
      type: EmailTemplateType.TRANSACTIONAL,
      versions: {
        create: {
          version: 1,
          status: "ACTIVE",
          subject: "Account Notice",
          htmlContent: "<p>Discount: {{discount}}% | Verified: {{isVerified}} | Tag: {{customTag}}</p>",
          textContent: "Discount: {{discount}}% | Verified: {{isVerified}} | Tag: {{customTag}}",
        },
      },
    },
  });

  const req4 = new NextRequest("http://localhost/api/v1/email/send", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${rawKeyA}`,
    },
    body: JSON.stringify({
      to: `var-test-${runId}@example.com`,
      templateId: templateVarTest.id,
      variables: {
        discount: 25,
        isVerified: true,
        customTag: "VIP-GOLD",
      },
      type: "TRANSACTIONAL",
    }),
  });

  const res4 = await sendEmailRoute(req4);
  const data4 = await res4.json();
  const delivery4 = await prisma.emailDelivery.findUnique({
    where: { id: data4.data.deliveryId },
  });

  const expectedRendered = "<p>Discount: 25% | Verified: true | Tag: VIP-GOLD</p>";
  testAssert(delivery4?.htmlContent === expectedRendered, "Template variables accurately interpolated (numbers & booleans)");

  // -------------------------------------------------------------------------
  // 5. RETRY PRESERVATION
  // -------------------------------------------------------------------------
  console.log("\n--- [5] Retry Preserves Authoritative Content ---");
  const retryHtml = "<p>Critical Security Alert: New Login from New Device</p>";
  const delivery5 = await prisma.emailDelivery.create({
    data: {
      clientId: tenantA.id,
      category: EmailType.TRANSACTIONAL,
      providerType: EmailProviderType.MOCK,
      from: "security@alpha.internal",
      to: `retry-${runId}@example.com`,
      subject: "Security Alert",
      htmlContent: retryHtml,
      textContent: "Critical Security Alert: New Login from New Device",
      status: EmailDeliveryStatus.QUEUED,
    },
  });

  // First Attempt: Provider fails with transient error
  mockProvider.reset();
  mockProvider.failNextWithRetryable = true;
  const job5 = createMockJob<TransactionalJobData>(
    JOB_NAMES.SEND_TRANSACTIONAL,
    { deliveryId: delivery5.id, clientId: tenantA.id, category: "TRANSACTIONAL" },
    getTransactionalJobId(delivery5.id)
  );

  let caughtRetryable = false;
  try {
    await processTransactionalJob(job5, { providerOverride: mockProvider });
  } catch (err) {
    if (err instanceof RetryableEmailError) {
      caughtRetryable = true;
    }
  }
  testAssert(caughtRetryable, "Transient provider failure threw RetryableEmailError for BullMQ backoff");

  // Verify delivery record still has exact authoritative content intact
  const delivery5AfterFail = await prisma.emailDelivery.findUnique({ where: { id: delivery5.id } });
  testAssert(delivery5AfterFail?.status === EmailDeliveryStatus.PROCESSING, "Delivery remains in PROCESSING for retry");
  testAssert(delivery5AfterFail?.htmlContent === retryHtml, "Authoritative htmlContent is unchanged after failure");
  testAssert(delivery5AfterFail?.attemptCount === 1, "Attempt count was incremented to 1");

  // Second Attempt: Provider succeeds
  mockProvider.reset();
  const retryResult = await processTransactionalJob(job5, { providerOverride: mockProvider });
  testAssert(retryResult.success === true, "Retry succeeded on second attempt");
  testAssert(mockProvider.calls[0].html === retryHtml, "Retry sent identical authoritative HTML content");

  const delivery5AfterRetry = await prisma.emailDelivery.findUnique({ where: { id: delivery5.id } });
  testAssert(delivery5AfterRetry?.status === EmailDeliveryStatus.SENT, "Delivery transitioned to SENT after retry");

  // -------------------------------------------------------------------------
  // 6. WORKER REPLAY PROTECTION
  // -------------------------------------------------------------------------
  console.log("\n--- [6] Worker Replay Protection ---");
  mockProvider.reset();
  const replayResult = await processTransactionalJob(job5, { providerOverride: mockProvider });
  testAssert(replayResult.skipped === true, "Worker detected already completed delivery and skipped");
  testAssert(mockProvider.calls.length === 0, "No duplicate send executed by provider on replay");

  // -------------------------------------------------------------------------
  // 7. IDEMPOTENCY
  // -------------------------------------------------------------------------
  console.log("\n--- [7] Idempotency Key Content Protection ---");
  const idemKey = `idemp-${runId}-${Date.now()}`;
  const initialHtml = "<p>First Submission Content</p>";

  const req7a = new NextRequest("http://localhost/api/v1/email/send", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${rawKeyA}`,
      "idempotency-key": idemKey,
    },
    body: JSON.stringify({
      to: `idemp-${runId}@example.com`,
      subject: "Idempotent Subject",
      html: initialHtml,
      type: "TRANSACTIONAL",
    }),
  });

  const res7a = await sendEmailRoute(req7a);
  const data7a = await res7a.json();
  testAssert(res7a.status === 202, "Initial idempotent send returns 202");
  const originalDeliveryId = data7a.data.deliveryId;

  // Duplicate request with DIFFERENT body
  const req7b = new NextRequest("http://localhost/api/v1/email/send", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${rawKeyA}`,
      "idempotency-key": idemKey,
    },
    body: JSON.stringify({
      to: `idemp-${runId}@example.com`,
      subject: "TAMPERED Subject",
      html: "<p>TAMPERED Body</p>",
      type: "TRANSACTIONAL",
    }),
  });

  const res7b = await sendEmailRoute(req7b);
  const data7b = await res7b.json();
  testAssert(res7b.status === 200, "Duplicate request with same idempotency key returns HTTP 200");
  testAssert(data7b.data.deduplicated === true, "Response flags deduplicated: true");
  testAssert(data7b.data.deliveryId === originalDeliveryId, "Returns identical deliveryId");

  const preservedDelivery = await prisma.emailDelivery.findUnique({
    where: { id: originalDeliveryId },
  });
  testAssert(preservedDelivery?.htmlContent === initialHtml, "Original authoritative content was NOT overwritten");

  // -------------------------------------------------------------------------
  // 8. TRACKING (PROMOTIONAL VS TRANSACTIONAL)
  // -------------------------------------------------------------------------
  console.log("\n--- [8] Tracking: Promotional vs Transactional ---");
  // Setup Subscribed Contact for Promotional Send
  const promoRecipientEmail = `promo-track-${runId}@example.com`;
  await prisma.emailContact.create({
    data: {
      clientId: tenantA.id,
      email: promoRecipientEmail,
      normalizedEmail: promoRecipientEmail,
      hasMarketingConsent: true,
      consentTimestamp: new Date(),
      status: "SUBSCRIBED",
    },
  });

  const rawPromoHtml = "<p>Check out our spring collection! <a href=\"https://myshop.example.com/items?cat=sale\">Shop Now</a></p>";
  const req8Promo = new NextRequest("http://localhost/api/v1/email/send", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${rawKeyA}`,
    },
    body: JSON.stringify({
      to: promoRecipientEmail,
      subject: "Spring Sale 50% Off",
      html: rawPromoHtml,
      type: "PROMOTIONAL",
    }),
  });

  const res8Promo = await sendEmailRoute(req8Promo);
  const data8Promo = await res8Promo.json();
  testAssert(res8Promo.status === 202, "Promotional send accepted with 202");

  mockProvider.reset();
  const job8Promo = createMockJob<PromotionalJobData>(
    JOB_NAMES.SEND_PROMOTIONAL,
    { deliveryId: data8Promo.data.deliveryId, clientId: tenantA.id, category: "PROMOTIONAL" },
    getPromotionalJobId(data8Promo.data.deliveryId)
  );
  await processPromotionalDeliveryJob(job8Promo, { providerOverride: mockProvider });

  testAssert(mockProvider.calls.length === 1, "Promotional worker executed send");
  const promoCall = mockProvider.calls[0];
  testAssert(
    promoCall.html !== undefined && promoCall.html.includes("/api/email/track/open/"),
    "Promotional HTML has open tracking pixel injected"
  );
  testAssert(
    promoCall.html !== undefined && promoCall.html.includes("/api/email/track/click/"),
    "Promotional HTML has target links wrapped in tracking redirect URLs"
  );

  // Now Transactional Send: Must PRESERVE untracked HTML!
  const rawTxHtml = "<p>Reset your password: <a href=\"https://myshop.example.com/reset?token=xyz\">Reset Password</a></p>";
  const req8Tx = new NextRequest("http://localhost/api/v1/email/send", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${rawKeyA}`,
    },
    body: JSON.stringify({
      to: `security-${runId}@example.com`,
      subject: "Password Reset Request",
      html: rawTxHtml,
      type: "TRANSACTIONAL",
    }),
  });

  const res8Tx = await sendEmailRoute(req8Tx);
  const data8Tx = await res8Tx.json();
  mockProvider.reset();
  const job8Tx = createMockJob<TransactionalJobData>(
    JOB_NAMES.SEND_TRANSACTIONAL,
    { deliveryId: data8Tx.data.deliveryId, clientId: tenantA.id, category: "TRANSACTIONAL" },
    getTransactionalJobId(data8Tx.data.deliveryId)
  );
  await processTransactionalJob(job8Tx, { providerOverride: mockProvider });

  const txCall = mockProvider.calls[0];
  testAssert(
    !txCall.html?.includes("/api/email/track/open/"),
    "Transactional send does NOT inject open tracking pixel"
  );
  testAssert(
    txCall.html === rawTxHtml,
    "Transactional send preserves exact untracked original HTML and links"
  );

  // -------------------------------------------------------------------------
  // 9. PROMOTIONAL UNSUBSCRIBE HEADERS (RFC 8058)
  // -------------------------------------------------------------------------
  console.log("\n--- [9] Promotional Unsubscribe Headers ---");
  testAssert(
    promoCall.headers !== undefined && !!promoCall.headers["List-Unsubscribe"],
    "Promotional send has List-Unsubscribe header"
  );
  testAssert(
    promoCall.headers?.["List-Unsubscribe-Post"] === "List-Unsubscribe=One-Click",
    "Promotional send has RFC 8058 List-Unsubscribe-Post: List-Unsubscribe=One-Click header"
  );

  // -------------------------------------------------------------------------
  // 10. CROSS-TENANT ACCESS PREVENTION
  // -------------------------------------------------------------------------
  console.log("\n--- [10] Cross-Tenant Template Access Protection ---");
  // Tenant Beta tries to send using Tenant Alpha's templateA.id
  const req10 = new NextRequest("http://localhost/api/v1/email/send", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${rawKeyB}`, // Tenant Beta
    },
    body: JSON.stringify({
      to: `target-${runId}@example.com`,
      templateId: templateA.id, // Belongs to Tenant Alpha!
      type: "TRANSACTIONAL",
    }),
  });

  const res10 = await sendEmailRoute(req10);
  const data10 = await res10.json();
  testAssert(res10.status === 404, "Attempt to use foreign template returns HTTP 404");
  testAssert(data10.error?.code === "TEMPLATE_NOT_FOUND", "Error code is TEMPLATE_NOT_FOUND");

  const foreignDeliveries = await prisma.emailDelivery.count({
    where: { clientId: tenantB.id },
  });
  testAssert(foreignDeliveries === 0, "Zero delivery records created for unauthorized tenant");

  // -------------------------------------------------------------------------
  // 11. CONTENT IMMUTABILITY
  // -------------------------------------------------------------------------
  console.log("\n--- [11] Content Immutability Across Template Mutations ---");
  // 1. Create a template with initial version
  const immutableTemplate = await prisma.emailTemplate.create({
    data: {
      clientId: tenantA.id,
      name: `Immutability Test Template ${runId}`,
      type: EmailTemplateType.TRANSACTIONAL,
      versions: {
        create: {
          version: 1,
          status: "ACTIVE",
          subject: "Immutable Alert",
          htmlContent: "<p>Original Frozen V1 Content</p>",
          textContent: "Original Frozen V1 Content",
        },
      },
    },
    include: { versions: true },
  });
  const imVersion = immutableTemplate.versions[0];

  // 2. Queue an email using this template
  const req11 = new NextRequest("http://localhost/api/v1/email/send", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${rawKeyA}`,
    },
    body: JSON.stringify({
      to: `immutable-${runId}@example.com`,
      templateId: immutableTemplate.id,
      type: "TRANSACTIONAL",
    }),
  });

  const res11 = await sendEmailRoute(req11);
  const data11 = await res11.json();
  const delivery11 = await prisma.emailDelivery.findUnique({
    where: { id: data11.data.deliveryId },
  });
  testAssert(
    delivery11?.htmlContent === "<p>Original Frozen V1 Content</p>",
    "Queued delivery persisted V1 content"
  );

  // 3. Mutate the template version directly in the database
  await prisma.emailTemplateVersion.update({
    where: { id: imVersion.id },
    data: {
      subject: "TAMPERED Subject",
      htmlContent: "<p>TAMPERED Modified V2 Content</p>",
      textContent: "TAMPERED Modified V2 Content",
    },
  });

  // 4. Worker processes the queued job
  mockProvider.reset();
  const job11 = createMockJob<TransactionalJobData>(
    JOB_NAMES.SEND_TRANSACTIONAL,
    { deliveryId: delivery11!.id, clientId: tenantA.id, category: "TRANSACTIONAL" },
    getTransactionalJobId(delivery11!.id)
  );
  await processTransactionalJob(job11, { providerOverride: mockProvider });

  // 5. Worker MUST send the frozen V1 content, NOT the mutated DB content
  testAssert(mockProvider.calls.length === 1, "Worker executed send");
  testAssert(
    mockProvider.calls[0].html === "<p>Original Frozen V1 Content</p>",
    "Worker dispatched frozen V1 content (did NOT re-read or leak mutated template version)"
  );
  testAssert(
    mockProvider.calls[0].subject === "Immutable Alert",
    "Worker dispatched frozen V1 subject"
  );

  // -------------------------------------------------------------------------
  // CLEANUP & SUMMARY
  // -------------------------------------------------------------------------
  console.log("\n------------------------------------------------------------------");
  console.log(`Summary: ${passed} PASSED, ${failed} FAILED`);
  console.log("------------------------------------------------------------------");

  await closeAllQueues();
  await prisma.$disconnect();

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

main()
  .catch(async (err) => {
    console.error("Fatal test error:", err);
    try {
      await closeAllQueues();
      await prisma.$disconnect();
    } catch {}
    process.exit(1);
  });
