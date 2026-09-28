/**
 * Comprehensive Email Webhook Security & Tenant Isolation Verification Suite
 *
 * Real disposable PostgreSQL + Redis integration test suite validating:
 * 1. Provider event uniqueness (provider-scoped event identity, no cross-provider collision).
 * 2. Strict tenant correlation (never correlate solely through recipient email).
 * 3. Mandatory provider configuration binding (webhooks must be bound to active EmailProviderConfig).
 * 4. Gmail Pub/Sub authenticity (fail-closed token verification, constant-time comparison).
 * 5. AWS SES/SNS authenticity (real RSA cryptographic signature verification, cert validation, fail-closed).
 * 6. Replay protection (timestamp expiration and idempotent replay handling).
 * 7. Strict normalized payload validation (eventType, recipient syntax, providerEventId, timestamp rationality).
 * 8. Secret handling (zero secret or credential logging).
 * 9. Monotonic terminal delivery states (monotonic state machine, idempotent complaint metrics).
 * 10. Cross-tenant isolation (same recipient across multiple tenants never causes event cross-correlation).
 * 11. Cross-provider collision resistance (same event ID across providers correctly isolated).
 */

process.env.DATABASE_URL = "postgresql://postgres:postgres@127.0.0.1:5433/email_test";
process.env.DIRECT_URL = "postgresql://postgres:postgres@127.0.0.1:5433/email_test";
process.env.REDIS_URL = "redis://127.0.0.1:6379";
process.env.REDIS_HOST = "127.0.0.1";
process.env.REDIS_PORT = "6379";
process.env.ALLOW_DESTRUCTIVE_TESTS = "true";
process.env.NODE_ENV = "test";
process.env.AUTH_SESSION_SECRET = "webhook-security-session-secret-32-chars";
process.env.API_KEY_PEPPER = "webhook-security-pepper-32-chars-min";

import crypto from "crypto";
import { NextRequest } from "next/server";
import { prisma } from "../src/lib/prisma";
import { closeAllQueues, getEventsQueue } from "../src/lib/email/queue/queues";
import { POST as webhookRoute } from "../src/app/api/email/webhooks/[provider]/route";
import {
  EmailEventService,
  canTransitionDeliveryStatus,
} from "../src/lib/services/email-event-service";
import {
  verifyHmacWebhookSignature,
  verifyGmailPubSubWebhook,
  verifyAwsSesWebhook,
  verifyAwsSesWebhookAsync,
  buildSnsCanonicalString,
  setSnsCertCache,
  clearSnsCertCache,
  isValidAwsCertUrl,
  isPrivateIp,
  fetchAwsSnsCertificate,
} from "../src/lib/email/webhooks/verifier";
import {
  normalizeGenericEvent,
  validateNormalizedEvent,
} from "../src/lib/email/webhooks/normalizer";
import { redactSecrets } from "../src/lib/crypto";
import {
  EmailDeliveryStatus,
  EmailEventType,
  EmailProviderType,
  EmailContactStatus,
  EmailSuppressionReason,
  EmailEventProcessingStatus,
  EmailCampaignStatus,
} from "@prisma/client";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    console.log(`  ✅ PASS: ${message}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${message}`);
    failed++;
    throw new Error(`Assertion failed: ${message}`);
  }
}

async function main() {
  console.log("================================================================================");
  console.log("   EMAIL WEBHOOK SECURITY & TENANT ISOLATION HARDENING SUITE");
  console.log("================================================================================");

  // ---------------------------------------------------------------------------
  // SETUP: Disposable Tenants & Provider Configurations
  // ---------------------------------------------------------------------------
  const testRunId = Date.now().toString().slice(-6);
  const tenantAlphaId = `tenant-alpha-${testRunId}`;
  const tenantBetaId = `tenant-beta-${testRunId}`;

  // Clean any prior artifacts
  await prisma.apiClient.deleteMany({
    where: { id: { in: [tenantAlphaId, tenantBetaId] } },
  });

  const tenantAlpha = await prisma.apiClient.create({
    data: {
      id: tenantAlphaId,
      name: `Tenant Alpha ${testRunId}`,
      active: true,
    },
  });

  const tenantBeta = await prisma.apiClient.create({
    data: {
      id: tenantBetaId,
      name: `Tenant Beta ${testRunId}`,
      active: true,
    },
  });

  const mockSecretAlpha = "secret-alpha-mock-webhook-key-32-chars";
  const mockSecretBeta = "secret-beta-mock-webhook-key-32-chars";
  const gmailTokenAlpha = "pubsub-verification-token-alpha-32";
  const sesSecretAlpha = "secret-alpha-ses-webhook-key-32-chars";

  // Active Mock config for Alpha
  const configAlphaMock = await prisma.emailProviderConfig.create({
    data: {
      name: `Mock Alpha ${testRunId}`,
      clientId: tenantAlpha.id,
      providerType: EmailProviderType.MOCK,
      status: "ACTIVE",
      configMetadata: JSON.stringify({ webhookSecret: mockSecretAlpha }),
    },
  });

  // Active Mock config for Beta
  const configBetaMock = await prisma.emailProviderConfig.create({
    data: {
      name: `Mock Beta ${testRunId}`,
      clientId: tenantBeta.id,
      providerType: EmailProviderType.MOCK,
      status: "ACTIVE",
      configMetadata: JSON.stringify({ webhookSecret: mockSecretBeta }),
    },
  });

  // Active Gmail config for Alpha
  const configAlphaGmail = await prisma.emailProviderConfig.create({
    data: {
      name: `Gmail Alpha ${testRunId}`,
      clientId: tenantAlpha.id,
      providerType: EmailProviderType.GMAIL,
      status: "ACTIVE",
      configMetadata: JSON.stringify({ pubsubVerificationToken: gmailTokenAlpha }),
    },
  });

  // Active SES config for Alpha
  const configAlphaSes = await prisma.emailProviderConfig.create({
    data: {
      name: `SES Alpha ${testRunId}`,
      clientId: tenantAlpha.id,
      providerType: EmailProviderType.SES,
      status: "ACTIVE",
      configMetadata: JSON.stringify({ webhookSecret: sesSecretAlpha }),
    },
  });

  // Inactive config
  const configInactive = await prisma.emailProviderConfig.create({
    data: {
      name: `Inactive Alpha ${testRunId}`,
      clientId: tenantAlpha.id,
      providerType: EmailProviderType.MOCK,
      status: "INACTIVE",
      configMetadata: JSON.stringify({ webhookSecret: "inactive-secret" }),
    },
  });

  // Config without webhook secret configured
  const configNoSecret = await prisma.emailProviderConfig.create({
    data: {
      name: `NoSecret Alpha ${testRunId}`,
      clientId: tenantAlpha.id,
      providerType: EmailProviderType.MOCK,
      status: "ACTIVE",
      configMetadata: JSON.stringify({}),
    },
  });

  console.log(`\nSetup initialized for tenants '${tenantAlpha.id}' and '${tenantBeta.id}'.`);

  // ===========================================================================
  // TEST 1: Provider Configuration Binding (Requirement 3)
  // ===========================================================================
  console.log("\n--- [1] Provider Configuration Binding ---");

  // 1a. Missing configId
  const reqNoConfig = new NextRequest("http://localhost:3000/api/email/webhooks/mock", {
    method: "POST",
    body: JSON.stringify({ eventType: "DELIVERED", recipient: "test@example.com" }),
  });
  const resNoConfig = await webhookRoute(reqNoConfig, {
    params: Promise.resolve({ provider: "mock" }),
  });
  const dataNoConfig = await resNoConfig.json();
  assert(resNoConfig.status === 400, "Missing configId rejected with HTTP 400");
  assert(dataNoConfig.error?.code === "MISSING_PROVIDER_CONFIG", "Error code is MISSING_PROVIDER_CONFIG");

  // 1b. Non-existent configId
  const reqNonExistent = new NextRequest(
    "http://localhost:3000/api/email/webhooks/mock?configId=non-existent-cfg-id",
    {
      method: "POST",
      body: JSON.stringify({ eventType: "DELIVERED", recipient: "test@example.com" }),
    }
  );
  const resNonExistent = await webhookRoute(reqNonExistent, {
    params: Promise.resolve({ provider: "mock" }),
  });
  assert(resNonExistent.status === 401, "Non-existent configId rejected with HTTP 401");

  // 1c. Inactive configId
  const reqInactive = new NextRequest(
    `http://localhost:3000/api/email/webhooks/mock?configId=${configInactive.id}`,
    {
      method: "POST",
      body: JSON.stringify({ eventType: "DELIVERED", recipient: "test@example.com" }),
    }
  );
  const resInactive = await webhookRoute(reqInactive, {
    params: Promise.resolve({ provider: "mock" }),
  });
  assert(resInactive.status === 401, "Inactive configId rejected with HTTP 401");

  // 1d. Mismatched provider type (e.g. Gmail config passed to SES endpoint)
  const reqMismatch = new NextRequest(
    `http://localhost:3000/api/email/webhooks/ses?configId=${configAlphaGmail.id}`,
    {
      method: "POST",
      body: JSON.stringify({ eventType: "DELIVERED", recipient: "test@example.com" }),
    }
  );
  const resMismatch = await webhookRoute(reqMismatch, {
    params: Promise.resolve({ provider: "ses" }),
  });
  const dataMismatch = await resMismatch.json();
  assert(resMismatch.status === 400, "Provider type mismatch rejected with HTTP 400");
  assert(dataMismatch.error?.code === "PROVIDER_TYPE_MISMATCH", "Error code is PROVIDER_TYPE_MISMATCH");

  // 1e. Config without webhook secret fails closed
  const reqNoSecret = new NextRequest(
    `http://localhost:3000/api/email/webhooks/mock?configId=${configNoSecret.id}`,
    {
      method: "POST",
      body: JSON.stringify({ eventType: "DELIVERED", recipient: "test@example.com" }),
    }
  );
  const resNoSecret = await webhookRoute(reqNoSecret, {
    params: Promise.resolve({ provider: "mock" }),
  });
  assert(resNoSecret.status === 401, "Provider config without secret strictly fails closed (HTTP 401)");

  // ===========================================================================
  // TEST 2: Gmail Pub/Sub Authenticity & Fail-Closed Behavior (Requirement 4)
  // ===========================================================================
  console.log("\n--- [2] Gmail Pub/Sub Authenticity & Fail-Closed Model ---");

  const gmailPayload = JSON.stringify({
    message: {
      data: Buffer.from(JSON.stringify({ emailAddress: "user@gmail.com", historyId: "12345" })).toString("base64"),
      messageId: `gmsg-${testRunId}`,
    },
    subscription: "projects/my-project/subscriptions/my-sub",
    eventId: `gpub-${testRunId}-1`,
    eventType: "DELIVERED",
    recipient: "user@gmail.com",
  });

  // 2a. Valid token via query param
  const reqGmailValidQuery = new NextRequest(
    `http://localhost:3000/api/email/webhooks/gmail?configId=${configAlphaGmail.id}&token=${gmailTokenAlpha}`,
    {
      method: "POST",
      body: gmailPayload,
    }
  );
  const resGmailValidQuery = await webhookRoute(reqGmailValidQuery, {
    params: Promise.resolve({ provider: "gmail" }),
  });
  assert(resGmailValidQuery.status === 202, "Valid Gmail Pub/Sub query token accepted with HTTP 202");

  // 2b. Valid token via Authorization Bearer header
  const reqGmailValidBearer = new NextRequest(
    `http://localhost:3000/api/email/webhooks/gmail?configId=${configAlphaGmail.id}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${gmailTokenAlpha}`,
      },
      body: gmailPayload,
    }
  );
  const resGmailValidBearer = await webhookRoute(reqGmailValidBearer, {
    params: Promise.resolve({ provider: "gmail" }),
  });
  assert(resGmailValidBearer.status === 202, "Valid Gmail Pub/Sub Bearer header token accepted with HTTP 202");

  // 2c. Missing token rejected
  const reqGmailMissing = new NextRequest(
    `http://localhost:3000/api/email/webhooks/gmail?configId=${configAlphaGmail.id}`,
    {
      method: "POST",
      body: gmailPayload,
    }
  );
  const resGmailMissing = await webhookRoute(reqGmailMissing, {
    params: Promise.resolve({ provider: "gmail" }),
  });
  assert(resGmailMissing.status === 401, "Missing Gmail Pub/Sub token rejected with HTTP 401");

  // 2d. Invalid token rejected
  const reqGmailInvalid = new NextRequest(
    `http://localhost:3000/api/email/webhooks/gmail?configId=${configAlphaGmail.id}&token=invalid-wrong-token-value`,
    {
      method: "POST",
      body: gmailPayload,
    }
  );
  const resGmailInvalid = await webhookRoute(reqGmailInvalid, {
    params: Promise.resolve({ provider: "gmail" }),
  });
  assert(resGmailInvalid.status === 401, "Invalid Gmail Pub/Sub token rejected with HTTP 401");

  // ===========================================================================
  // TEST 3: AWS SES/SNS Authenticity & Cryptographic Verification (Requirement 5)
  // ===========================================================================
  console.log("\n--- [3] AWS SES/SNS Cryptographic Authenticity Verification ---");

  // 3a. Direct unverified SES payload without signature or secret
  const configSesNoSecret = await prisma.emailProviderConfig.create({
    data: {
      name: `SES NoSecret Alpha ${testRunId}`,
      clientId: tenantAlpha.id,
      providerType: EmailProviderType.SES,
      status: "ACTIVE",
      configMetadata: JSON.stringify({}),
    },
  });

  const unverifiedSesBody = JSON.stringify({
    eventType: "Bounce",
    mail: { messageId: "ses-msg-unverified", destination: ["victim@example.com"] },
  });
  const reqSesUnverified = new NextRequest(
    `http://localhost:3000/api/email/webhooks/ses?configId=${configSesNoSecret.id}`,
    {
      method: "POST",
      body: unverifiedSesBody,
    }
  );
  const resSesUnverified = await webhookRoute(reqSesUnverified, {
    params: Promise.resolve({ provider: "ses" }),
  });
  assert(resSesUnverified.status === 401, "Direct unverified SES payload rejected with HTTP 401");

  // 3b. Malicious SigningCertURL domain (SSRF defense)
  const maliciousCertUrlBody = JSON.stringify({
    Type: "Notification",
    MessageId: "sns-msg-evil",
    TopicArn: "arn:aws:sns:us-east-1:123456789012:MyTopic",
    Message: JSON.stringify({ eventType: "Delivery", mail: { messageId: "evil-msg", destination: ["a@b.com"] } }),
    Timestamp: new Date().toISOString(),
    SignatureVersion: "2",
    Signature: "fake-sig-base64",
    SigningCertURL: "https://evil-attacker.com/cert.pem",
  });
  const reqSesEvilCert = new NextRequest(
    `http://localhost:3000/api/email/webhooks/ses?configId=${configSesNoSecret.id}`,
    {
      method: "POST",
      body: maliciousCertUrlBody,
    }
  );
  const resSesEvilCert = await webhookRoute(reqSesEvilCert, {
    params: Promise.resolve({ provider: "ses" }),
  });
  assert(resSesEvilCert.status === 401, "Malicious non-AWS SigningCertURL domain rejected with HTTP 401");

  // 3c. Real Cryptographic RSA Verification of SNS Notification
  // Generate real RSA key pair for testing
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  const certUrl = `https://sns.us-east-1.amazonaws.com/test-cert-${testRunId}.pem`;
  // Pre-cache the certificate in verifier cache
  setSnsCertCache(certUrl, publicKey);

  const snsNotificationMessage = JSON.stringify({
    eventType: "DELIVERY",
    mail: {
      messageId: `ses-msg-signed-${testRunId}`,
      timestamp: new Date().toISOString(),
      destination: ["recipient@example.com"],
    },
  });

  const snsPayloadObj: Record<string, unknown> = {
    Type: "Notification",
    MessageId: `sns-msg-valid-${testRunId}`,
    TopicArn: "arn:aws:sns:us-east-1:123456789012:SES-Topic",
    Message: snsNotificationMessage,
    Timestamp: new Date().toISOString(),
    SignatureVersion: "2",
    SigningCertURL: certUrl,
  };

  // Build canonical string and sign with RSA private key
  const canonicalSignString = buildSnsCanonicalString(snsPayloadObj);
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(canonicalSignString, "utf8");
  const validRsaSignature = signer.sign(privateKey, "base64");
  snsPayloadObj.Signature = validRsaSignature;

  const validSnsBody = JSON.stringify(snsPayloadObj);

  const reqSesValidRsa = new NextRequest(
    `http://localhost:3000/api/email/webhooks/ses?configId=${configSesNoSecret.id}`,
    {
      method: "POST",
      body: validSnsBody,
    }
  );
  const resSesValidRsa = await webhookRoute(reqSesValidRsa, {
    params: Promise.resolve({ provider: "ses" }),
  });
  assert(resSesValidRsa.status === 202, "Cryptographically signed AWS SNS message accepted with HTTP 202");

  // 3d. Tampered SNS Signature rejected
  const tamperedSnsObj = { ...snsPayloadObj, Signature: Buffer.from("forged-signature-bytes").toString("base64") };
  const reqSesTampered = new NextRequest(
    `http://localhost:3000/api/email/webhooks/ses?configId=${configSesNoSecret.id}`,
    {
      method: "POST",
      body: JSON.stringify(tamperedSnsObj),
    }
  );
  const resSesTampered = await webhookRoute(reqSesTampered, {
    params: Promise.resolve({ provider: "ses" }),
  });
  assert(resSesTampered.status === 401, "Tampered AWS SNS signature rejected with HTTP 401");

  // Clean cert cache
  clearSnsCertCache();

  // ===========================================================================
  // TEST 4: Replay Protection & Timestamp Tolerance (Requirement 6)
  // ===========================================================================
  console.log("\n--- [4] Replay Protection & Timestamp Verification ---");

  const replayEventPayload = JSON.stringify({
    eventId: `evt-replay-${testRunId}`,
    eventType: "DELIVERED",
    recipient: "replay@example.com",
    timestamp: Math.floor(Date.now() / 1000),
  });

  const nowSec = Math.floor(Date.now() / 1000);

  // 4a. Expired timestamp (> 300s old)
  const expiredTimestamp = String(nowSec - 600); // 10 minutes ago
  const expiredSig = crypto
    .createHmac("sha256", mockSecretAlpha)
    .update(`${expiredTimestamp}.${replayEventPayload}`, "utf8")
    .digest("hex");

  const reqExpired = new NextRequest(
    `http://localhost:3000/api/email/webhooks/mock?configId=${configAlphaMock.id}`,
    {
      method: "POST",
      headers: {
        "x-webhook-signature": expiredSig,
        "x-webhook-timestamp": expiredTimestamp,
      },
      body: replayEventPayload,
    }
  );
  const resExpired = await webhookRoute(reqExpired, {
    params: Promise.resolve({ provider: "mock" }),
  });
  const dataExpired = await resExpired.json();
  assert(resExpired.status === 401, "Expired webhook timestamp rejected with HTTP 401");
  assert(dataExpired.error?.message?.includes("expired"), "Error indicates timestamp expired");

  // 4b. Valid timestamp first delivery
  const validTimestamp = String(nowSec);
  const validSig = crypto
    .createHmac("sha256", mockSecretAlpha)
    .update(`${validTimestamp}.${replayEventPayload}`, "utf8")
    .digest("hex");

  const reqFirstDelivery = new NextRequest(
    `http://localhost:3000/api/email/webhooks/mock?configId=${configAlphaMock.id}`,
    {
      method: "POST",
      headers: {
        "x-webhook-signature": validSig,
        "x-webhook-timestamp": validTimestamp,
      },
      body: replayEventPayload,
    }
  );
  const resFirstDelivery = await webhookRoute(reqFirstDelivery, {
    params: Promise.resolve({ provider: "mock" }),
  });
  const dataFirst = await resFirstDelivery.json();
  assert(resFirstDelivery.status === 202, "Initial valid webhook accepted with HTTP 202");
  assert(dataFirst.data?.results[0]?.deduplicated === false, "First delivery marked deduplicated: false");

  // 4c. Replayed identical webhook within tolerance window
  const reqReplay = new NextRequest(
    `http://localhost:3000/api/email/webhooks/mock?configId=${configAlphaMock.id}`,
    {
      method: "POST",
      headers: {
        "x-webhook-signature": validSig,
        "x-webhook-timestamp": validTimestamp,
      },
      body: replayEventPayload,
    }
  );
  const resReplay = await webhookRoute(reqReplay, {
    params: Promise.resolve({ provider: "mock" }),
  });
  const dataReplay = await resReplay.json();
  assert(resReplay.status === 202, "Replayed webhook returns HTTP 202");
  assert(dataReplay.data?.results[0]?.deduplicated === true, "Replayed webhook detected as duplicate (deduplicated: true)");

  // Verify only 1 record persisted in database
  const replayEventsInDb = await prisma.emailEvent.findMany({
    where: {
      providerConfigId: configAlphaMock.id,
      providerEventId: `evt-replay-${testRunId}`,
    },
  });
  assert(replayEventsInDb.length === 1, "Exactly one EmailEvent record persisted for replayed event");

  // ===========================================================================
  // TEST 5: Strict Normalized Payload Validation (Requirement 7)
  // ===========================================================================
  console.log("\n--- [5] Strict Normalized Payload Validation ---");

  async function postSignedMockPayload(payload: Record<string, unknown>) {
    const raw = JSON.stringify(payload);
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = crypto
      .createHmac("sha256", mockSecretAlpha)
      .update(`${ts}.${raw}`, "utf8")
      .digest("hex");
    const req = new NextRequest(
      `http://localhost:3000/api/email/webhooks/mock?configId=${configAlphaMock.id}`,
      {
        method: "POST",
        headers: {
          "x-webhook-signature": sig,
          "x-webhook-timestamp": ts,
        },
        body: raw,
      }
    );
    return await webhookRoute(req, { params: Promise.resolve({ provider: "mock" }) });
  }

  // 5a. Invalid eventType
  const resBadType = await postSignedMockPayload({
    eventId: `evt-badtype-${testRunId}`,
    eventType: "UNRECOGNIZED_INJECTION_TYPE",
    recipient: "valid@example.com",
  });
  assert(resBadType.status === 400, "Unrecognized eventType rejected with HTTP 400");

  // 5b. Invalid recipient syntax
  const resBadRecipient = await postSignedMockPayload({
    eventId: `evt-badrecip-${testRunId}`,
    eventType: "DELIVERED",
    recipient: "not-an-email-address",
  });
  const dataBadRecipient = await resBadRecipient.json();
  assert(resBadRecipient.status === 400, "Invalid recipient syntax rejected with HTTP 400");
  assert(dataBadRecipient.error?.code === "INVALID_PAYLOAD", "Error code is INVALID_PAYLOAD");

  // 5c. Empty providerEventId
  const resEmptyEventId = await postSignedMockPayload({
    eventId: "   ",
    eventType: "DELIVERED",
    recipient: "valid@example.com",
  });
  assert(resEmptyEventId.status === 400, "Whitespace/empty eventId rejected with HTTP 400");

  // 5d. Distant future timestamp (> 24 hours skew)
  const futureDate = new Date(Date.now() + 48 * 3600 * 1000).toISOString();
  const resFutureTs = await postSignedMockPayload({
    eventId: `evt-future-${testRunId}`,
    eventType: "DELIVERED",
    recipient: "valid@example.com",
    timestamp: futureDate,
  });
  assert(resFutureTs.status === 400, "Timestamp > 24h into the future rejected with HTTP 400");

  // 5e. Unit validation of validateNormalizedEvent
  const validEventObj = normalizeGenericEvent({
    eventId: "evt-valid-test",
    eventType: "DELIVERED",
    recipient: "good.user@domain.co",
  })[0];
  const unitValidRes = validateNormalizedEvent(validEventObj);
  assert(unitValidRes.valid === true, "validateNormalizedEvent approves fully compliant payload");

  // ===========================================================================
  // TEST 6: Provider Event Uniqueness & Cross-Provider Non-Collision (Req 1 & 11)
  // ===========================================================================
  console.log("\n--- [6] Provider Event Uniqueness & Cross-Provider Non-Collision ---");

  // Provider A (Mock on configAlphaMock) and Provider B (Mock on configBetaMock)
  // both receive the SAME providerEventId
  const sharedEventId = `common-event-id-${testRunId}`;

  const payloadProviderA = JSON.stringify({
    eventId: sharedEventId,
    eventType: "DELIVERED",
    recipient: "customer-a@example.com",
  });
  const tsA = String(Math.floor(Date.now() / 1000));
  const sigA = crypto.createHmac("sha256", mockSecretAlpha).update(`${tsA}.${payloadProviderA}`, "utf8").digest("hex");

  const reqProviderA = new NextRequest(
    `http://localhost:3000/api/email/webhooks/mock?configId=${configAlphaMock.id}`,
    {
      method: "POST",
      headers: { "x-webhook-signature": sigA, "x-webhook-timestamp": tsA },
      body: payloadProviderA,
    }
  );
  const resProviderA = await webhookRoute(reqProviderA, { params: Promise.resolve({ provider: "mock" }) });
  const dataProviderA = await resProviderA.json();
  assert(resProviderA.status === 202, "Provider A event accepted with HTTP 202");
  assert(dataProviderA.data?.results[0]?.deduplicated === false, "Provider A event recorded as new");

  // Provider B receives the EXACT SAME providerEventId
  const payloadProviderB = JSON.stringify({
    eventId: sharedEventId,
    eventType: "DELIVERED",
    recipient: "customer-b@example.com",
  });
  const tsB = String(Math.floor(Date.now() / 1000));
  const sigB = crypto.createHmac("sha256", mockSecretBeta).update(`${tsB}.${payloadProviderB}`, "utf8").digest("hex");

  const reqProviderB = new NextRequest(
    `http://localhost:3000/api/email/webhooks/mock?configId=${configBetaMock.id}`,
    {
      method: "POST",
      headers: { "x-webhook-signature": sigB, "x-webhook-timestamp": tsB },
      body: payloadProviderB,
    }
  );
  const resProviderB = await webhookRoute(reqProviderB, { params: Promise.resolve({ provider: "mock" }) });
  const dataProviderB = await resProviderB.json();
  assert(resProviderB.status === 202, "Provider B event with SAME eventId accepted with HTTP 202");
  assert(dataProviderB.data?.results[0]?.deduplicated === false, "CRITICAL: Provider B event NOT falsely deduplicated against Provider A");

  // Verify DB: exactly 2 distinct rows exist for this sharedEventId
  const dbEventsForSharedId = await prisma.emailEvent.findMany({
    where: { providerEventId: sharedEventId },
  });
  assert(dbEventsForSharedId.length === 2, "Database contains exactly two distinct EmailEvent rows for identical event ID across providers");
  assert(dbEventsForSharedId[0].providerConfigId !== dbEventsForSharedId[1].providerConfigId, "Events are cleanly scoped to different providerConfigIds");

  // Re-sending to Provider A correctly deduplicates against Provider A only
  const reqProviderAReplay = new NextRequest(
    `http://localhost:3000/api/email/webhooks/mock?configId=${configAlphaMock.id}`,
    {
      method: "POST",
      headers: { "x-webhook-signature": sigA, "x-webhook-timestamp": tsA },
      body: payloadProviderA,
    }
  );
  const resProviderAReplay = await webhookRoute(reqProviderAReplay, { params: Promise.resolve({ provider: "mock" }) });
  const dataProviderAReplay = await resProviderAReplay.json();
  assert(dataProviderAReplay.data?.results[0]?.deduplicated === true, "Replaying on Provider A deduplicates within Provider A scope");
  assert(dataProviderAReplay.data?.results[0]?.eventId === dbEventsForSharedId.find((e) => e.providerConfigId === configAlphaMock.id)?.id, "Deduplication points to Provider A's specific record");

  // ===========================================================================
  // TEST 7: Tenant Correlation & Isolation — Shared Recipient (Req 2 & 10)
  // ===========================================================================
  console.log("\n--- [7] Tenant Correlation & Cross-Tenant Shared Recipient Isolation ---");

  const sharedRecipientEmail = `shared-customer-${testRunId}@company.com`;

  // Create delivery and contact for Tenant Alpha
  const contactAlpha = await prisma.emailContact.create({
    data: {
      clientId: tenantAlpha.id,
      email: sharedRecipientEmail,
      normalizedEmail: sharedRecipientEmail,
      status: EmailContactStatus.SUBSCRIBED,
      hasMarketingConsent: true,
    },
  });

  const deliveryAlpha = await prisma.emailDelivery.create({
    data: {
      clientId: tenantAlpha.id,
      providerType: EmailProviderType.MOCK,
      providerMessageId: `msg-alpha-${testRunId}`,
      to: sharedRecipientEmail,
      from: "alpha@sender.com",
      subject: "Alpha Newsletter",
      status: EmailDeliveryStatus.SENT,
      category: "PROMOTIONAL",
    },
  });

  // Create delivery and contact for Tenant Beta
  const contactBeta = await prisma.emailContact.create({
    data: {
      clientId: tenantBeta.id,
      email: sharedRecipientEmail,
      normalizedEmail: sharedRecipientEmail,
      status: EmailContactStatus.SUBSCRIBED,
      hasMarketingConsent: true,
    },
  });

  const deliveryBeta = await prisma.emailDelivery.create({
    data: {
      clientId: tenantBeta.id,
      providerType: EmailProviderType.MOCK,
      providerMessageId: `msg-beta-${testRunId}`,
      to: sharedRecipientEmail,
      from: "beta@sender.com",
      subject: "Beta Newsletter",
      status: EmailDeliveryStatus.SENT,
      category: "PROMOTIONAL",
    },
  });

  // Webhook arrives for Tenant Alpha (BOUNCE for shared recipient)
  const alphaBouncePayload = JSON.stringify({
    eventId: `evt-alpha-bounce-${testRunId}`,
    eventType: "BOUNCED",
    bounce: {
      type: "PERMANENT",
      code: "550",
      description: "Mailbox does not exist",
    },
    recipient: sharedRecipientEmail,
    providerMessageId: deliveryAlpha.providerMessageId,
  });

  const tsAlphaBounce = String(Math.floor(Date.now() / 1000));
  const sigAlphaBounce = crypto
    .createHmac("sha256", mockSecretAlpha)
    .update(`${tsAlphaBounce}.${alphaBouncePayload}`, "utf8")
    .digest("hex");

  const reqAlphaBounce = new NextRequest(
    `http://localhost:3000/api/email/webhooks/mock?configId=${configAlphaMock.id}`,
    {
      method: "POST",
      headers: { "x-webhook-signature": sigAlphaBounce, "x-webhook-timestamp": tsAlphaBounce },
      body: alphaBouncePayload,
    }
  );
  const resAlphaBounce = await webhookRoute(reqAlphaBounce, { params: Promise.resolve({ provider: "mock" }) });
  assert(resAlphaBounce.status === 202, "Tenant Alpha bounce webhook accepted");

  // Process event synchronously for Tenant Alpha
  const eventAlphaRecord = await prisma.emailEvent.findFirst({
    where: { providerConfigId: configAlphaMock.id, providerEventId: `evt-alpha-bounce-${testRunId}` },
  });
  assert(eventAlphaRecord !== null, "Authoritative EmailEvent persisted for Tenant Alpha");
  await EmailEventService.processEventFromWorker(eventAlphaRecord!.id);

  // Assertions for Tenant Alpha
  const updatedDeliveryAlpha = await prisma.emailDelivery.findUnique({ where: { id: deliveryAlpha.id } });
  assert(updatedDeliveryAlpha?.status === EmailDeliveryStatus.BOUNCED, "Tenant Alpha delivery transitioned to BOUNCED");

  const updatedContactAlpha = await prisma.emailContact.findUnique({ where: { id: contactAlpha.id } });
  assert(updatedContactAlpha?.status === EmailContactStatus.BOUNCED, "Tenant Alpha contact marked BOUNCED");
  assert(updatedContactAlpha?.hasMarketingConsent === false, "Tenant Alpha contact marketing consent revoked");

  const suppressionAlpha = await prisma.emailSuppression.findFirst({
    where: { clientId: tenantAlpha.id, normalizedEmail: sharedRecipientEmail },
  });
  assert(suppressionAlpha !== null, "Tenant Alpha suppression list contains shared recipient");

  // CRITICAL CROSS-TENANT ISOLATION ASSERTIONS:
  // Tenant Beta must remain completely UNTOUCHED
  const updatedDeliveryBeta = await prisma.emailDelivery.findUnique({ where: { id: deliveryBeta.id } });
  assert(updatedDeliveryBeta?.status === EmailDeliveryStatus.SENT, "CRITICAL: Tenant Beta delivery remains SENT (no cross-tenant leakage)");

  const updatedContactBeta = await prisma.emailContact.findUnique({ where: { id: contactBeta.id } });
  assert(updatedContactBeta?.status === EmailContactStatus.SUBSCRIBED, "CRITICAL: Tenant Beta contact remains SUBSCRIBED");
  assert(updatedContactBeta?.hasMarketingConsent === true, "CRITICAL: Tenant Beta contact consent intact");

  const suppressionBeta = await prisma.emailSuppression.findFirst({
    where: { clientId: tenantBeta.id, normalizedEmail: sharedRecipientEmail },
  });
  assert(suppressionBeta === null, "CRITICAL: Tenant Beta has ZERO suppressions for shared recipient");

  // 7b. Attempt cross-tenant spoofing: Tenant Beta sends webhook referencing Tenant Alpha's delivery ID
  const maliciousCrossPayload = JSON.stringify({
    eventId: `evt-spoof-${testRunId}`,
    eventType: "DELIVERED",
    deliveryId: deliveryAlpha.id, // Alpha's delivery ID sent to Beta's endpoint
    recipient: sharedRecipientEmail,
  });
  const tsMalicious = String(Math.floor(Date.now() / 1000));
  const sigMalicious = crypto
    .createHmac("sha256", mockSecretBeta)
    .update(`${tsMalicious}.${maliciousCrossPayload}`, "utf8")
    .digest("hex");

  const reqMalicious = new NextRequest(
    `http://localhost:3000/api/email/webhooks/mock?configId=${configBetaMock.id}`,
    {
      method: "POST",
      headers: { "x-webhook-signature": sigMalicious, "x-webhook-timestamp": tsMalicious },
      body: maliciousCrossPayload,
    }
  );
  await webhookRoute(reqMalicious, { params: Promise.resolve({ provider: "mock" }) });
  const eventSpoof = await prisma.emailEvent.findFirst({
    where: { providerConfigId: configBetaMock.id, providerEventId: `evt-spoof-${testRunId}` },
  });
  assert(eventSpoof !== null, "Event recorded under Tenant Beta");
  await EmailEventService.processEventFromWorker(eventSpoof!.id);

  // Verify Alpha delivery is STILL BOUNCED and was not affected by Beta's webhook
  const deliveryAlphaAfterSpoof = await prisma.emailDelivery.findUnique({ where: { id: deliveryAlpha.id } });
  assert(deliveryAlphaAfterSpoof?.status === EmailDeliveryStatus.BOUNCED, "Tenant Alpha delivery was NOT modified by Tenant Beta webhook");

  // ===========================================================================
  // TEST 8: Monotonic Delivery State Machine (Requirement 9)
  // ===========================================================================
  console.log("\n--- [8] Monotonic Delivery State Machine & Determinism ---");

  // State machine pure transitions:
  // SENT -> DELIVERED: allowed
  assert(canTransitionDeliveryStatus(EmailDeliveryStatus.SENT, EmailDeliveryStatus.DELIVERED) === true, "SENT -> DELIVERED is allowed");
  // DELIVERED -> SENT: rejected (stale out-of-order)
  assert(canTransitionDeliveryStatus(EmailDeliveryStatus.DELIVERED, EmailDeliveryStatus.SENT) === false, "DELIVERED -> SENT rejected");
  // DELIVERED -> BOUNCED: rejected (stale)
  assert(canTransitionDeliveryStatus(EmailDeliveryStatus.DELIVERED, EmailDeliveryStatus.BOUNCED) === false, "DELIVERED -> BOUNCED rejected");
  // DELIVERED -> FAILED: rejected
  assert(canTransitionDeliveryStatus(EmailDeliveryStatus.DELIVERED, EmailDeliveryStatus.FAILED) === false, "DELIVERED -> FAILED rejected");
  // BOUNCED -> DELIVERED: rejected (terminal)
  assert(canTransitionDeliveryStatus(EmailDeliveryStatus.BOUNCED, EmailDeliveryStatus.DELIVERED) === false, "BOUNCED -> DELIVERED rejected");
  // BOUNCED -> FAILED: rejected (BOUNCED is specific terminal state)
  assert(canTransitionDeliveryStatus(EmailDeliveryStatus.BOUNCED, EmailDeliveryStatus.FAILED) === false, "BOUNCED -> FAILED rejected");
  // DELIVERED -> COMPLAINED: allowed
  assert(canTransitionDeliveryStatus(EmailDeliveryStatus.DELIVERED, EmailDeliveryStatus.COMPLAINED) === true, "DELIVERED -> COMPLAINED allowed");
  // COMPLAINED -> DELIVERED: rejected
  assert(canTransitionDeliveryStatus(EmailDeliveryStatus.COMPLAINED, EmailDeliveryStatus.DELIVERED) === false, "COMPLAINED -> DELIVERED rejected");
  // Duplicate transitions: no-op / false
  assert(canTransitionDeliveryStatus(EmailDeliveryStatus.DELIVERED, EmailDeliveryStatus.DELIVERED) === false, "Duplicate DELIVERED -> DELIVERED rejected");
  assert(canTransitionDeliveryStatus(EmailDeliveryStatus.BOUNCED, EmailDeliveryStatus.BOUNCED) === false, "Duplicate BOUNCED -> BOUNCED rejected");

  // Database State Machine Verification with Campaign Metrics
  const campaign = await prisma.emailCampaign.create({
    data: {
      clientId: tenantAlpha.id,
      name: `Monotonic Campaign ${testRunId}`,
      status: EmailCampaignStatus.RUNNING,
      totalRecipients: 1,
    },
  });

  const recipientRecord = await prisma.emailCampaignRecipient.create({
    data: {
      campaignId: campaign.id,
      email: `recipient-state-${testRunId}@target.com`,
      status: "SENT",
    },
  });

  const monotonicDelivery = await prisma.emailDelivery.create({
    data: {
      clientId: tenantAlpha.id,
      providerType: EmailProviderType.MOCK,
      providerMessageId: `msg-monotonic-${testRunId}`,
      campaignRecipientId: recipientRecord.id,
      to: recipientRecord.email,
      from: "alpha@sender.com",
      subject: "Monotonic State Test",
      status: EmailDeliveryStatus.SENT,
      category: "PROMOTIONAL",
    },
  });

  // Step A: SENT -> DELIVERED
  const delEvent = normalizeGenericEvent({
    eventId: `evt-del-${testRunId}`,
    eventType: "DELIVERED",
    providerMessageId: monotonicDelivery.providerMessageId,
    recipient: recipientRecord.email,
  })[0];
  await EmailEventService.recordAndEnqueueEvent(delEvent, configAlphaMock);
  const delDbEvt = await prisma.emailEvent.findFirst({ where: { providerEventId: `evt-del-${testRunId}` } });
  await EmailEventService.processEventFromWorker(delDbEvt!.id);

  const deliveryAfterDel = await prisma.emailDelivery.findUnique({ where: { id: monotonicDelivery.id } });
  assert(deliveryAfterDel?.status === EmailDeliveryStatus.DELIVERED, "Delivery transitioned from SENT to DELIVERED");

  const campaignAfterDel = await prisma.emailCampaign.findUnique({ where: { id: campaign.id } });
  assert(campaignAfterDel?.deliveredCount === 1, "Campaign deliveredCount incremented to 1");

  // Step B: Stale out-of-order SENT arrives
  const staleSentEvent = normalizeGenericEvent({
    eventId: `evt-stale-sent-${testRunId}`,
    eventType: "SENT",
    providerMessageId: monotonicDelivery.providerMessageId,
    recipient: recipientRecord.email,
  })[0];
  await EmailEventService.recordAndEnqueueEvent(staleSentEvent, configAlphaMock);
  const staleDbEvt = await prisma.emailEvent.findFirst({ where: { providerEventId: `evt-stale-sent-${testRunId}` } });
  await EmailEventService.processEventFromWorker(staleDbEvt!.id);

  const deliveryAfterStale = await prisma.emailDelivery.findUnique({ where: { id: monotonicDelivery.id } });
  assert(deliveryAfterStale?.status === EmailDeliveryStatus.DELIVERED, "CRITICAL: Delivery status preserved DELIVERED over stale SENT");

  // Step C: COMPLAINT arrives for DELIVERED email
  const complaintEvent = normalizeGenericEvent({
    eventId: `evt-comp-${testRunId}`,
    eventType: "COMPLAINT",
    complaint: { feedbackType: "abuse" },
    providerMessageId: monotonicDelivery.providerMessageId,
    recipient: recipientRecord.email,
  })[0];
  await EmailEventService.recordAndEnqueueEvent(complaintEvent, configAlphaMock);
  const compDbEvt = await prisma.emailEvent.findFirst({ where: { providerEventId: `evt-comp-${testRunId}` } });
  await EmailEventService.processEventFromWorker(compDbEvt!.id);

  const deliveryAfterComp = await prisma.emailDelivery.findUnique({ where: { id: monotonicDelivery.id } });
  assert(deliveryAfterComp?.status === EmailDeliveryStatus.COMPLAINED, "Delivery transitioned from DELIVERED to COMPLAINED");

  const campaignAfterComp = await prisma.emailCampaign.findUnique({ where: { id: campaign.id } });
  assert(campaignAfterComp?.complaintCount === 1, "Campaign complaintCount incremented to 1");

  // Step D: Duplicate COMPLAINT arriving must NOT double-increment metrics
  const duplicateCompEvent = normalizeGenericEvent({
    eventId: `evt-comp-dup-${testRunId}`,
    eventType: "COMPLAINT",
    complaint: { feedbackType: "abuse" },
    providerMessageId: monotonicDelivery.providerMessageId,
    recipient: recipientRecord.email,
  })[0];
  await EmailEventService.recordAndEnqueueEvent(duplicateCompEvent, configAlphaMock);
  const dupCompDbEvt = await prisma.emailEvent.findFirst({ where: { providerEventId: `evt-comp-dup-${testRunId}` } });
  await EmailEventService.processEventFromWorker(dupCompDbEvt!.id);

  const campaignAfterDupComp = await prisma.emailCampaign.findUnique({ where: { id: campaign.id } });
  assert(campaignAfterDupComp?.complaintCount === 1, "CRITICAL: Duplicate complaint did NOT double-increment complaintCount");

  // ===========================================================================
  // TEST 9: Ambiguous Event Without Tenant Correlated Rejected (Req 2)
  // ===========================================================================
  console.log("\n--- [9] Ambiguous Event Rejection (No Tenant Correlation) ---");

  const ambigEvent = normalizeGenericEvent({
    eventId: `evt-ambig-${testRunId}`,
    eventType: "DELIVERED",
    recipient: "orphan@example.com",
  })[0];

  let ambigThrew = false;
  try {
    await EmailEventService.recordAndEnqueueEvent(ambigEvent, null);
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes("AMBIGUOUS_TENANT_BINDING")) {
      ambigThrew = true;
    }
  }
  assert(ambigThrew, "Event without providerConfig or explicit tenant binding strictly throws AMBIGUOUS_TENANT_BINDING");

  // ===========================================================================
  // TEST 10: Secret Handling & Zero Credential Logging (Requirement 8)
  // ===========================================================================
  console.log("\n--- [10] Secret Handling & Zero Credential Exposure ---");

  // Intentionally trigger a verification failure and inspect returned error response
  const reqCheckLeak = new NextRequest(
    `http://localhost:3000/api/email/webhooks/mock?configId=${configAlphaMock.id}`,
    {
      method: "POST",
      headers: {
        "x-webhook-signature": "bogus-signature-12345",
        "x-webhook-timestamp": String(Math.floor(Date.now() / 1000)),
      },
      body: JSON.stringify({ eventType: "DELIVERED", recipient: "test@example.com" }),
    }
  );
  const resCheckLeak = await webhookRoute(reqCheckLeak, { params: Promise.resolve({ provider: "mock" }) });
  const leakJson = await resCheckLeak.json();
  const serializedResponse = JSON.stringify(leakJson);

  assert(!serializedResponse.includes(mockSecretAlpha), "Webhook response never leaks tenant webhook secret");
  assert(!serializedResponse.includes("bogus-signature-12345"), "Webhook response does not echo sensitive signature values");

  // ===========================================================================
  // TEST 11: Hostile SSRF Defense & IP Classification Audit (Requirements 9 & 10)
  // ===========================================================================
  console.log("\n--- [11] Hostile SSRF Defense & IP Classification Audit ---");

  // 11a. Malicious / Hostile AWS SigningCertURL Patterns
  assert(isValidAwsCertUrl("https://sns.us-east-1.amazonaws.com:8443/cert.pem") === false, "SSRF: Port override (:8443) rejected");
  assert(isValidAwsCertUrl("https://admin:pass@sns.us-east-1.amazonaws.com/cert.pem") === false, "SSRF: Userinfo credentials rejected");
  assert(isValidAwsCertUrl("https://sns.us-east-1.amazonaws.com/../etc/passwd.pem") === false, "SSRF: Directory traversal (..) rejected");
  assert(isValidAwsCertUrl("https://sns.us-east-1.amazonaws.com/%2e%2e/cert.pem") === false, "SSRF: URL-encoded traversal (%2e%2e) rejected");
  assert(isValidAwsCertUrl("https://sns.us-east-1.amazonaws.com/cert.pem?leak=1") === false, "SSRF: Search parameters rejected");
  assert(isValidAwsCertUrl("https://sns.us-east-1.amazonaws.com/cert.pem#frag") === false, "SSRF: Hash fragments rejected");
  assert(isValidAwsCertUrl("http://sns.us-east-1.amazonaws.com/cert.pem") === false, "SSRF: Non-HTTPS (http://) rejected");
  assert(isValidAwsCertUrl("https://evil-attacker.com/cert.pem") === false, "SSRF: Untrusted domain rejected");
  assert(isValidAwsCertUrl("https://sns.us-east-1.amazonaws.com.evil.com/cert.pem") === false, "SSRF: Subdomain spoofing rejected");
  assert(isValidAwsCertUrl("https://127.0.0.1/cert.pem") === false, "SSRF: Localhost IP rejected");
  assert(isValidAwsCertUrl("https://169.254.169.254/cert.pem") === false, "SSRF: Cloud metadata IP rejected");
  assert(isValidAwsCertUrl("https://sns.us-east-1.amazonaws.com/SimpleNotificationService-012345.pem") === true, "Valid AWS SNS cert URL accepted");
  assert(isValidAwsCertUrl("https://sns.eu-central-1.amazonaws.com/cert.pem") === true, "Valid EU AWS SNS cert URL accepted");

  // 11b. isPrivateIp Classification
  assert(isPrivateIp("127.0.0.1") === true, "isPrivateIp: 127.0.0.1 classified as private");
  assert(isPrivateIp("10.0.0.5") === true, "isPrivateIp: 10.0.0.5 (RFC 1918) classified as private");
  assert(isPrivateIp("172.16.50.1") === true, "isPrivateIp: 172.16.50.1 (RFC 1918) classified as private");
  assert(isPrivateIp("192.168.1.100") === true, "isPrivateIp: 192.168.1.100 (RFC 1918) classified as private");
  assert(isPrivateIp("169.254.169.254") === true, "isPrivateIp: 169.254.169.254 (Cloud metadata) classified as private");
  assert(isPrivateIp("100.64.0.1") === true, "isPrivateIp: 100.64.0.1 (Carrier NAT) classified as private");
  assert(isPrivateIp("::1") === true, "isPrivateIp: ::1 (IPv6 loopback) classified as private");
  assert(isPrivateIp("fe80::1") === true, "isPrivateIp: fe80::1 (IPv6 link-local) classified as private");
  assert(isPrivateIp("fc00::1") === true, "isPrivateIp: fc00::1 (IPv6 unique-local) classified as private");
  assert(isPrivateIp("::ffff:127.0.0.1") === true, "isPrivateIp: IPv4-mapped loopback classified as private");
  assert(isPrivateIp("::ffff:169.254.169.254") === true, "isPrivateIp: IPv4-mapped metadata classified as private");
  assert(isPrivateIp("8.8.8.8") === false, "isPrivateIp: 8.8.8.8 recognized as public routable");
  assert(isPrivateIp("1.1.1.1") === false, "isPrivateIp: 1.1.1.1 recognized as public routable");

  // 11c. fetchAwsSnsCertificate Rejection on Malicious Input
  let fetchFailed = false;
  try {
    await fetchAwsSnsCertificate("https://evil.com/cert.pem");
  } catch {
    fetchFailed = true;
  }
  assert(fetchFailed, "fetchAwsSnsCertificate strictly throws on non-AWS cert URL");

  // ===========================================================================
  // TEST 12: Hostile Parameter & Endpoint Rejections (Requirement 2 & 10)
  // ===========================================================================
  console.log("\n--- [12] Hostile Parameter & Endpoint Rejections ---");

  // 12a. Whitespace configId
  const reqWhitespaceConfig = new NextRequest(
    "http://localhost:3000/api/email/webhooks/mock?configId=%20%20",
    {
      method: "POST",
      body: JSON.stringify({ eventType: "DELIVERED", recipient: "test@example.com" }),
    }
  );
  const resWhitespaceConfig = await webhookRoute(reqWhitespaceConfig, {
    params: Promise.resolve({ provider: "mock" }),
  });
  const dataWhitespaceConfig = await resWhitespaceConfig.json();
  assert(resWhitespaceConfig.status === 400, "Whitespace configId rejected with HTTP 400");
  assert(dataWhitespaceConfig.error?.code === "MISSING_PROVIDER_CONFIG", "Error code is MISSING_PROVIDER_CONFIG");

  // 12b. Unsupported provider endpoint
  const reqUnsupportedProvider = new NextRequest(
    `http://localhost:3000/api/email/webhooks/malicious-provider?configId=${configAlphaMock.id}`,
    {
      method: "POST",
      body: JSON.stringify({ eventType: "DELIVERED", recipient: "test@example.com" }),
    }
  );
  const resUnsupportedProvider = await webhookRoute(reqUnsupportedProvider, {
    params: Promise.resolve({ provider: "malicious-provider" }),
  });
  const dataUnsupportedProvider = await resUnsupportedProvider.json();
  assert(resUnsupportedProvider.status === 400, "Unsupported provider endpoint rejected with HTTP 400");
  assert(dataUnsupportedProvider.error?.code === "UNSUPPORTED_PROVIDER", "Error code is UNSUPPORTED_PROVIDER");

  // 12c. Reverse provider mismatch (Gmail endpoint with SES config)
  const reqReverseMismatch = new NextRequest(
    `http://localhost:3000/api/email/webhooks/gmail?configId=${configAlphaSes.id}`,
    {
      method: "POST",
      body: JSON.stringify({ eventType: "DELIVERED", recipient: "test@example.com" }),
    }
  );
  const resReverseMismatch = await webhookRoute(reqReverseMismatch, {
    params: Promise.resolve({ provider: "gmail" }),
  });
  const dataReverseMismatch = await resReverseMismatch.json();
  assert(resReverseMismatch.status === 400, "SES config on Gmail endpoint rejected with HTTP 400");
  assert(dataReverseMismatch.error?.code === "PROVIDER_TYPE_MISMATCH", "Error code is PROVIDER_TYPE_MISMATCH");

  // 12d. Missing X-Webhook-Timestamp header on HMAC webhook (prevents infinite replay)
  const hmacWithoutTimestampSig = crypto
    .createHmac("sha256", mockSecretAlpha)
    .update(JSON.stringify({ eventType: "DELIVERED", recipient: "test@example.com" }))
    .digest("hex");
  const reqNoTimestampHmac = new NextRequest(
    `http://localhost:3000/api/email/webhooks/mock?configId=${configAlphaMock.id}`,
    {
      method: "POST",
      headers: {
        "x-webhook-signature": hmacWithoutTimestampSig,
        // x-webhook-timestamp intentionally omitted
      },
      body: JSON.stringify({ eventType: "DELIVERED", recipient: "test@example.com" }),
    }
  );
  const resNoTimestampHmac = await webhookRoute(reqNoTimestampHmac, {
    params: Promise.resolve({ provider: "mock" }),
  });
  assert(resNoTimestampHmac.status === 401, "HMAC webhook without X-Webhook-Timestamp rejected with HTTP 401");

  // 12e. Malformed JSON payload body
  const reqMalformedJson = new NextRequest(
    `http://localhost:3000/api/email/webhooks/mock?configId=${configAlphaMock.id}`,
    {
      method: "POST",
      headers: {
        "x-webhook-signature": "bogus-signature",
        "x-webhook-timestamp": String(Math.floor(Date.now() / 1000)),
      },
      body: "{ not valid json syntax ...",
    }
  );
  const resMalformedJson = await webhookRoute(reqMalformedJson, {
    params: Promise.resolve({ provider: "mock" }),
  });
  assert(resMalformedJson.status === 401 || resMalformedJson.status === 400, "Malformed body rejected");

  // 12f. MOCK provider forbidden in production environment
  const originalEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  const reqMockInProd = new NextRequest(
    `http://localhost:3000/api/email/webhooks/mock?configId=${configAlphaMock.id}`,
    {
      method: "POST",
      body: JSON.stringify({ eventType: "DELIVERED", recipient: "test@example.com" }),
    }
  );
  const resMockInProd = await webhookRoute(reqMockInProd, {
    params: Promise.resolve({ provider: "mock" }),
  });
  const dataMockInProd = await resMockInProd.json();
  process.env.NODE_ENV = originalEnv; // Restore immediately
  assert(resMockInProd.status === 400, "MOCK provider rejected in production with HTTP 400");
  assert(dataMockInProd.error?.code === "MOCK_PROVIDER_FORBIDDEN", "Error code is MOCK_PROVIDER_FORBIDDEN");

  // ===========================================================================
  // TEST 13: Full Event Matrix Verification (Requirement 7)
  // ===========================================================================
  console.log("\n--- [13] Full Event Matrix Verification (Bounce, Soft, Hard, Complaint, Delivered, Sent, Unsubscribe, Failed) ---");

  // 13a. Soft Bounce vs Hard Bounce
  const softBounceEmail = `soft-bounce-${testRunId}@test.com`;
  const hardBounceEmail = `hard-bounce-${testRunId}@test.com`;

  const contactSoft = await prisma.emailContact.create({
    data: {
      clientId: tenantAlpha.id,
      email: softBounceEmail,
      normalizedEmail: softBounceEmail.toLowerCase(),
      status: EmailContactStatus.SUBSCRIBED,
      hasMarketingConsent: true,
    },
  });

  const contactHard = await prisma.emailContact.create({
    data: {
      clientId: tenantAlpha.id,
      email: hardBounceEmail,
      normalizedEmail: hardBounceEmail.toLowerCase(),
      status: EmailContactStatus.SUBSCRIBED,
      hasMarketingConsent: true,
    },
  });

  const deliverySoft = await prisma.emailDelivery.create({
    data: {
      clientId: tenantAlpha.id,
      providerType: EmailProviderType.MOCK,
      providerMessageId: `msg-soft-${testRunId}`,
      to: softBounceEmail,
      from: "sender@example.com",
      subject: "Soft Bounce Test",
      status: EmailDeliveryStatus.SENT,
      category: "PROMOTIONAL",
    },
  });

  const deliveryHard = await prisma.emailDelivery.create({
    data: {
      clientId: tenantAlpha.id,
      providerType: EmailProviderType.MOCK,
      providerMessageId: `msg-hard-${testRunId}`,
      to: hardBounceEmail,
      from: "sender@example.com",
      subject: "Hard Bounce Test",
      status: EmailDeliveryStatus.SENT,
      category: "PROMOTIONAL",
    },
  });

  // Process SOFT BOUNCE
  const softEvent = normalizeGenericEvent({
    eventId: `evt-soft-${testRunId}`,
    eventType: "BOUNCED",
    bounceType: "SOFT_BOUNCE",
    bounceReason: "Mailbox full - temporary failure",
    providerMessageId: deliverySoft.providerMessageId,
    recipient: softBounceEmail,
  })[0];
  await EmailEventService.recordAndEnqueueEvent(softEvent, configAlphaMock);
  const softDbEvt = await prisma.emailEvent.findFirst({ where: { providerEventId: `evt-soft-${testRunId}` } });
  await EmailEventService.processEventFromWorker(softDbEvt!.id);

  const deliveryAfterSoft = await prisma.emailDelivery.findUnique({ where: { id: deliverySoft.id } });
  assert(deliveryAfterSoft?.status === EmailDeliveryStatus.BOUNCED, "Soft bounce delivery transitioned to BOUNCED");

  const contactAfterSoft = await prisma.emailContact.findUnique({ where: { id: contactSoft.id } });
  assert(contactAfterSoft?.status === EmailContactStatus.SUBSCRIBED, "Soft bounce did NOT change contact status (remains SUBSCRIBED)");
  assert(contactAfterSoft?.hasMarketingConsent === true, "Soft bounce did NOT revoke marketing consent");

  const suppressionSoft = await prisma.emailSuppression.findFirst({
    where: { clientId: tenantAlpha.id, email: softBounceEmail },
  });
  assert(suppressionSoft === null, "CRITICAL: Soft bounce did NOT create permanent suppression record");

  // Process HARD BOUNCE
  const hardEvent = normalizeGenericEvent({
    eventId: `evt-hard-${testRunId}`,
    eventType: "BOUNCED",
    bounceType: "HARD_BOUNCE",
    bounceReason: "Recipient address does not exist - permanent failure",
    providerMessageId: deliveryHard.providerMessageId,
    recipient: hardBounceEmail,
  })[0];
  await EmailEventService.recordAndEnqueueEvent(hardEvent, configAlphaMock);
  const hardDbEvt = await prisma.emailEvent.findFirst({ where: { providerEventId: `evt-hard-${testRunId}` } });
  await EmailEventService.processEventFromWorker(hardDbEvt!.id);

  const deliveryAfterHard = await prisma.emailDelivery.findUnique({ where: { id: deliveryHard.id } });
  assert(deliveryAfterHard?.status === EmailDeliveryStatus.BOUNCED, "Hard bounce delivery transitioned to BOUNCED");

  const contactAfterHard = await prisma.emailContact.findUnique({ where: { id: contactHard.id } });
  assert(contactAfterHard?.status === EmailContactStatus.BOUNCED, "Hard bounce marked contact status as BOUNCED");
  assert(contactAfterHard?.hasMarketingConsent === false, "Hard bounce revoked marketing consent");

  const suppressionHard = await prisma.emailSuppression.findFirst({
    where: { clientId: tenantAlpha.id, email: hardBounceEmail },
  });
  assert(suppressionHard !== null, "CRITICAL: Hard bounce created authoritative permanent suppression record");
  assert(suppressionHard?.reason === EmailSuppressionReason.HARD_BOUNCE, "Suppression reason is HARD_BOUNCE");

  // 13b. Unsubscribe Event
  const unsubEmail = `unsub-${testRunId}@test.com`;
  const contactUnsub = await prisma.emailContact.create({
    data: {
      clientId: tenantAlpha.id,
      email: unsubEmail,
      normalizedEmail: unsubEmail.toLowerCase(),
      status: EmailContactStatus.SUBSCRIBED,
      hasMarketingConsent: true,
    },
  });

  const unsubEvent = normalizeGenericEvent({
    eventId: `evt-unsub-${testRunId}`,
    eventType: "UNSUBSCRIBED",
    recipient: unsubEmail,
  })[0];
  await EmailEventService.recordAndEnqueueEvent(unsubEvent, configAlphaMock);
  const unsubDbEvt = await prisma.emailEvent.findFirst({ where: { providerEventId: `evt-unsub-${testRunId}` } });
  await EmailEventService.processEventFromWorker(unsubDbEvt!.id);

  const contactAfterUnsub = await prisma.emailContact.findUnique({ where: { id: contactUnsub.id } });
  assert(contactAfterUnsub?.status === EmailContactStatus.UNSUBSCRIBED, "Contact marked UNSUBSCRIBED");
  assert(contactAfterUnsub?.hasMarketingConsent === false, "Marketing consent revoked on unsubscribe");

  const suppressionUnsub = await prisma.emailSuppression.findFirst({
    where: { clientId: tenantAlpha.id, email: unsubEmail },
  });
  assert(suppressionUnsub !== null, "Authoritative suppression record created on unsubscribe");
  assert(suppressionUnsub?.reason === EmailSuppressionReason.UNSUBSCRIBED, "Suppression reason is UNSUBSCRIBED");

  // 13c. Delivery Failed Event
  const failedEmail = `failed-${testRunId}@test.com`;
  const deliveryFailed = await prisma.emailDelivery.create({
    data: {
      clientId: tenantAlpha.id,
      providerType: EmailProviderType.MOCK,
      providerMessageId: `msg-failed-${testRunId}`,
      to: failedEmail,
      from: "sender@example.com",
      subject: "Failure Test",
      status: EmailDeliveryStatus.SENT,
      category: "PROMOTIONAL",
    },
  });

  const failedEvent = normalizeGenericEvent({
    eventId: `evt-failed-${testRunId}`,
    eventType: "FAILED",
    providerMessageId: deliveryFailed.providerMessageId,
    recipient: failedEmail,
    error: { code: "SMTP_550", message: "Relay access denied" },
  })[0];
  await EmailEventService.recordAndEnqueueEvent(failedEvent, configAlphaMock);
  const failedDbEvt = await prisma.emailEvent.findFirst({ where: { providerEventId: `evt-failed-${testRunId}` } });
  await EmailEventService.processEventFromWorker(failedDbEvt!.id);

  const deliveryAfterFailed = await prisma.emailDelivery.findUnique({ where: { id: deliveryFailed.id } });
  assert(deliveryAfterFailed?.status === EmailDeliveryStatus.FAILED, "Delivery transitioned to FAILED");

  // ===========================================================================
  // TEST 14: Terminal Delivery State Machine Monotonicity (Requirement 8)
  // ===========================================================================
  console.log("\n--- [14] Terminal State Monotonicity & Delivery State Transitions ---");

  // 14a. Terminal BOUNCED cannot become DELIVERED
  assert(
    canTransitionDeliveryStatus(EmailDeliveryStatus.BOUNCED, EmailDeliveryStatus.DELIVERED) === false,
    "CRITICAL: Terminal BOUNCED cannot become DELIVERED"
  );

  // 14b. Terminal FAILED cannot become DELIVERED
  assert(
    canTransitionDeliveryStatus(EmailDeliveryStatus.FAILED, EmailDeliveryStatus.DELIVERED) === false,
    "CRITICAL: Terminal FAILED cannot become DELIVERED"
  );

  // 14c. Terminal COMPLAINED cannot become DELIVERED or BOUNCED
  assert(
    canTransitionDeliveryStatus(EmailDeliveryStatus.COMPLAINED, EmailDeliveryStatus.DELIVERED) === false,
    "CRITICAL: Terminal COMPLAINED cannot become DELIVERED"
  );
  assert(
    canTransitionDeliveryStatus(EmailDeliveryStatus.COMPLAINED, EmailDeliveryStatus.BOUNCED) === false,
    "CRITICAL: Terminal COMPLAINED cannot become BOUNCED"
  );

  // 14d. Terminal BOUNCED delivery in DB stays BOUNCED even if out-of-order DELIVERED event arrives
  const bounceDeliveryTest = await prisma.emailDelivery.create({
    data: {
      clientId: tenantAlpha.id,
      providerType: EmailProviderType.MOCK,
      providerMessageId: `msg-bounce-term-${testRunId}`,
      to: `terminal-bounce-${testRunId}@test.com`,
      from: "sender@example.com",
      subject: "Terminal Bounce Monotonicity",
      status: EmailDeliveryStatus.BOUNCED,
      category: "PROMOTIONAL",
    },
  });

  const outOfOrderDel = normalizeGenericEvent({
    eventId: `evt-ooo-del-${testRunId}`,
    eventType: "DELIVERED",
    providerMessageId: bounceDeliveryTest.providerMessageId,
    recipient: bounceDeliveryTest.to,
  })[0];
  await EmailEventService.recordAndEnqueueEvent(outOfOrderDel, configAlphaMock);
  const oooDelDb = await prisma.emailEvent.findFirst({ where: { providerEventId: `evt-ooo-del-${testRunId}` } });
  await EmailEventService.processEventFromWorker(oooDelDb!.id);

  const deliveryAfterOoo = await prisma.emailDelivery.findUnique({ where: { id: bounceDeliveryTest.id } });
  assert(deliveryAfterOoo?.status === EmailDeliveryStatus.BOUNCED, "CRITICAL: BOUNCED delivery remains BOUNCED after out-of-order DELIVERED event");

  // ===========================================================================
  // TEST 15: Event Persistence Before 202 & Honest Queue Failure (Requirements 5 & 6)
  // ===========================================================================
  console.log("\n--- [15] Event Persistence Before 202 & Honest Queue Failure Reporting ---");

  // 15a. Event is persisted in DB before 202 is returned
  const persistBefore202Id = `evt-persist-${testRunId}`;
  const persistTimestamp = Math.floor(Date.now() / 1000);
  const persistPayload = JSON.stringify({
    eventId: persistBefore202Id,
    eventType: "DELIVERED",
    recipient: "persisted@example.com",
  });
  const persistHmac = crypto
    .createHmac("sha256", mockSecretAlpha)
    .update(`${persistTimestamp}.${persistPayload}`)
    .digest("hex");

  const reqPersistCheck = new NextRequest(
    `http://localhost:3000/api/email/webhooks/mock?configId=${configAlphaMock.id}`,
    {
      method: "POST",
      headers: {
        "x-webhook-signature": persistHmac,
        "x-webhook-timestamp": String(persistTimestamp),
      },
      body: persistPayload,
    }
  );
  const resPersistCheck = await webhookRoute(reqPersistCheck, { params: Promise.resolve({ provider: "mock" }) });
  assert(resPersistCheck.status === 202, "Webhook accepted with HTTP 202");

  const dbEventPersisted = await prisma.emailEvent.findFirst({
    where: { providerEventId: persistBefore202Id, providerConfigId: configAlphaMock.id },
  });
  assert(dbEventPersisted !== null, "CRITICAL: EmailEvent record exists in DB immediately upon 202 response");
  assert(dbEventPersisted?.status === EmailEventProcessingStatus.RECEIVED, "Persisted EmailEvent is in RECEIVED state");

  // 15b. Honest Queue Failure: Simulated Redis / Queue Error
  // When BullMQ fails to enqueue, recordAndEnqueueEvent must NOT report success,
  // the DB event must be marked FAILED, and route must return HTTP 503!
  const queue = getEventsQueue();
  const originalAdd = queue.add.bind(queue);

  // Mock queue.add to simulate Redis connection crash
  (queue as any).add = async () => {
    throw new Error("Simulated Redis Connection Refused: ECONNREFUSED 127.0.0.1:6379");
  };

  const queueFailEventId = `evt-qfail-${testRunId}`;
  const queueFailTimestamp = Math.floor(Date.now() / 1000);
  const queueFailPayload = JSON.stringify({
    eventId: queueFailEventId,
    eventType: "DELIVERED",
    recipient: "qfail@example.com",
  });
  const queueFailHmac = crypto
    .createHmac("sha256", mockSecretAlpha)
    .update(`${queueFailTimestamp}.${queueFailPayload}`)
    .digest("hex");

  const reqQueueFail = new NextRequest(
    `http://localhost:3000/api/email/webhooks/mock?configId=${configAlphaMock.id}`,
    {
      method: "POST",
      headers: {
        "x-webhook-signature": queueFailHmac,
        "x-webhook-timestamp": String(queueFailTimestamp),
      },
      body: queueFailPayload,
    }
  );

  const resQueueFail = await webhookRoute(reqQueueFail, { params: Promise.resolve({ provider: "mock" }) });
  const dataQueueFail = await resQueueFail.json();

  // Restore original queue.add immediately
  (queue as any).add = originalAdd;

  assert(resQueueFail.status === 503, "CRITICAL: Queue failure returns HTTP 503 (Upstream retry required)");
  assert(dataQueueFail.error?.code === "QUEUE_ERROR", "Error code is QUEUE_ERROR");

  const dbEventQFail = await prisma.emailEvent.findFirst({
    where: { providerEventId: queueFailEventId, providerConfigId: configAlphaMock.id },
  });
  assert(dbEventQFail !== null, "EmailEvent record was persisted prior to queue attempt");
  assert(dbEventQFail?.status === EmailEventProcessingStatus.FAILED, "EmailEvent marked FAILED in database on queue failure");
  assert(dbEventQFail?.errorCode === "QUEUE_ENQUEUE_FAILED", "EmailEvent errorCode is QUEUE_ENQUEUE_FAILED");

  // ===========================================================================
  // TEST 16: Comprehensive Secret Redaction & Log Sanitization Audit (Requirement 11)
  // ===========================================================================
  console.log("\n--- [16] Secret Redaction & Log Sanitization Audit ---");

  // 16a. redactSecrets masks all sensitive patterns
  const secretSampleApiKey = "API key whub_0123456789abcdef01234567 should be masked";
  assert(redactSecrets(secretSampleApiKey).includes("[REDACTED_API_KEY]"), "redactSecrets masks whub_ API keys");
  assert(!redactSecrets(secretSampleApiKey).includes("whub_0123456789abcdef01234567"), "API key value is completely scrubbed");

  const secretSampleBearer = "Authorization: Bearer my-sensitive-jwt-token-12345";
  assert(redactSecrets(secretSampleBearer).includes("Bearer [REDACTED]"), "redactSecrets masks Bearer tokens");
  assert(!redactSecrets(secretSampleBearer).includes("my-sensitive-jwt-token-12345"), "Bearer token value is completely scrubbed");

  const secretSampleDb = "postgresql://myuser:supersecretpass@localhost:5432/mydb";
  assert(redactSecrets(secretSampleDb).includes("postgresql://myuser:[REDACTED]@localhost:5432/mydb"), "Database credentials masked");
  assert(!redactSecrets(secretSampleDb).includes("supersecretpass"), "Database password completely scrubbed");

  const secretSampleWebhookSecret = "webhookSecret=super-secret-key-value&tenantId=123";
  assert(redactSecrets(secretSampleWebhookSecret).includes("webhookSecret=[REDACTED]"), "webhookSecret parameter masked");
  assert(!redactSecrets(secretSampleWebhookSecret).includes("super-secret-key-value"), "webhookSecret value completely scrubbed");

  const secretSampleSignature = "x-webhook-signature=deadbeef1234567890";
  assert(redactSecrets(secretSampleSignature).includes("x-webhook-signature=[REDACTED]"), "Webhook signature parameter masked");

  // ---------------------------------------------------------------------------
  // CLEANUP
  // ---------------------------------------------------------------------------
  console.log("\n--- Cleaning up test artifacts ---");
  await prisma.apiClient.deleteMany({
    where: { id: { in: [tenantAlpha.id, tenantBeta.id] } },
  });

  await closeAllQueues();
  await prisma.$disconnect();

  console.log("================================================================================");
  console.log(`RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log("================================================================================");

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("Fatal error during test suite execution:", err);
  process.exit(1);
});
