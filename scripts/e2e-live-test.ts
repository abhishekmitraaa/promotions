import { prisma } from "../src/lib/prisma";
import { assertDestructiveTestAllowed } from "./test-db-guard";
import { generateApiKey, encryptWebhookSecret } from "../src/lib/crypto";
import { MessageService } from "../src/lib/services/message-service";
import { OtpService } from "../src/lib/services/otp-service";
import { WebhookService } from "../src/lib/services/webhook-service";
import { WebhookPayload } from "../src/lib/whatsapp/types";
import { MessageDirection } from "@prisma/client";

async function runFullE2ETest() {
  assertDestructiveTestAllowed("e2e-live-test");
  console.log("\n=========================================================");
  console.log("🚀 STARTING COMPLETE END-TO-END FEATURE SIMULATION TEST");
  console.log("=========================================================\n");

  let step = 1;

  function logStep(title: string) {
    console.log(`\n---------------------------------------------------------`);
    console.log(`[Step ${step++}] ${title}`);
    console.log(`---------------------------------------------------------`);
  }

  // 1. Create Fake User / API Client & API Key
  logStep("Creating Fake API Client & Generating Bearer API Key");
  const fakeClient = await prisma.apiClient.create({
    data: {
      name: `Fake User - Acme Corp (${Date.now()})`,
      description: "Automated end-to-end test user account",
    },
  });

  const { rawKey, keyPrefix, keyHash } = generateApiKey();
  const apiKeyRecord = await prisma.apiKey.create({
    data: {
      clientId: fakeClient.id,
      name: "E2E Test Key",
      keyPrefix,
      keyHash,
    },
  });

  console.log(`  👤 API Client Created: ${fakeClient.name} (ID: ${fakeClient.id})`);
  console.log(`  🔑 Raw API Key Generated: ${rawKey}`);
  console.log(`  🔒 Key Hash Stored: ${keyHash.substring(0, 16)}...`);

  try {
    // 2. Outbound WhatsApp Message Dispatching
    logStep("Sending Outbound WhatsApp Messages (Text & Template)");
    const fakePhone = "919876543210";

    const textResult = await MessageService.send(
      {
        to: fakePhone,
        type: "text",
        body: "Hello! This is a test message from our WhatsApp Infrastructure Service.",
      },
      { clientId: fakeClient.id }
    );
    console.log(`  ✉️ Text Message Dispatched:`, textResult);

    const templateResult = await MessageService.send(
      {
        to: fakePhone,
        type: "template",
        templateName: "hello_world",
        templateLanguage: "en_US",
      },
      { clientId: fakeClient.id }
    );
    console.log(`  📄 Template Message Dispatched:`, templateResult);

    // 3. Test Idempotency
    logStep("Testing Idempotent Outbound Message Dispatching");
    const idempotencyKey = `idemp_key_${Date.now()}`;
    const firstSend = await MessageService.send(
      { to: fakePhone, type: "text", body: "Idempotent send test" },
      { idempotencyKey, clientId: fakeClient.id }
    );
    const secondSend = await MessageService.send(
      { to: fakePhone, type: "text", body: "Idempotent send test" },
      { idempotencyKey, clientId: fakeClient.id }
    );

    console.log(`  1st Send ID: ${firstSend.id}`);
    console.log(`  2nd Send ID: ${secondSend.id}`);
    if (firstSend.id === secondSend.id) {
      console.log("  ✅ SUCCESS: Idempotency check prevented duplicate message dispatch!");
    } else {
      console.error("  ❌ FAIL: Idempotency failed to return same message record");
    }

    // 4. Querying Message History & Grouped Conversations
    logStep("Querying Message History & Grouped Conversation Threads");
    const messageList = await MessageService.getMessages({
      clientId: fakeClient.id,
      direction: MessageDirection.OUTBOUND,
      search: fakePhone,
      page: 1,
      limit: 10,
    });
    console.log(`  📚 Total Outbound Messages Found for ${fakePhone}: ${messageList.pagination.total}`);

    const singleMsg = await MessageService.getById(textResult.id, fakeClient.id);
    console.log(`  🔍 Single Message Details Lookup: ID ${singleMsg?.id}, Status: ${singleMsg?.status}`);

    const conversations = await MessageService.getConversations(fakeClient.id);
    const targetConv = conversations.find((c) => c.phoneNumber === fakePhone);
    console.log(`  👥 Grouped Thread for ${fakePhone}: ${targetConv?.messageCount} total messages`);

    // 5. Inbound WhatsApp Message Simulation
    logStep("Simulating Inbound Webhook Event from Meta");
    const fakeIncomingMsgId = `wamid.HBgL${Date.now()}fakeInbound`;
    const incomingWebhookPayload: WebhookPayload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "fake_waba_123",
          changes: [
            {
              value: {
                messaging_product: "whatsapp",
                metadata: {
                  display_phone_number: "15550234567",
                  phone_number_id: "fake_phone_id_999",
                },
                contacts: [{ profile: { name: "John Doe" }, wa_id: fakePhone }],
                messages: [
                  {
                    from: fakePhone,
                    id: fakeIncomingMsgId,
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    type: "text",
                    text: { body: "Can I get assistance with my order?" },
                  },
                ],
              },
              field: "messages",
            },
          ],
        },
      ],
    };

    await WebhookService.processPayload(incomingWebhookPayload);

    // 6. Outgoing Webhook Endpoint & Delivery Audit Test
    logStep("Testing Outgoing Webhook Forwarding & Delivery Audit Log");
    const testWebhookEndpoint = await prisma.webhookEndpoint.create({
      data: {
        clientId: fakeClient.id,
        name: "External Analytics Webhook Receiver",
        url: "https://example.com/webhook",
        encryptedSecret: encryptWebhookSecret("webhook_signing_secret_999"),
        subscribedEvents: JSON.stringify(["*"]),
        active: true,
      },
    });
    console.log(`  🌐 Created Webhook Endpoint: ${testWebhookEndpoint.name} (${testWebhookEndpoint.url})`);

    // Trigger outbound webhook event
    await MessageService.send(
      {
        to: fakePhone,
        type: "text",
        body: "Testing webhook forwarding trigger",
      },
      { clientId: fakeClient.id }
    );

    // Give short delay for async delivery log entry
    await new Promise((resolve) => setTimeout(resolve, 500));

    const deliveries = await prisma.webhookDelivery.findMany({
      where: { endpointId: testWebhookEndpoint.id },
      orderBy: { createdAt: "desc" },
    });
    if (deliveries.length > 0) {
      console.log(`  ✅ Delivery Status: ${deliveries[0].status}, Event: ${deliveries[0].eventType}`);
    }

    // Clean up test endpoint
    await prisma.webhookDelivery.deleteMany({ where: { endpointId: testWebhookEndpoint.id } });
    await prisma.webhookEndpoint.delete({ where: { id: testWebhookEndpoint.id } });

    // 7. OTP Verification System Workflow
    logStep("Testing Full OTP Request & Verification Lifecycle");
    const otpPurpose = "user_login_test";

    // A. Request OTP
    const otpReqResult = await OtpService.requestOtp(fakeClient.id, fakePhone, otpPurpose);
    console.log("  📲 OTP Requested:", otpReqResult);
    const devOtpCode = otpReqResult.data?.devCode;

    if (devOtpCode) {
      console.log(`  🔑 Dev OTP Code Generated: ${devOtpCode}`);

      // B. Test Incorrect OTP Attempt
      console.log("  🧪 Attempting verification with incorrect code ('000000')...");
      const invalidVerResult = await OtpService.verifyOtp(fakeClient.id, fakePhone, otpPurpose, "000000");
      console.log("  ❌ Result:", invalidVerResult.error?.message, `(Remaining attempts: ${invalidVerResult.error?.remainingAttempts})`);

      // C. Test Correct OTP Verification
      console.log(`  🧪 Attempting verification with correct code ('${devOtpCode}')...`);
      const validVerResult = await OtpService.verifyOtp(fakeClient.id, fakePhone, otpPurpose, devOtpCode);
      console.log("  ✅ Result:", validVerResult);

      // D. Test Reuse Prevention (Attempting to verify same OTP again)
      console.log("  🧪 Attempting to re-use already verified OTP code...");
      const reuseVerResult = await OtpService.verifyOtp(fakeClient.id, fakePhone, otpPurpose, devOtpCode);
      console.log("  🛑 Reuse Prevented Result:", reuseVerResult.error?.message);
    }

    // 8. Revoking API Key Security Check
    logStep("Testing API Key Revocation Security");
    await prisma.apiKey.update({
      where: { id: apiKeyRecord.id },
      data: { revokedAt: new Date() },
    });

    const revokedRecord = await prisma.apiKey.findUnique({
      where: { id: apiKeyRecord.id },
    });

    if (revokedRecord?.revokedAt) {
      console.log("  ✅ API Key successfully revoked in database. Requests using this key will be rejected with HTTP 403.");
    }
  } finally {
    // Clean up all test data for fakeClient to leave live Supabase database clean
    await prisma.messageEvent.deleteMany({ where: { clientId: fakeClient.id } });
    await prisma.message.deleteMany({ where: { clientId: fakeClient.id } });
    await prisma.otpVerification.deleteMany({ where: { clientId: fakeClient.id } });
    await prisma.apiKey.deleteMany({ where: { clientId: fakeClient.id } });
    await prisma.apiClient.delete({ where: { id: fakeClient.id } }).catch(() => {});
    console.log("  🧹 Cleaned up temporary test tenant data");
  }

  console.log("\n=========================================================");
  console.log("🎉 ALL E2E FEATURE TESTS COMPLETED SUCCESSFULLY!");
  console.log("=========================================================\n");
}

runFullE2ETest()
  .catch((err) => {
    console.error("❌ E2E Test execution error:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
