/**
 * Gmail Bounce Detection Verification Suite
 *
 * Gmail has no delivery webhooks; bounces arrive as mailer-daemon messages in the sending
 * mailbox. Verifies, against a disposable PostgreSQL and a mocked Gmail API:
 * 1. Detection is opt-in (GMAIL_BOUNCE_DETECTION) and requires the gmail.readonly scope.
 * 2. A hard bounce is recorded as a BOUNCED event linked to the original delivery (by thread),
 *    the delivery becomes BOUNCED and the recipient is suppressed.
 * 3. A soft bounce is recorded without suppression; delay notices are ignored.
 * 4. Re-scanning the same mailbox never duplicates events.
 * 5. The OAuth consent URL requests gmail.readonly only when detection is enabled.
 */

if (!process.env.DATABASE_URL || process.env.DATABASE_URL.includes("peqynzeioiauynfpdsdv") || process.env.DATABASE_URL.includes("supabase.co")) {
  process.env.DATABASE_URL = "postgresql://postgres:postgres@127.0.0.1:5433/email_test";
}
if (!process.env.DIRECT_URL || process.env.DIRECT_URL.includes("peqynzeioiauynfpdsdv") || process.env.DIRECT_URL.includes("supabase.co")) {
  process.env.DIRECT_URL = "postgresql://postgres:postgres@127.0.0.1:5433/email_test";
}
process.env.NODE_ENV = "test";
process.env.ALLOW_DESTRUCTIVE_TESTS = "true";
process.env.AUTH_SESSION_SECRET = process.env.AUTH_SESSION_SECRET || "test-session-secret-32-chars-minimum-length";
process.env.WEBHOOK_SECRET_ENCRYPTION_KEY = process.env.WEBHOOK_SECRET_ENCRYPTION_KEY || "test-webhook-encryption-key-32ch";
process.env.EMAIL_CREDENTIALS_ENCRYPTION_KEY = process.env.EMAIL_CREDENTIALS_ENCRYPTION_KEY || "test-email-encryption-key-32cha";

import { prisma } from "../src/lib/prisma";
import { encryptProviderCredential } from "../src/lib/crypto";
import { GmailBounceDetector, GMAIL_READONLY_SCOPE } from "../src/lib/services/executors/gmail-bounce-detector";
import { ServerlessJobProcessor } from "../src/lib/services/serverless-job-processor";
import { generateGoogleAuthUrl } from "../src/lib/email/providers/gmail/oauth";
import { GMAIL_SEND_SCOPE } from "../src/lib/email/providers/gmail/gmail-provider";
import {
  EmailDeliveryStatus,
  EmailEventType,
  EmailProviderStatus,
  EmailProviderType,
  EmailType,
} from "@prisma/client";

let passed = 0;
let failed = 0;

function assert(condition: boolean, name: string) {
  if (condition) {
    passed++;
    console.log(`   ✅ ${name}`);
  } else {
    failed++;
    console.error(`   ❌ FAIL: ${name}`);
  }
}

interface MockMailboxMessage {
  id: string;
  threadId: string;
  from?: string;
  subject: string;
  failedRecipients?: string;
  snippet: string;
}

async function main() {
  console.log("===============================================================================");
  console.log("📭 STARTING GMAIL BOUNCE DETECTION VERIFICATION SUITE");
  console.log("===============================================================================");

  const run = Date.now();
  const tenantId = `gmail-bounce-${run}`;
  const hardEmail = `gone-${run}@example.com`;
  const softEmail = `full-${run}@example.com`;
  const delayEmail = `slow-${run}@example.com`;

  await prisma.apiClient.create({ data: { id: tenantId, name: "Gmail Bounce Tenant", active: true } });

  const credentials = encryptProviderCredential(
    JSON.stringify({ clientId: "cid", clientSecret: "csecret", refreshToken: "rtoken", senderEmail: "sender@example.com" })
  );
  const readableConfig = await prisma.emailProviderConfig.create({
    data: {
      clientId: tenantId,
      name: "Gmail with mailbox read access",
      providerType: EmailProviderType.GMAIL,
      status: EmailProviderStatus.ACTIVE,
      isDefault: true,
      senderEmail: "sender@example.com",
      encryptedCredentials: credentials,
      configMetadata: JSON.stringify({ grantedScopes: [GMAIL_SEND_SCOPE, GMAIL_READONLY_SCOPE] }),
    },
  });
  const sendOnlyConfig = await prisma.emailProviderConfig.create({
    data: {
      clientId: tenantId,
      name: "Gmail send-only",
      providerType: EmailProviderType.GMAIL,
      status: EmailProviderStatus.ACTIVE,
      senderEmail: "other@example.com",
      encryptedCredentials: credentials,
      configMetadata: JSON.stringify({ grantedScopes: [GMAIL_SEND_SCOPE] }),
    },
  });

  const hardDelivery = await prisma.emailDelivery.create({
    data: {
      clientId: tenantId,
      providerType: EmailProviderType.GMAIL,
      providerConfigId: readableConfig.id,
      providerMessageId: `thread-hard-${run}`,
      category: EmailType.TRANSACTIONAL,
      from: "sender@example.com",
      to: hardEmail,
      subject: "Welcome",
      textContent: "Hello",
      status: EmailDeliveryStatus.SENT,
      sentAt: new Date(),
    },
  });

  const softDelivery = await prisma.emailDelivery.create({
    data: {
      clientId: tenantId,
      providerType: EmailProviderType.GMAIL,
      providerConfigId: readableConfig.id,
      providerMessageId: `thread-soft-${run}`,
      category: EmailType.TRANSACTIONAL,
      from: "sender@example.com",
      to: softEmail,
      subject: "Welcome",
      textContent: "Hello",
      status: EmailDeliveryStatus.SENT,
      sentAt: new Date(),
    },
  });
  const victimEmail = `victim-${run}@example.com`;

  const mailbox: MockMailboxMessage[] = [
    // Forged notice: not in the thread of anything we sent
    {
      id: `spoof-unthreaded-${run}`,
      threadId: `thread-attacker-${run}`,
      subject: "Delivery Status Notification (Failure)",
      failedRecipients: victimEmail,
      snippet: "Address not found 550 5.1.1",
    },
    // Forged notice: threaded with a real delivery but naming a different address
    {
      id: `spoof-wrong-recipient-${run}`,
      threadId: `thread-soft-${run}`,
      subject: "Delivery Status Notification (Failure)",
      failedRecipients: victimEmail,
      snippet: "Address not found 550 5.1.1",
    },
    // Forged notice: right thread and recipient, but not sent by a mailer-daemon/postmaster address
    {
      id: `spoof-sender-${run}`,
      threadId: `thread-soft-${run}`,
      from: '"mailer-daemon" <attacker@evil.example>',
      subject: "Delivery Status Notification (Failure)",
      failedRecipients: softEmail,
      snippet: "Address not found 550 5.1.1",
    },
    {
      id: `dsn-hard-${run}`,
      threadId: `thread-hard-${run}`,
      subject: "Delivery Status Notification (Failure)",
      failedRecipients: hardEmail,
      snippet: `Address not found. Your message wasn't delivered to ${hardEmail} because the address couldn't be found. 550 5.1.1`,
    },
    {
      id: `dsn-soft-${run}`,
      threadId: `thread-soft-${run}`,
      subject: "Delivery Status Notification (Failure)",
      failedRecipients: softEmail,
      snippet: `Message not delivered. The recipient's inbox is out of storage space. 452 4.2.2`,
    },
    {
      id: `dsn-delay-${run}`,
      threadId: `thread-delay-${run}`,
      subject: "Delivery Status Notification (Delay)",
      failedRecipients: delayEmail,
      snippet: "There was a temporary problem delivering your message. Gmail will retry.",
    },
    {
      id: `not-a-bounce-${run}`,
      threadId: `thread-other-${run}`,
      subject: "Out of office",
      snippet: "I am away until Monday.",
    },
  ];

  let gmailCalls = 0;
  let tokenCalls = 0;
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("oauth2.googleapis.com/token")) {
      tokenCalls++;
      return new Response(JSON.stringify({ access_token: "access-token", expires_in: 3600 }), { status: 200 });
    }
    if (!url.includes("gmail.googleapis.com")) throw new Error(`Unexpected request in test: ${url}`);
    gmailCalls++;
    const auth = new Headers(init?.headers).get("authorization");
    if (auth !== "Bearer access-token") return new Response("{}", { status: 401 });

    const parsed = new URL(url);
    const idMatch = parsed.pathname.match(/\/messages\/([^/]+)$/);
    if (!idMatch) {
      return new Response(JSON.stringify({ messages: mailbox.map((m) => ({ id: m.id, threadId: m.threadId })) }), { status: 200 });
    }
    const msg = mailbox.find((m) => m.id === idMatch[1]);
    if (!msg) return new Response("{}", { status: 404 });
    const headers = [
      { name: "Subject", value: msg.subject },
      { name: "From", value: msg.from || "Mail Delivery Subsystem <mailer-daemon@googlemail.com>" },
    ];
    if (msg.failedRecipients) headers.push({ name: "X-Failed-Recipients", value: msg.failedRecipients });
    return new Response(
      JSON.stringify({ id: msg.id, threadId: msg.threadId, snippet: msg.snippet, internalDate: String(Date.now()), payload: { headers } }),
      { status: 200 }
    );
  }) as typeof fetch;

  const savedFlag = process.env.GMAIL_BOUNCE_DETECTION;
  try {
    // -------------------------------------------------------------------------
    console.log("\n▶ [Test 1] Detection is opt-in...");
    delete process.env.GMAIL_BOUNCE_DETECTION;
    const disabled = await GmailBounceDetector.run({ fetchFn });
    assert(disabled.enabled === false && gmailCalls === 0 && tokenCalls === 0, "No mailbox access when GMAIL_BOUNCE_DETECTION is not set");

    const sendOnlyUrl = await generateGoogleAuthUrl({ googleClientId: "cid", redirectUri: "https://hub.example.test/cb", tenantId, adminUserId: "admin-1" });
    assert(!decodeURIComponent(sendOnlyUrl).includes(GMAIL_READONLY_SCOPE), "Consent URL does not request gmail.readonly by default");

    process.env.GMAIL_BOUNCE_DETECTION = "true";
    const readUrl = await generateGoogleAuthUrl({ googleClientId: "cid", redirectUri: "https://hub.example.test/cb", tenantId, adminUserId: "admin-1" });
    assert(decodeURIComponent(readUrl).includes(GMAIL_READONLY_SCOPE), "Consent URL requests gmail.readonly when detection is enabled");

    // -------------------------------------------------------------------------
    console.log("\n▶ [Test 2] Mailbox scan records bounces...");
    const scan = await GmailBounceDetector.run({ fetchFn });
    assert(scan.providersChecked === 1, `Only the provider with gmail.readonly is scanned (checked: ${scan.providersChecked})`);
    assert(scan.providersSkipped >= 1, "Send-only provider is skipped");
    assert(scan.bouncesRecorded === 2, `Hard and soft bounce recorded; delay and non-bounce ignored (recorded: ${scan.bouncesRecorded})`);
    assert(scan.errors.length === 0, `No scan errors (${scan.errors.join("; ")})`);

    const hardEvent = await prisma.emailEvent.findFirst({ where: { clientId: tenantId, recipient: hardEmail } });
    assert(hardEvent?.eventType === EmailEventType.BOUNCED && hardEvent?.providerConfigId === readableConfig.id, "Hard bounce stored as tenant-bound BOUNCED event");
    assert(hardEvent?.deliveryId === hardDelivery.id, "Bounce linked to the original delivery via the Gmail thread");

    // -------------------------------------------------------------------------
    console.log("\n▶ [Test 3] Events are processed: delivery BOUNCED, hard bounce suppressed...");
    await ServerlessJobProcessor.processBackgroundJobs(50);
    await ServerlessJobProcessor.processEvents(50);
    const hardAfter = await prisma.emailDelivery.findUnique({ where: { id: hardDelivery.id } });
    const hardSuppression = await prisma.emailSuppression.findFirst({ where: { clientId: tenantId, email: hardEmail } });
    const softSuppression = await prisma.emailSuppression.findFirst({ where: { clientId: tenantId, email: softEmail } });
    const delayEvent = await prisma.emailEvent.findFirst({ where: { clientId: tenantId, recipient: delayEmail } });
    assert(hardAfter?.status === EmailDeliveryStatus.BOUNCED, `Original delivery marked BOUNCED (actual: ${hardAfter?.status})`);
    assert(hardSuppression !== null, "Hard-bounced address added to the suppression list");
    assert(softSuppression === null, "Soft bounce does not suppress the address");
    assert(delayEvent === null, "Delay notice produced no event");
    const victimEvent = await prisma.emailEvent.findFirst({ where: { clientId: tenantId, recipient: victimEmail } });
    const victimSuppression = await prisma.emailSuppression.findFirst({ where: { clientId: tenantId, email: victimEmail } });
    assert(victimEvent === null && victimSuppression === null, "Forged notices cannot suppress an address we never emailed in that thread");
    const softAfter = await prisma.emailDelivery.findUnique({ where: { id: softDelivery.id } });
    assert(softAfter?.status === EmailDeliveryStatus.BOUNCED, `Genuine soft bounce still applied to its delivery (actual: ${softAfter?.status})`);

    // -------------------------------------------------------------------------
    console.log("\n▶ [Test 4] Re-scan is idempotent...");
    const rescan = await GmailBounceDetector.run({ fetchFn });
    const eventCount = await prisma.emailEvent.count({ where: { clientId: tenantId } });
    assert(rescan.bouncesRecorded === 0, `Second scan records nothing new (recorded: ${rescan.bouncesRecorded})`);
    assert(eventCount === 2, `Still exactly 2 events (actual: ${eventCount})`);

    // -------------------------------------------------------------------------
    console.log("\n▶ [Test 5] Mailbox API failure is reported, not thrown...");
    const failing = await GmailBounceDetector.run({
      fetchFn: (async (input: RequestInfo | URL) => {
        if (String(input).includes("oauth2.googleapis.com/token")) {
          return new Response(JSON.stringify({ access_token: "access-token", expires_in: 3600 }), { status: 200 });
        }
        return new Response(JSON.stringify({ error: { message: "Insufficient Permission" } }), { status: 403 });
      }) as typeof fetch,
    });
    assert(failing.errors.length === 1 && failing.bouncesRecorded === 0, "Scan error captured in the report");
    void sendOnlyConfig;
  } finally {
    if (savedFlag === undefined) delete process.env.GMAIL_BOUNCE_DETECTION;
    else process.env.GMAIL_BOUNCE_DETECTION = savedFlag;
    await prisma.backgroundJob.deleteMany({ where: { clientId: tenantId } });
    await prisma.emailEvent.deleteMany({ where: { clientId: tenantId } });
    await prisma.emailSuppression.deleteMany({ where: { clientId: tenantId } });
    await prisma.emailDelivery.deleteMany({ where: { clientId: tenantId } });
    await prisma.emailProviderConfig.deleteMany({ where: { clientId: tenantId } });
    await prisma.oAuthState.deleteMany({ where: { tenantId } });
    await prisma.apiClient.deleteMany({ where: { id: tenantId } });
    await prisma.$disconnect();
  }

  console.log("\n===============================================================================");
  if (failed === 0) {
    console.log(`🎉 ALL ${passed} GMAIL BOUNCE DETECTION TESTS PASSED!`);
  } else {
    console.error(`❌ ${failed} TESTS FAILED out of ${passed + failed}`);
    process.exit(1);
  }
  console.log("===============================================================================");
}

main().catch((err) => {
  console.error("Fatal test error:", err);
  process.exit(1);
});
