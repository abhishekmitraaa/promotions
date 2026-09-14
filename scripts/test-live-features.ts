import { prisma } from "../src/lib/prisma";
import { signHmacSha256 } from "../src/lib/crypto";
import { env } from "../src/lib/env";

const BASE_URL = "http://127.0.0.1:3000";

interface TestStats {
  total: number;
  passed: number;
  failed: number;
  bugs: string[];
}

const stats: TestStats = {
  total: 0,
  passed: 0,
  failed: 0,
  bugs: [],
};

function recordTest(name: string, passed: boolean, details?: string) {
  stats.total++;
  if (passed) {
    stats.passed++;
    console.log(`  ✅ [PASS] ${name}`);
  } else {
    stats.failed++;
    const bugMsg = `${name}${details ? ` -> ${details}` : ""}`;
    stats.bugs.push(bugMsg);
    console.error(`  ❌ [FAIL] ${bugMsg}`);
  }
}

async function runTests() {
  console.log("\n=======================================================");
  console.log("🧪 RUNNING COMPREHENSIVE LIVE HTTP FEATURE TEST SUITE");
  console.log(`🎯 Target Server: ${BASE_URL}`);
  console.log("=======================================================\n");

  // Step 0: Fetch the Fake User's API Key from SQLite
  const fakeClient = await prisma.apiClient.findFirst({
    where: { name: "Apex Logistics Global" },
    include: { keys: true },
  });

  if (!fakeClient || fakeClient.keys.length === 0) {
    throw new Error("Fake user 'Apex Logistics Global' not found. Run scripts/reset-and-seed.ts first.");
  }

  // To test Bearer auth with real hash matching, let's create a known test key directly so we have the raw string
  const { generateApiKey } = await import("../src/lib/crypto");
  const testKeyData = generateApiKey();
  await prisma.apiKey.create({
    data: {
      clientId: fakeClient.id,
      name: "Live Test Active Key",
      keyPrefix: testKeyData.keyPrefix,
      keyHash: testKeyData.keyHash,
    },
  });
  const apiKey = testKeyData.rawKey;

  console.log(`👤 Using Fake User: ${fakeClient.name} (ID: ${fakeClient.id})`);
  console.log(`🔑 Using Active Key Prefix: ${testKeyData.keyPrefix}\n`);

  // =========================================================================
  // FEATURE 1: Health Check Endpoint
  // =========================================================================
  console.log("-------------------------------------------------------");
  console.log("Feature 1: Health Check API (GET /api/health)");
  console.log("-------------------------------------------------------");
  {
    const res = await fetch(`${BASE_URL}/api/health`);
    const json = await res.json();
    recordTest("Health endpoint returns HTTP 200", res.status === 200, `Got ${res.status}`);
    recordTest("Health status is 'ok'", json.status === "ok", JSON.stringify(json));
    recordTest("Database service reports 'connected'", json.services?.database === "connected", JSON.stringify(json.services));
  }

  // =========================================================================
  // FEATURE 2: API Authentication & Security Handling
  // =========================================================================
  console.log("\n-------------------------------------------------------");
  console.log("Feature 2: Authentication & Security (Bearer Tokens)");
  console.log("-------------------------------------------------------");
  {
    // A: Missing Authorization header
    const resNoAuth = await fetch(`${BASE_URL}/api/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: "15552345678", type: "text", body: "test" }),
    });
    const jsonNoAuth = await resNoAuth.json();
    recordTest(
      "Missing Authorization header returns HTTP 401 UNAUTHORIZED",
      resNoAuth.status === 401 && jsonNoAuth.error?.code === "UNAUTHORIZED",
      `Got status ${resNoAuth.status}, code: ${jsonNoAuth.error?.code}`
    );

    // B: Malformed Authorization header
    const resBadFormat = await fetch(`${BASE_URL}/api/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Basic dXNlcjpwYXNz",
      },
      body: JSON.stringify({ to: "15552345678", type: "text", body: "test" }),
    });
    const jsonBadFormat = await resBadFormat.json();
    recordTest(
      "Malformed Authorization header returns HTTP 401 UNAUTHORIZED",
      resBadFormat.status === 401 && jsonBadFormat.error?.code === "UNAUTHORIZED",
      `Got status ${resBadFormat.status}, code: ${jsonBadFormat.error?.code}`
    );

    // C: Non-existent / Invalid API Key
    const resInvalidKey = await fetch(`${BASE_URL}/api/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer whub_000000000000000000000000000000000000",
      },
      body: JSON.stringify({ to: "15552345678", type: "text", body: "test" }),
    });
    const jsonInvalidKey = await resInvalidKey.json();
    recordTest(
      "Invalid API key returns HTTP 401 UNAUTHORIZED",
      resInvalidKey.status === 401 && jsonInvalidKey.error?.code === "UNAUTHORIZED",
      `Got status ${resInvalidKey.status}, code: ${jsonInvalidKey.error?.code}`
    );
  }

  // =========================================================================
  // FEATURE 3: Outbound Text Messaging
  // =========================================================================
  console.log("\n-------------------------------------------------------");
  console.log("Feature 3: Outbound Text Messaging (POST /api/v1/messages)");
  console.log("-------------------------------------------------------");
  let sentTextMessageId = "";
  let sentProviderMessageId = "";
  const testRecipient = "15552345678";
  {
    // A: Validation error - missing body
    const resMissingBody = await fetch(`${BASE_URL}/api/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ to: testRecipient, type: "text" }),
    });
    const jsonMissingBody = await resMissingBody.json();
    recordTest(
      "Missing text body returns HTTP 400 VALIDATION_ERROR",
      resMissingBody.status === 400 && jsonMissingBody.error?.code === "VALIDATION_ERROR",
      `Got ${resMissingBody.status}`
    );

    // B: Validation error - invalid phone number
    const resBadPhone = await fetch(`${BASE_URL}/api/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ to: "invalid-phone", type: "text", body: "test" }),
    });
    recordTest(
      "Invalid phone format returns HTTP 400",
      resBadPhone.status === 400,
      `Got ${resBadPhone.status}`
    );

    // C: Valid text message send
    const resValid = await fetch(`${BASE_URL}/api/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        to: testRecipient,
        type: "text",
        body: "Hello! Your shipment #APX-4819 is in transit and arriving today.",
      }),
    });
    const jsonValid = await resValid.json();
    recordTest("Valid text message returns HTTP 200", resValid.status === 200, `Got ${resValid.status}`);
    recordTest("Text message response includes message ID and status SENT", !!jsonValid.message?.id && jsonValid.message?.status === "SENT", JSON.stringify(jsonValid));

    sentTextMessageId = jsonValid.message?.id;
    sentProviderMessageId = jsonValid.message?.providerMessageId;

    // Verify stored in DB
    const dbRecord = await prisma.message.findUnique({ where: { id: sentTextMessageId } });
    recordTest(
      "Text message persisted in database with correct fields",
      !!dbRecord && dbRecord.to === testRecipient && dbRecord.direction === "OUTBOUND",
      JSON.stringify(dbRecord)
    );
  }

  // =========================================================================
  // FEATURE 4: Outbound Template Messaging
  // =========================================================================
  console.log("\n-------------------------------------------------------");
  console.log("Feature 4: Outbound Template Messaging (POST /api/v1/messages)");
  console.log("-------------------------------------------------------");
  {
    // A: Validation error - missing templateName
    const resMissingTpl = await fetch(`${BASE_URL}/api/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ to: testRecipient, type: "template" }),
    });
    recordTest("Missing templateName returns HTTP 400", resMissingTpl.status === 400, `Got ${resMissingTpl.status}`);

    // B: Valid template message
    const resValidTpl = await fetch(`${BASE_URL}/api/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        to: testRecipient,
        type: "template",
        templateName: "delivery_update",
        templateLanguage: "en_US",
        templateParameters: ["APX-4819", "Scheduled for 3:00 PM"],
      }),
    });
    const jsonValidTpl = await resValidTpl.json();
    recordTest("Valid template message returns HTTP 200", resValidTpl.status === 200, `Got ${resValidTpl.status}`);
    recordTest("Template message has type TEMPLATE and status SENT", jsonValidTpl.message?.type === "TEMPLATE" && jsonValidTpl.message?.status === "SENT", JSON.stringify(jsonValidTpl));
  }

  // =========================================================================
  // FEATURE 5: Outbound Idempotency Support
  // =========================================================================
  console.log("\n-------------------------------------------------------");
  console.log("Feature 5: Outbound Idempotency (Idempotency-Key Header)");
  console.log("-------------------------------------------------------");
  {
    const idempotencyKey = `live_test_idemp_${Date.now()}`;
    const payload = {
      to: testRecipient,
      type: "text",
      body: "Testing idempotent duplicate prevention",
    };

    const res1 = await fetch(`${BASE_URL}/api/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(payload),
    });
    const json1 = await res1.json();

    const res2 = await fetch(`${BASE_URL}/api/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(payload),
    });
    const json2 = await res2.json();

    recordTest("First idempotent dispatch returns HTTP 200", res1.status === 200);
    recordTest("Second idempotent dispatch returns HTTP 200", res2.status === 200);
    recordTest(
      "Both requests return exact same message ID (no duplicate created)",
      json1.message?.id === json2.message?.id,
      `ID1: ${json1.message?.id}, ID2: ${json2.message?.id}`
    );
  }

  // =========================================================================
  // FEATURE 6: Message Retrieval & Listing
  // =========================================================================
  console.log("\n-------------------------------------------------------");
  console.log("Feature 6: Message Retrieval & Listing (GET /api/v1/messages)");
  console.log("-------------------------------------------------------");
  {
    // A: Single message lookup
    const resSingle = await fetch(`${BASE_URL}/api/v1/messages/${sentTextMessageId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const jsonSingle = await resSingle.json();
    recordTest("Single message lookup returns HTTP 200", resSingle.status === 200);
    recordTest("Single message matches sent ID", jsonSingle.data?.id === sentTextMessageId);

    // B: Non-existent message lookup
    const resNotFound = await fetch(`${BASE_URL}/api/v1/messages/00000000-0000-0000-0000-000000000000`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    recordTest("Non-existent message returns HTTP 404", resNotFound.status === 404);

    // C: Filtered message list
    const resList = await fetch(`${BASE_URL}/api/v1/messages?direction=OUTBOUND&status=SENT&page=1&limit=10`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const jsonList = await resList.json();
    recordTest("Message list returns HTTP 200", resList.status === 200);
    recordTest("Message list has pagination and data array", Array.isArray(jsonList.data) && jsonList.pagination?.total > 0);
  }

  // =========================================================================
  // FEATURE 7: Grouped Conversations
  // =========================================================================
  console.log("\n-------------------------------------------------------");
  console.log("Feature 7: Grouped Conversations (GET /api/v1/conversations)");
  console.log("-------------------------------------------------------");
  {
    const resConv = await fetch(`${BASE_URL}/api/v1/conversations`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const jsonConv = await resConv.json();
    recordTest("Conversations endpoint returns HTTP 200", resConv.status === 200);
    recordTest("Conversations list contains thread for test recipient", Array.isArray(jsonConv.data) && jsonConv.data.some((c: any) => c.phoneNumber === testRecipient));
  }

  // =========================================================================
  // FEATURE 8: Meta Webhook Verification Handshake
  // =========================================================================
  console.log("\n-------------------------------------------------------");
  console.log("Feature 8: Meta Webhook Verification Handshake (GET /api/webhooks/whatsapp)");
  console.log("-------------------------------------------------------");
  {
    // A: Missing parameters
    const resMissing = await fetch(`${BASE_URL}/api/webhooks/whatsapp`);
    recordTest("Missing query parameters returns HTTP 400", resMissing.status === 400);

    // B: Wrong token
    const resWrong = await fetch(
      `${BASE_URL}/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong_token&hub.challenge=test_123`
    );
    recordTest("Wrong verify token returns HTTP 403", resWrong.status === 403);

    // C: Valid verification handshake
    const verifyToken = env.META_WEBHOOK_VERIFY_TOKEN || "development_webhook_verify_token";
    const challengeVal = `challenge_${Date.now()}`;
    const resValidHandshake = await fetch(
      `${BASE_URL}/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(verifyToken)}&hub.challenge=${challengeVal}`
    );
    const challengeResp = await resValidHandshake.text();
    recordTest("Valid handshake returns HTTP 200", resValidHandshake.status === 200);
    recordTest("Valid handshake echoes raw challenge string", challengeResp === challengeVal, `Got: "${challengeResp}"`);
  }

  // =========================================================================
  // FEATURE 9: Meta Inbound Webhook Processing & Status Updates
  // =========================================================================
  console.log("\n-------------------------------------------------------");
  console.log("Feature 9: Meta Inbound Message & Status Updates (POST /api/webhooks/whatsapp)");
  console.log("-------------------------------------------------------");
  {
    // A: Process Inbound Message
    const inboundPayload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "entry_live_01",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: {
                  display_phone_number: "15550239847",
                  phone_number_id: "9988776655",
                },
                messages: [
                  {
                    from: testRecipient,
                    id: `wamid.inbound_live_${Date.now()}`,
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    type: "text",
                    text: { body: "Package received safely! Thank you Apex Logistics." },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const rawInboundJson = JSON.stringify(inboundPayload);
    const signature = env.META_APP_SECRET ? `sha256=${signHmacSha256(rawInboundJson, env.META_APP_SECRET)}` : "";

    const resInbound = await fetch(`${BASE_URL}/api/webhooks/whatsapp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(signature ? { "X-Hub-Signature-256": signature } : {}),
      },
      body: rawInboundJson,
    });
    recordTest("Inbound webhook POST returns HTTP 200", resInbound.status === 200, `Got ${resInbound.status}`);

    // Verify inbound message saved to DB
    const inboundDb = await prisma.message.findFirst({
      where: { from: testRecipient, direction: "INBOUND" },
      orderBy: { createdAt: "desc" },
    });
    recordTest(
      "Inbound message saved in database with status RECEIVED",
      !!inboundDb && inboundDb.body === "Package received safely! Thank you Apex Logistics." && inboundDb.status === "RECEIVED",
      JSON.stringify(inboundDb)
    );

    // B: Process Status Updates (DELIVERED -> READ) for our sent text message
    if (sentProviderMessageId) {
      const statusPayload = {
        object: "whatsapp_business_account",
        entry: [
          {
            id: "entry_live_02",
            changes: [
              {
                field: "messages",
                value: {
                  messaging_product: "whatsapp",
                  metadata: {
                    display_phone_number: "15550239847",
                    phone_number_id: "9988776655",
                  },
                  statuses: [
                    {
                      id: sentProviderMessageId,
                      status: "delivered",
                      timestamp: String(Math.floor(Date.now() / 1000)),
                      recipient_id: testRecipient,
                    },
                    {
                      id: sentProviderMessageId,
                      status: "read",
                      timestamp: String(Math.floor(Date.now() / 1000) + 2),
                      recipient_id: testRecipient,
                    },
                  ],
                },
              },
            ],
          },
        ],
      };

      const rawStatusJson = JSON.stringify(statusPayload);
      const statusSig = env.META_APP_SECRET ? `sha256=${signHmacSha256(rawStatusJson, env.META_APP_SECRET)}` : "";

      const resStatus = await fetch(`${BASE_URL}/api/webhooks/whatsapp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(statusSig ? { "X-Hub-Signature-256": statusSig } : {}),
        },
        body: rawStatusJson,
      });
      recordTest("Status update webhook POST returns HTTP 200", resStatus.status === 200);

      // Verify DB transition
      const updatedSentMsg = await prisma.message.findUnique({ where: { id: sentTextMessageId } });
      recordTest(
        "Outbound message transitioned to READ with deliveredAt and readAt timestamps",
        updatedSentMsg?.status === "READ" && !!updatedSentMsg?.deliveredAt && !!updatedSentMsg?.readAt,
        `Status: ${updatedSentMsg?.status}, deliveredAt: ${updatedSentMsg?.deliveredAt}, readAt: ${updatedSentMsg?.readAt}`
      );
    }
  }

  // =========================================================================
  // FEATURE 10: Outgoing Webhooks & Delivery Auditing
  // =========================================================================
  console.log("\n-------------------------------------------------------");
  console.log("Feature 10: Outgoing Webhook Subscriptions & Delivery Audit");
  console.log("-------------------------------------------------------");
  let testEndpointId = "";
  {
    // A: Register endpoint via Admin API
    const resReg = await fetch(`${BASE_URL}/api/admin/webhooks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Apex Logistics ERP Webhook Receiver",
        url: "http://127.0.0.1:3000/api/health", // Local test receiver
        secret: "apex_webhook_signing_secret_123",
        subscribedEvents: ["message.sent", "message.delivered", "message.read", "message.inbound"],
      }),
    });
    const jsonReg = await resReg.json();
    const regEp = jsonReg.endpoint || jsonReg.data;
    recordTest("Register webhook endpoint returns HTTP 200", resReg.status === 200);
    recordTest("Webhook endpoint created with active status", regEp?.active === true);
    testEndpointId = regEp?.id;

    // B: List webhook endpoints
    const resListEp = await fetch(`${BASE_URL}/api/admin/webhooks`);
    const jsonListEp = await resListEp.json();
    const epList = jsonListEp.endpoints || jsonListEp.data || [];
    recordTest("List webhook endpoints returns HTTP 200 with registered endpoint", resListEp.status === 200 && epList.some((ep: any) => ep.id === testEndpointId));

    // C: Trigger an outbound message to cause outgoing webhook dispatch
    await fetch(`${BASE_URL}/api/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        to: testRecipient,
        type: "text",
        body: "Testing webhook forwarding dispatch event",
      }),
    });

    // Delay for async delivery record to be created in DB
    await new Promise((r) => setTimeout(r, 1000));

    // D: Query delivery audit records
    const resDeliveries = await fetch(`${BASE_URL}/api/admin/webhooks/deliveries`);
    const jsonDeliveries = await resDeliveries.json();
    const delList = jsonDeliveries.deliveries || jsonDeliveries.data || [];
    recordTest("Webhook deliveries API returns HTTP 200", resDeliveries.status === 200);
    recordTest("Webhook delivery record created for dispatched event", Array.isArray(delList) && delList.length > 0);

    // Cleanup test endpoint to avoid unnecessary retry polling
    if (testEndpointId) {
      await prisma.webhookDelivery.deleteMany({ where: { endpointId: testEndpointId } });
      await prisma.webhookEndpoint.delete({ where: { id: testEndpointId } });
    }
  }

  // =========================================================================
  // FEATURE 11: OTP Verification System & Protections
  // =========================================================================
  console.log("\n-------------------------------------------------------");
  console.log("Feature 11: OTP Request, Verification & Security Controls");
  console.log("-------------------------------------------------------");
  {
    const otpDestination = "15559876543";
    const otpPurpose = "driver_portal_auth";

    // A: Request OTP
    const resReq = await fetch(`${BASE_URL}/api/v1/otp/request`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ to: otpDestination, purpose: otpPurpose }),
    });
    const jsonReq = await resReq.json();
    recordTest("OTP request returns HTTP 200", resReq.status === 200);
    recordTest("OTP response contains devCode in dev mode", !!jsonReq.data?.devCode);

    const generatedCode = jsonReq.data?.devCode;

    // B: Verify with Incorrect Code
    const resWrong = await fetch(`${BASE_URL}/api/v1/otp/verify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ to: otpDestination, purpose: otpPurpose, code: "000000" }),
    });
    const jsonWrong = await resWrong.json();
    recordTest("Incorrect OTP verification returns HTTP 400", resWrong.status === 400);
    recordTest("Incorrect OTP returns remaining attempts count", typeof jsonWrong.error?.remainingAttempts === "number");

    // C: Verify with Correct Code
    if (generatedCode) {
      const resCorrect = await fetch(`${BASE_URL}/api/v1/otp/verify`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ to: otpDestination, purpose: otpPurpose, code: generatedCode }),
      });
      const jsonCorrect = await resCorrect.json();
      recordTest("Correct OTP verification returns HTTP 200", resCorrect.status === 200);
      recordTest("OTP response indicates verified: true", jsonCorrect.data?.verified === true);

      // D: Prevent Replay Attack (attempt to reuse same verified code)
      const resReplay = await fetch(`${BASE_URL}/api/v1/otp/verify`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ to: otpDestination, purpose: otpPurpose, code: generatedCode }),
      });
      recordTest("Replay attack (reusing verified OTP) is rejected with HTTP 400", resReplay.status === 400);
    }
  }

  // =========================================================================
  // FEATURE 12: Admin & Dashboard Internal Endpoints
  // =========================================================================
  console.log("\n-------------------------------------------------------");
  console.log("Feature 12: Internal Admin & Dashboard Endpoints");
  console.log("-------------------------------------------------------");
  {
    // A: Overview metrics
    const resOverview = await fetch(`${BASE_URL}/api/admin/overview`);
    const jsonOverview = await resOverview.json();
    recordTest("Admin overview returns HTTP 200", resOverview.status === 200);
    recordTest("Admin overview includes stats counters", typeof jsonOverview.stats?.totalMessages === "number");

    // B: Admin messages listing
    const resAdminMsgs = await fetch(`${BASE_URL}/api/admin/messages`);
    const jsonAdminMsgs = await resAdminMsgs.json();
    recordTest("Admin messages listing returns HTTP 200 without API key", resAdminMsgs.status === 200);
    recordTest("Admin messages returns data array", Array.isArray(jsonAdminMsgs.data));

    // C: Admin send message
    const resAdminSend = await fetch(`${BASE_URL}/api/admin/messages/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        to: testRecipient,
        type: "text",
        body: "Message sent directly from Dashboard Admin interface",
      }),
    });
    const jsonAdminSend = await resAdminSend.json();
    recordTest("Admin send message returns HTTP 200 without API key", resAdminSend.status === 200 && jsonAdminSend.success === true);

    // D: Admin conversations listing
    const resAdminConv = await fetch(`${BASE_URL}/api/admin/conversations`);
    const jsonAdminConv = await resAdminConv.json();
    recordTest("Admin conversations returns HTTP 200 without API key", resAdminConv.status === 200 && Array.isArray(jsonAdminConv.data));

    // E: Admin API keys listing
    const resAdminKeys = await fetch(`${BASE_URL}/api/admin/api-keys`);
    const jsonAdminKeys = await resAdminKeys.json();
    const clientList = jsonAdminKeys.clients || jsonAdminKeys.data || [];
    recordTest("Admin API keys returns HTTP 200 with client list", resAdminKeys.status === 200 && Array.isArray(clientList));
  }

  // =========================================================================
  // FEATURE 13: API Key Revocation Security
  // =========================================================================
  console.log("\n-------------------------------------------------------");
  console.log("Feature 13: API Key Revocation Enforcement");
  console.log("-------------------------------------------------------");
  {
    // Create a temporary key to revoke
    const tempKeyData = generateApiKey();
    const tempKeyRecord = await prisma.apiKey.create({
      data: {
        clientId: fakeClient.id,
        name: "Temporary Revocation Test Key",
        keyPrefix: tempKeyData.keyPrefix,
        keyHash: tempKeyData.keyHash,
      },
    });

    // Verify key works before revocation
    const resBefore = await fetch(`${BASE_URL}/api/v1/messages?limit=1`, {
      headers: { Authorization: `Bearer ${tempKeyData.rawKey}` },
    });
    recordTest("Key authenticates before revocation", resBefore.status === 200);

    // Revoke key via Admin API
    const resRevoke = await fetch(`${BASE_URL}/api/admin/api-keys/${tempKeyRecord.id}/revoke`, {
      method: "POST",
    });
    recordTest("Revoke key API returns HTTP 200", resRevoke.status === 200);

    // Verify key is immediately rejected with HTTP 403
    const resAfter = await fetch(`${BASE_URL}/api/v1/messages?limit=1`, {
      headers: { Authorization: `Bearer ${tempKeyData.rawKey}` },
    });
    const jsonAfter = await resAfter.json();
    recordTest(
      "Revoked key is rejected with HTTP 403 FORBIDDEN",
      resAfter.status === 403 && jsonAfter.error?.code === "FORBIDDEN",
      `Got status ${resAfter.status}, code ${jsonAfter.error?.code}`
    );
  }

  // Cleanup active test key created for this run
  await prisma.apiKey.deleteMany({ where: { keyPrefix: testKeyData.keyPrefix } });

  // =========================================================================
  // FINAL REPORT
  // =========================================================================
  console.log("\n=======================================================");
  console.log("📊 TEST EXECUTION SUMMARY");
  console.log("=======================================================");
  console.log(`  Total Checks Executed : ${stats.total}`);
  console.log(`  Passed Checks         : ${stats.passed}`);
  console.log(`  Failed Checks         : ${stats.failed}`);
  console.log("=======================================================\n");

  if (stats.failed > 0) {
    console.error("🚨 BUGS / DISCREPANCIES DETECTED:");
    stats.bugs.forEach((b, idx) => console.error(`  ${idx + 1}. ${b}`));
    process.exit(1);
  } else {
    console.log("🎉 ALL FEATURES ARE FULLY OPERATIONAL AND VERIFIED!\n");
    process.exit(0);
  }
}

runTests()
  .catch((err) => {
    console.error("Fatal test suite runner error:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
