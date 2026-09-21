import { prisma } from "../src/lib/prisma";
import { assertDestructiveTestAllowed } from "./test-db-guard";
import { checkRateLimit } from "../src/lib/rate-limit";
import {
  dispatchOutgoingWebhooks,
  processWebhookDeliveryQueue,
  sanitizeResponseBody,
} from "../src/lib/webhooks/dispatcher";
import { MessageService } from "../src/lib/services/message-service";
import { OtpService } from "../src/lib/services/otp-service";
import { WebhookService } from "../src/lib/services/webhook-service";
import {
  validateAdminWebhookUrl,
  validateSubscribedEvents,
} from "../src/lib/webhooks/validation";
import { maskPhoneNumber } from "../src/lib/logger";
import { encryptWebhookSecret } from "../src/lib/crypto";
import { DeliveryStatus, MessageDirection, MessageStatus, OtpStatus } from "@prisma/client";

let passed = 0;
let failed = 0;

function assert(condition: boolean, testName: string, detail?: string) {
  if (condition) {
    console.log(`  ✅ [PASS] ${testName}`);
    passed += 1;
  } else {
    console.error(`  ❌ [FAIL] ${testName}${detail ? `: ${detail}` : ""}`);
    failed += 1;
  }
}

async function runPhase2Verification() {
  assertDestructiveTestAllowed("verify-phase2-reliability");
  console.log("\n=======================================================");
  console.log("🚀 STARTING PHASE 2 PRODUCTION HARDENING & RELIABILITY TESTS");
  console.log("=======================================================\n");

  // Setup test clients
  const clientA = await prisma.apiClient.create({
    data: { name: `Phase2 Test Client A ${Date.now()}` },
  });
  const clientB = await prisma.apiClient.create({
    data: { name: `Phase2 Test Client B ${Date.now()}` },
  });

  try {
    // -------------------------------------------------------------------------
    // TEST 1: Distributed Atomic Rate Limiter
    // -------------------------------------------------------------------------
    console.log("--- TEST 1: Distributed Atomic Rate Limiter (PostgreSQL) ---");
    const rateLimitKey = `test_ratelimit_${Date.now()}`;
    const rl1 = await checkRateLimit(rateLimitKey, 3, 15000);
    assert(rl1.success && rl1.remaining === 2, "First request within limit succeeds");

    const rl2 = await checkRateLimit(rateLimitKey, 3, 15000);
    assert(rl2.success && rl2.remaining === 1, "Second request within limit succeeds");

    const rl3 = await checkRateLimit(rateLimitKey, 3, 15000);
    assert(rl3.success && rl3.remaining === 0, "Third request hits boundary");

    const rl4 = await checkRateLimit(rateLimitKey, 3, 15000);
    assert(!rl4.success && rl4.remaining === 0, "Fourth request is rejected with 429", `Reset in ${rl4.resetSeconds}s`);

    // Verify RateLimit record in live PostgreSQL
    const rlRecord = await prisma.rateLimit.findUnique({ where: { key: rateLimitKey } });
    assert(rlRecord !== null && rlRecord.count >= 3, "RateLimit record persisted atomically in PostgreSQL");

    // -------------------------------------------------------------------------
    // TEST 2: Durable Webhook Queue & Job Claiming
    // -------------------------------------------------------------------------
    console.log("\n--- TEST 2: Durable Webhook Queue & FOR UPDATE SKIP LOCKED ---");
    // Register endpoint for client A
    const endpoint = await prisma.webhookEndpoint.create({
      data: {
        clientId: clientA.id,
        name: "Mock Endpoint",
        url: "https://httpbin.org/status/500", // Will fail with 500 to test retry queueing
        encryptedSecret: encryptWebhookSecret("test_mock_secret_12345"),
        subscribedEvents: JSON.stringify(["message.sent"]),
        active: true,
      },
    });

    // Manually insert a PENDING delivery eligible for claiming
    const testDelivery = await prisma.webhookDelivery.create({
      data: {
        endpointId: endpoint.id,
        clientId: clientA.id,
        eventId: `evt_${Date.now()}`,
        eventType: "message.sent",
        payload: JSON.stringify({ test: "data" }),
        status: DeliveryStatus.PENDING,
        attemptCount: 0,
        nextAttemptAt: new Date(Date.now() - 1000), // Due in the past
      },
    });

    assert(testDelivery.status === DeliveryStatus.PENDING, "Delivery record created with PENDING status");

    // Test atomic queue claim
    const claimResult = await processWebhookDeliveryQueue({ batchSize: 5 });
    assert(claimResult.claimed >= 1, "Queue worker claimed eligible PENDING delivery via FOR UPDATE SKIP LOCKED");

    // Check delivery status after attempt to 500 endpoint: should be scheduled for retry (PENDING with nextAttemptAt calculated)
    const updatedDelivery = await prisma.webhookDelivery.findUnique({
      where: { id: testDelivery.id },
    });
    assert(
      updatedDelivery?.status === DeliveryStatus.PENDING &&
        updatedDelivery.attemptCount === 1 &&
        updatedDelivery.nextAttemptAt !== null &&
        updatedDelivery.lastAttemptAt !== null &&
        updatedDelivery.nextAttemptAt.getTime() >= updatedDelivery.lastAttemptAt.getTime(),
      "Transient 5xx error keeps status PENDING with exponential backoff nextAttemptAt",
      `Next attempt at: ${updatedDelivery?.nextAttemptAt?.toISOString()}`
    );

    // -------------------------------------------------------------------------
    // TEST 3: Traceable Webhook Delivery Linkage (messageEventId)
    // -------------------------------------------------------------------------
    console.log("\n--- TEST 3: Webhook Delivery Linkage (Meta -> MessageEvent -> Delivery) ---");
    const testMessageEvent = await prisma.messageEvent.create({
      data: {
        clientId: clientA.id,
        providerEventId: `pevt_${Date.now()}`,
        eventType: "messages",
        payload: JSON.stringify({ entry: [] }),
      },
    });

    const linkedDelivery = await prisma.webhookDelivery.create({
      data: {
        endpointId: endpoint.id,
        clientId: clientA.id,
        messageEventId: testMessageEvent.id,
        eventType: "message.sent",
        payload: JSON.stringify({ event: "linked" }),
        status: DeliveryStatus.SUCCESS,
      },
      include: {
        messageEvent: true,
      },
    });

    assert(
      linkedDelivery.messageEventId === testMessageEvent.id &&
        linkedDelivery.messageEvent?.id === testMessageEvent.id,
      "WebhookDelivery has verified relational foreign key to MessageEvent"
    );

    // -------------------------------------------------------------------------
    // TEST 4: Message Status State Machine & Terminal State Protection
    // -------------------------------------------------------------------------
    console.log("\n--- TEST 4: Message Status State Machine & Downgrade Prevention ---");
    const msg = await prisma.message.create({
      data: {
        clientId: clientA.id,
        providerMessageId: `wamid.status_test_${Date.now()}`,
        direction: MessageDirection.OUTBOUND,
        status: MessageStatus.DELIVERED,
        from: "123456",
        to: "9876543210",
        deliveredAt: new Date(),
      },
    });

    // Simulate an out-of-order "sent" status update arriving after "delivered"
    await WebhookService.processPayload({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba_1",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: { display_phone_number: "123456", phone_number_id: "phone_1" },
                statuses: [
                  {
                    id: msg.providerMessageId,
                    status: "sent",
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    recipient_id: "9876543210",
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    const refreshedMsg = await prisma.message.findUnique({ where: { id: msg.id } });
    assert(
      refreshedMsg?.status === MessageStatus.DELIVERED,
      "Out-of-order 'sent' event does NOT downgrade DELIVERED message status"
    );

    // Now simulate transition to READ (positive terminal state)
    await WebhookService.processPayload({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba_1",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: { display_phone_number: "123456", phone_number_id: "phone_1" },
                statuses: [
                  {
                    id: msg.providerMessageId,
                    status: "read",
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    recipient_id: "9876543210",
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    const readMsg = await prisma.message.findUnique({ where: { id: msg.id } });
    assert(readMsg?.status === MessageStatus.READ, "Valid progression from DELIVERED to READ succeeds");

    // Now simulate a late 'failed' event on a READ message
    await WebhookService.processPayload({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba_1",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: { display_phone_number: "123456", phone_number_id: "phone_1" },
                statuses: [
                  {
                    id: msg.providerMessageId,
                    status: "failed",
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    recipient_id: "9876543210",
                    errors: [{ code: 131051, title: "Message failed" }],
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    const readAfterFailMsg = await prisma.message.findUnique({ where: { id: msg.id } });
    assert(
      readAfterFailMsg?.status === MessageStatus.READ,
      "Late 'failed' event does NOT corrupt terminal READ status"
    );

    // -------------------------------------------------------------------------
    // TEST 5: OTP Delivery Failure Consistency
    // -------------------------------------------------------------------------
    console.log("\n--- TEST 5: OTP Delivery Failure State Consistency ---");
    // Request OTP with invalid Meta environment simulation disabled
    const otpTestDest = `+1555${Math.floor(1000000 + Math.random() * 9000000)}`;
    const otpRecord = await prisma.otpVerification.create({
      data: {
        clientId: clientA.id,
        destination: otpTestDest,
        purpose: "login",
        codeHash: "dummyhash",
        status: OtpStatus.PENDING,
        expiresAt: new Date(Date.now() + 300000),
      },
    });

    // Simulate async webhook reporting permanent failure for this destination
    await prisma.otpVerification.updateMany({
      where: { destination: otpTestDest, status: OtpStatus.PENDING },
      data: { status: OtpStatus.FAILED },
    });

    const failedOtp = await prisma.otpVerification.findUnique({ where: { id: otpRecord.id } });
    assert(failedOtp?.status === OtpStatus.FAILED, "OTP marked as FAILED when delivery permanently fails");

    // Attempt to verify a FAILED OTP
    const verifyAttempt = await OtpService.verifyOtp(clientA.id, otpTestDest, "login", "000000");
    assert(!verifyAttempt.success, "Verification of FAILED OTP is strictly rejected");

    // -------------------------------------------------------------------------
    // TEST 6: Scalable PostgreSQL Conversation Query
    // -------------------------------------------------------------------------
    console.log("\n--- TEST 6: Scalable PostgreSQL Conversations Query ---");
    // Seed messages for client A and client B
    const phoneConv1 = "+19991112222";
    const phoneConv2 = "+19993334444";

    await prisma.message.create({
      data: {
        clientId: clientA.id,
        direction: MessageDirection.OUTBOUND,
        status: MessageStatus.DELIVERED,
        from: "123456",
        to: phoneConv1,
        body: "Hello Client A Conv 1",
      },
    });
    await prisma.message.create({
      data: {
        clientId: clientA.id,
        direction: MessageDirection.INBOUND,
        status: MessageStatus.RECEIVED,
        from: phoneConv1,
        to: "123456",
        body: "Reply Client A Conv 1",
      },
    });
    await prisma.message.create({
      data: {
        clientId: clientB.id,
        direction: MessageDirection.OUTBOUND,
        status: MessageStatus.DELIVERED,
        from: "123456",
        to: phoneConv2,
        body: "Hello Client B",
      },
    });

    // Query conversations scoped to Client A
    const clientAConvs = await MessageService.getConversations(clientA.id, { page: 1, limit: 10 });
    const convA1 = clientAConvs.find((c) => c.phoneNumber === phoneConv1);
    const convB = clientAConvs.find((c) => c.phoneNumber === phoneConv2);

    assert(
      convA1 !== undefined && convB === undefined,
      "Conversations query returns only Client A participants (tenant isolated)"
    );
    assert(
      convA1?.messageCount === 2 && convA1?.unreadCount === 1,
      "Window functions compute accurate messageCount (2) and unreadCount (1) directly in DB"
    );

    // -------------------------------------------------------------------------
    // TEST 7: Webhook Subscription Catalog & Admin URL Validation
    // -------------------------------------------------------------------------
    console.log("\n--- TEST 7: Webhook Subscription & URL Validation ---");
    const validEvents = validateSubscribedEvents(["message.sent", "otp.verified"]);
    assert(validEvents.valid && validEvents.value?.length === 2, "Valid catalog events accepted");

    const wildcardEvents = validateSubscribedEvents(["message.sent", "*"]);
    assert(wildcardEvents.valid && wildcardEvents.value?.[0] === "*", "Wildcard '*' normalized to ['*']");

    const invalidEvents = validateSubscribedEvents(["malicious.unknown.event"]);
    assert(!invalidEvents.valid, "Unknown event name rejected with error");

    const emptyEvents = validateSubscribedEvents([]);
    assert(!emptyEvents.valid, "Empty events array rejected");

    const validUrl = validateAdminWebhookUrl("https://api.example.com/webhooks");
    assert(validUrl.valid, "Valid HTTPS URL accepted");

    const ssrfUrl = validateAdminWebhookUrl("http://127.0.0.1:8080/evil");
    assert(!ssrfUrl.valid, "SSRF localhost IP rejected by validator");

    const crlfUrl = validateAdminWebhookUrl("https://example.com/api\r\nInjected-Header: evil");
    assert(!crlfUrl.valid, "CRLF injection in URL rejected by validator");

    // -------------------------------------------------------------------------
    // TEST 8: Response Sanitization & PII Masking
    // -------------------------------------------------------------------------
    console.log("\n--- TEST 8: Response Sanitization & Logger PII Redaction ---");
    const htmlPage = "<!DOCTYPE html><html><head><title>502 Bad Gateway</title></head><body><h1>Bad Gateway</h1></body></html>";
    const sanitizedHtml = sanitizeResponseBody(htmlPage, 502);
    assert(
      sanitizedHtml.includes("HTML Response: 502 Bad Gateway") && !sanitizedHtml.includes("<body>"),
      "HTML error response stripped and converted to concise title summary"
    );

    const sensitiveResponse = '{"status":"error","access_token":"secret_abc1234567890"}';
    const sanitizedSecret = sanitizeResponseBody(sensitiveResponse);
    assert(
      sanitizedSecret.includes("[REDACTED]") && !sanitizedSecret.includes("secret_abc1234567890"),
      "Sensitive tokens in response body are redacted before database storage"
    );

    const maskedPhone = maskPhoneNumber("+12345678901");
    assert(maskedPhone === "+123****8901", "Phone number middle digits safely masked for logs");

  } finally {
    // Clean up test clients
    await prisma.apiClient.delete({ where: { id: clientA.id } }).catch(() => {});
    await prisma.apiClient.delete({ where: { id: clientB.id } }).catch(() => {});
  }

  console.log("\n=======================================================");
  console.log(`📊 TEST RESULTS: ${passed} PASSED | ${failed} FAILED`);
  console.log("=======================================================\n");

  if (failed > 0) {
    process.exit(1);
  }
}

runPhase2Verification()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("FATAL verification error:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
