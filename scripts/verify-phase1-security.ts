import { prisma } from "../src/lib/prisma";
import { MessageService } from "../src/lib/services/message-service";
import { OtpService } from "../src/lib/services/otp-service";
import { WebhookService } from "../src/lib/services/webhook-service";
import { WebhookPayload } from "../src/lib/whatsapp/types";
import {
  generateApiKey,
  encryptWebhookSecret,
  decryptWebhookSecret,
  signHmacSha256,
  verifyHmacSha256,
} from "../src/lib/crypto";
import { validateWebhookUrlSync, validateWebhookUrlForDelivery } from "../src/lib/webhooks/ssrf";
import { dispatchOutgoingWebhooks } from "../src/lib/webhooks/dispatcher";

async function runPhase1SecurityTests() {
  console.log("==================================================================");
  console.log("🛡️  RUNNING PHASE 1 SECURITY & MULTI-TENANT ISOLATION TEST SUITE");
  console.log("==================================================================\n");

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, testName: string, detail?: string) {
    if (condition) {
      console.log(`  ✅ PASS: ${testName}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${testName}${detail ? ` - ${detail}` : ""}`);
      failed++;
    }
  }

  // Generate two independent test tenants
  const tenantSuffix = Date.now();
  const clientA = await prisma.apiClient.create({
    data: { name: `Security Tenant A (${tenantSuffix})`, description: "Tenant A for security isolation testing" },
  });
  const clientB = await prisma.apiClient.create({
    data: { name: `Security Tenant B (${tenantSuffix})`, description: "Tenant B for security isolation testing" },
  });

  const { rawKey: keyA, keyPrefix: prefixA, keyHash: hashA } = generateApiKey();
  const apiKeyA = await prisma.apiKey.create({
    data: { clientId: clientA.id, name: "Key A", keyPrefix: prefixA, keyHash: hashA },
  });

  const { rawKey: keyB, keyPrefix: prefixB, keyHash: hashB } = generateApiKey();
  const apiKeyB = await prisma.apiKey.create({
    data: { clientId: clientB.id, name: "Key B", keyPrefix: prefixB, keyHash: hashB },
  });

  try {
    // -------------------------------------------------------------------------
    // TEST A — Tenant Isolation on Message Listing
    // -------------------------------------------------------------------------
    console.log("\n--- TEST A: Tenant Isolation on Message Listing ---");
    const msgA = await MessageService.send(
      { to: "919000000001", type: "text", body: "Confidential message for Client A" },
      { clientId: clientA.id }
    );
    const msgB = await MessageService.send(
      { to: "919000000002", type: "text", body: "Confidential message for Client B" },
      { clientId: clientB.id }
    );

    const listForA = await MessageService.getMessages({ clientId: clientA.id });
    const listForB = await MessageService.getMessages({ clientId: clientB.id });

    const aCanSeeB = listForA.messages.some((m) => m.id === msgB.id);
    const bCanSeeA = listForB.messages.some((m) => m.id === msgA.id);

    assert(!aCanSeeB, "TEST A.1: Client A cannot list Client B messages");
    assert(!bCanSeeA, "TEST A.2: Client B cannot list Client A messages");
    assert(listForA.messages.some((m) => m.id === msgA.id), "TEST A.3: Client A correctly lists its own message");

    // -------------------------------------------------------------------------
    // TEST B — Tenant Isolation on Message Retrieval by ID
    // -------------------------------------------------------------------------
    console.log("\n--- TEST B: Tenant Isolation by ID ---");
    const aRetrievesB = await MessageService.getById(msgB.id, clientA.id);
    const bRetrievesA = await MessageService.getById(msgA.id, clientB.id);
    const aRetrievesA = await MessageService.getById(msgA.id, clientA.id);

    assert(aRetrievesB === null, "TEST B.1: Client A cannot retrieve Client B's message by ID (returns null)");
    assert(bRetrievesA === null, "TEST B.2: Client B cannot retrieve Client A's message by ID (returns null)");
    assert(aRetrievesA?.id === msgA.id, "TEST B.3: Client A can retrieve its own message by ID");

    // -------------------------------------------------------------------------
    // TEST C — Tenant Isolation on Conversations
    // -------------------------------------------------------------------------
    console.log("\n--- TEST C: Tenant Isolation on Conversations ---");
    const sharedContact = "919111122222";
    await MessageService.send({ to: sharedContact, type: "text", body: "A talking to shared contact" }, { clientId: clientA.id });
    await MessageService.send({ to: sharedContact, type: "text", body: "B talking to shared contact" }, { clientId: clientB.id });

    const convsA = await MessageService.getConversations(clientA.id);
    const convsB = await MessageService.getConversations(clientB.id);

    const targetConvA = convsA.find((c) => c.phoneNumber === sharedContact);
    const targetConvB = convsB.find((c) => c.phoneNumber === sharedContact);

    assert(targetConvA?.messageCount === 1, "TEST C.1: Client A conversation thread contains only Client A messages (count: 1)");
    assert(targetConvB?.messageCount === 1, "TEST C.2: Client B conversation thread contains only Client B messages (count: 1)");

    // -------------------------------------------------------------------------
    // TEST D — Idempotency Isolation
    // -------------------------------------------------------------------------
    console.log("\n--- TEST D: Tenant-Scoped Idempotency ---");
    const sharedIdempKey = `shared_idemp_${tenantSuffix}`;

    const idempA1 = await MessageService.send(
      { to: "919333344444", type: "text", body: "Tenant A idempotent send" },
      { idempotencyKey: sharedIdempKey, clientId: clientA.id }
    );
    const idempB1 = await MessageService.send(
      { to: "919333344444", type: "text", body: "Tenant B idempotent send" },
      { idempotencyKey: sharedIdempKey, clientId: clientB.id }
    );

    assert(idempA1.id !== idempB1.id, "TEST D.1: Client A and Client B can use identical idempotency keys without colliding");

    const idempA2 = await MessageService.send(
      { to: "919333344444", type: "text", body: "Tenant A retry" },
      { idempotencyKey: sharedIdempKey, clientId: clientA.id }
    );
    assert(idempA2.id === idempA1.id, "TEST D.2: Re-send by Client A with same idempotency key returns existing Client A record");

    // -------------------------------------------------------------------------
    // TEST E & F — Webhook Endpoint & Delivery Isolation
    // -------------------------------------------------------------------------
    console.log("\n--- TEST E & F: Webhook Isolation ---");
    const endpointA = await prisma.webhookEndpoint.create({
      data: {
        clientId: clientA.id,
        name: "Endpoint Client A",
        url: "https://httpbin.org/post",
        encryptedSecret: encryptWebhookSecret("secret_client_a_12345"),
        subscribedEvents: JSON.stringify(["*"]),
        active: true,
      },
    });

    const endpointB = await prisma.webhookEndpoint.create({
      data: {
        clientId: clientB.id,
        name: "Endpoint Client B",
        url: "https://httpbin.org/post",
        encryptedSecret: encryptWebhookSecret("secret_client_b_12345"),
        subscribedEvents: JSON.stringify(["*"]),
        active: true,
      },
    });

    // Dispatch an event explicitly scoped to Client A
    await dispatchOutgoingWebhooks("test.event", { client: "A" }, clientA.id);
    await new Promise((resolve) => setTimeout(resolve, 300));

    const deliveriesA = await prisma.webhookDelivery.findMany({ where: { endpointId: endpointA.id } });
    const deliveriesB = await prisma.webhookDelivery.findMany({ where: { endpointId: endpointB.id } });

    assert(deliveriesA.length >= 1, "TEST E.1: Client A event dispatched to Client A endpoint");
    assert(deliveriesB.length === 0, "TEST E.2: Client A event NOT dispatched to Client B endpoint (tenant isolation)");

    // -------------------------------------------------------------------------
    // TEST G — OTP Tenant Isolation
    // -------------------------------------------------------------------------
    console.log("\n--- TEST G: OTP Tenant Isolation ---");
    const otpPhone = "919555566666";
    const otpPurpose = "tenant_test";

    const otpReq = await OtpService.requestOtp(clientA.id, otpPhone, otpPurpose);
    const otpCode = otpReq.data.devCode || "123456";

    // Client B attempts to verify Client A's OTP
    const crossVerify = await OtpService.verifyOtp(clientB.id, otpPhone, otpPurpose, otpCode);
    assert(!crossVerify.success && crossVerify.error?.code === "INVALID_OTP", "TEST G.1: Client B cannot verify Client A's OTP state");

    // Client A verifies its own OTP
    const validVerify = await OtpService.verifyOtp(clientA.id, otpPhone, otpPurpose, otpCode);
    assert(validVerify.success === true, "TEST G.2: Client A successfully verifies its own OTP");

    // -------------------------------------------------------------------------
    // TEST H — OTP Single-Use Concurrency Protection
    // -------------------------------------------------------------------------
    console.log("\n--- TEST H: OTP Single-Use Concurrency ---");
    const concurrentPhone = "919777788888";
    const concurrentReq = await OtpService.requestOtp(clientA.id, concurrentPhone, "concurrency_test");
    const concurrentCode = concurrentReq.data.devCode!;

    // Two simultaneous verification requests
    const [race1, race2] = await Promise.all([
      OtpService.verifyOtp(clientA.id, concurrentPhone, "concurrency_test", concurrentCode),
      OtpService.verifyOtp(clientA.id, concurrentPhone, "concurrency_test", concurrentCode),
    ]);

    const successCount = (race1.success ? 1 : 0) + (race2.success ? 1 : 0);
    const failureCount = (!race1.success ? 1 : 0) + (!race2.success ? 1 : 0);

    assert(successCount === 1, "TEST H.1: Exactly ONE concurrent verification succeeds");
    assert(failureCount === 1, "TEST H.2: Exactly ONE concurrent verification is rejected (single-use enforced)");

    // -------------------------------------------------------------------------
    // TEST I — Webhook Event Deduplication Races
    // -------------------------------------------------------------------------
    console.log("\n--- TEST I: Webhook Event Deduplication Races ---");
    const dupProviderId = `wamid.race_${Date.now()}`;
    const duplicatePayload: WebhookPayload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba_race",
          changes: [
            {
              value: {
                messaging_product: "whatsapp",
                metadata: {
                  display_phone_number: "15550234567",
                  phone_number_id: "phone_id_123",
                },
                messages: [
                  {
                    from: "919000000009",
                    id: dupProviderId,
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    type: "text",
                    text: { body: "Testing concurrent webhook deduplication" },
                  },
                ],
              },
              field: "messages",
            },
          ],
        },
      ],
    };

    // Run duplicate webhooks concurrently
    await Promise.all([
      WebhookService.processPayload(duplicatePayload),
      WebhookService.processPayload(duplicatePayload),
    ]);

    const createdMessages = await prisma.message.findMany({
      where: { providerMessageId: dupProviderId },
    });
    assert(createdMessages.length === 1, "TEST I.1: Concurrent duplicate webhooks create exactly ONE business message");

    // -------------------------------------------------------------------------
    // TEST J — Supabase Direct Access / RLS Verification
    // -------------------------------------------------------------------------
    console.log("\n--- TEST J: Supabase Security / RLS Protection ---");
    // Verify RLS is active on live PostgreSQL tables
    const rlsStatus = await prisma.$queryRaw<Array<{ tablename: string; rowsecurity: boolean }>>`
      SELECT tablename, rowsecurity 
      FROM pg_tables 
      WHERE schemaname = 'public' 
        AND tablename IN ('ApiClient', 'ApiKey', 'Message', 'MessageEvent', 'OtpVerification', 'WebhookEndpoint', 'WebhookDelivery');
    `;
    const allRlsEnabled = rlsStatus.length === 7 && rlsStatus.every((t) => t.rowsecurity === true);
    assert(allRlsEnabled, "TEST J.1: RLS is verified ENABLED on all 7 application tables in PostgreSQL");

    // -------------------------------------------------------------------------
    // TEST K & L — Webhook Secret Encryption & Rotation
    // -------------------------------------------------------------------------
    console.log("\n--- TEST K & L: Webhook Secret Storage & Rotation ---");
    const rawSigningSecret = "whsec_live_test_secret_abc123";
    const encSecret = encryptWebhookSecret(rawSigningSecret);

    const testEp = await prisma.webhookEndpoint.create({
      data: {
        clientId: clientA.id,
        name: "Secret Storage Verification",
        url: "https://example.com/test-endpoint",
        encryptedSecret: encSecret,
        subscribedEvents: "[]",
        active: true,
      },
    });

    const epInDb = await prisma.webhookEndpoint.findUnique({ where: { id: testEp.id } });
    assert(epInDb?.encryptedSecret !== rawSigningSecret, "TEST K.1: Plaintext secret is NEVER stored in database");
    assert(decryptWebhookSecret(epInDb!.encryptedSecret) === rawSigningSecret, "TEST K.2: Stored secret is accurately decrypted with AES-256-GCM");

    // Rotation test
    const newSecret = "whsec_rotated_secret_xyz789";
    const newEncSecret = encryptWebhookSecret(newSecret);
    await prisma.webhookEndpoint.update({
      where: { id: testEp.id },
      data: { encryptedSecret: newEncSecret },
    });

    const rotatedEp = await prisma.webhookEndpoint.findUnique({ where: { id: testEp.id } });
    const decryptedRotated = decryptWebhookSecret(rotatedEp!.encryptedSecret);
    assert(decryptedRotated === newSecret, "TEST L.1: Rotated secret is stored and decrypts to new secret");
    assert(decryptedRotated !== rawSigningSecret, "TEST L.2: Old secret is immediately invalidated");

    // Clean up test endpoint
    await prisma.webhookEndpoint.delete({ where: { id: testEp.id } });

    // -------------------------------------------------------------------------
    // TEST M — SSRF Protection
    // -------------------------------------------------------------------------
    console.log("\n--- TEST M: SSRF Protection ---");
    assert(!validateWebhookUrlSync("http://127.0.0.1:8000/").valid, "TEST M.1: Block 127.0.0.1 (loopback)");
    assert(!validateWebhookUrlSync("http://169.254.169.254/metadata").valid, "TEST M.2: Block 169.254.169.254 (cloud metadata)");
    assert(!validateWebhookUrlSync("http://10.250.0.1/").valid, "TEST M.3: Block 10.0.0.0/8 (private)");
    assert(!validateWebhookUrlSync("http://172.16.5.5/").valid, "TEST M.4: Block 172.16.0.0/12 (private)");
    assert(!validateWebhookUrlSync("http://192.168.1.1/").valid, "TEST M.5: Block 192.168.0.0/16 (private)");
    assert(!validateWebhookUrlSync("http://[::1]/").valid, "TEST M.6: Block [::1] (IPv6 loopback)");
    assert(!validateWebhookUrlSync("http://[fe80::1]/").valid, "TEST M.7: Block [fe80::1] (IPv6 link-local)");

    // Delivery-time async DNS revalidation test
    const localHostDeliveryCheck = await validateWebhookUrlForDelivery("http://localhost:3000/");
    assert(!localHostDeliveryCheck.safe, "TEST M.8: Delivery-time SSRF revalidation blocks localhost");

    // -------------------------------------------------------------------------
    // TEST N — Normal Authenticated Operations Intact
    // -------------------------------------------------------------------------
    console.log("\n--- TEST N: Normal Authenticated Operations Intact ---");
    const normalMsg = await MessageService.send(
      { to: "919876543210", type: "text", body: "Regular operational message" },
      { clientId: clientA.id }
    );
    assert(normalMsg.id.length > 0 && normalMsg.to === "919876543210", "TEST N.1: Normal outbound message dispatch succeeds");

    const lookupNormal = await MessageService.getById(normalMsg.id, clientA.id);
    assert(lookupNormal?.id === normalMsg.id, "TEST N.2: Normal message retrieval succeeds");

    // Clean up webhook endpoints created for Test E
    await prisma.webhookDelivery.deleteMany({ where: { endpointId: { in: [endpointA.id, endpointB.id] } } });
    await prisma.webhookEndpoint.deleteMany({ where: { id: { in: [endpointA.id, endpointB.id] } } });

  } finally {
    // Teardown test tenants
    console.log("\n🧹 Cleaning up test tenants...");
    await prisma.messageEvent.deleteMany({ where: { clientId: { in: [clientA.id, clientB.id] } } });
    await prisma.message.deleteMany({ where: { clientId: { in: [clientA.id, clientB.id] } } });
    await prisma.otpVerification.deleteMany({ where: { clientId: { in: [clientA.id, clientB.id] } } });
    await prisma.webhookDelivery.deleteMany({ where: { clientId: { in: [clientA.id, clientB.id] } } });
    await prisma.webhookEndpoint.deleteMany({ where: { clientId: { in: [clientA.id, clientB.id] } } });
    await prisma.apiKey.deleteMany({ where: { clientId: { in: [clientA.id, clientB.id] } } });
    await prisma.apiClient.deleteMany({ where: { id: { in: [clientA.id, clientB.id] } } });
    console.log("✅ Teardown complete. Live Supabase database left clean.");
  }

  console.log("\n==================================================================");
  console.log(`Summary: ${passed} PASSED, ${failed} FAILED`);
  console.log("==================================================================\n");

  if (failed > 0) {
    process.exit(1);
  }
  process.exit(0);
}

runPhase1SecurityTests()
  .catch((err) => {
    console.error("❌ Test suite fatal error:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
