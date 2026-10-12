/**
 * WhatsApp Automatic Retry Verification Suite
 *
 * Verifies, against a disposable PostgreSQL and a mocked Meta Graph API:
 * 1. A transient Meta failure keeps the message QUEUED and schedules a durable retry job.
 * 2. The job processor retries and marks the message SENT (exactly one extra Meta call).
 * 3. A permanent Meta rejection fails immediately with no retry job.
 * 4. Retries stop after the maximum number of attempts.
 * 5. A message whose send was in flight when the worker died is flagged, never re-sent.
 * 6. A retry job for an already-sent message is a no-op.
 */

if (!process.env.DATABASE_URL || process.env.DATABASE_URL.includes("peqynzeioiauynfpdsdv") || process.env.DATABASE_URL.includes("supabase.co")) {
  process.env.DATABASE_URL = "postgresql://postgres:postgres@127.0.0.1:5433/email_test";
}
if (!process.env.DIRECT_URL || process.env.DIRECT_URL.includes("peqynzeioiauynfpdsdv") || process.env.DIRECT_URL.includes("supabase.co")) {
  process.env.DIRECT_URL = "postgresql://postgres:postgres@127.0.0.1:5433/email_test";
}
process.env.NODE_ENV = "test";
process.env.ALLOW_DESTRUCTIVE_TESTS = "true";
process.env.META_ACCESS_TOKEN = "test-meta-access-token";
process.env.META_PHONE_NUMBER_ID = "1234567890";
process.env.DEV_ALLOW_UNCONFIGURED_META = "false";

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

type MetaMode = "OK" | "TRANSIENT_503" | "PERMANENT_400";

async function main() {
  // Dynamic imports so the environment above is in place before env.ts is evaluated
  const { prisma } = await import("../src/lib/prisma");
  const { MessageService } = await import("../src/lib/services/message-service");
  const { ServerlessJobProcessor } = await import("../src/lib/services/serverless-job-processor");
  const { ReconciliationExecutor } = await import("../src/lib/services/executors/reconciliation-executor");
  const { SEND_IN_FLIGHT_SUFFIX, SEND_OUTCOME_UNKNOWN } = await import("../src/lib/services/executors/claim-lock");
  const { MessageStatus, MessageDirection, MessageType, BackgroundJobStatus } = await import("@prisma/client");

  console.log("===============================================================================");
  console.log("📲 STARTING WHATSAPP AUTOMATIC RETRY VERIFICATION SUITE");
  console.log("===============================================================================");

  // Mock the Meta Graph API
  let metaMode: MetaMode = "OK";
  let metaCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (!url.includes("graph.facebook.com")) {
      throw new Error(`Unexpected outbound request in test: ${url}`);
    }
    metaCalls++;
    if (metaMode === "TRANSIENT_503") {
      return new Response(JSON.stringify({ error: { message: "Service temporarily unavailable", code: 2 } }), { status: 503 });
    }
    if (metaMode === "PERMANENT_400") {
      return new Response(JSON.stringify({ error: { message: "Recipient phone number not in allowed list", code: 131030 } }), { status: 400 });
    }
    return new Response(
      JSON.stringify({ messaging_product: "whatsapp", contacts: [{ input: "x", wa_id: "x" }], messages: [{ id: `wamid.test_${Date.now()}_${metaCalls}` }] }),
      { status: 200 }
    );
  }) as typeof fetch;

  const tenantId = `wa-retry-${Date.now()}`;
  await prisma.apiClient.create({ data: { id: tenantId, name: "WhatsApp Retry Tenant", active: true } });

  const runJobs = async (messageId: string) => {
    await prisma.backgroundJob.updateMany({
      where: { clientId: tenantId, payload: { contains: messageId } },
      data: { availableAt: new Date(Date.now() - 1000) },
    });
    await ServerlessJobProcessor.processBackgroundJobs(20);
  };
  const jobFor = (messageId: string) =>
    prisma.backgroundJob.findFirst({ where: { clientId: tenantId, type: "WHATSAPP_MESSAGE", payload: { contains: messageId } } });

  try {
    // -------------------------------------------------------------------------
    console.log("\n▶ [Test 1] Transient Meta failure schedules a retry...");
    metaMode = "TRANSIENT_503";
    metaCalls = 0;
    const transient = await MessageService.send({ to: "919800000001", type: "text", body: "Retry me" } as never, { clientId: tenantId });
    const transientRow = await prisma.message.findUnique({ where: { id: transient.id } });
    const transientJob = await jobFor(transient.id);
    assert(transient.status === MessageStatus.QUEUED, `Send result is QUEUED, not FAILED (actual: ${transient.status})`);
    assert(transientRow?.status === MessageStatus.QUEUED && transientRow?.lockedBy === null, "Message stays QUEUED with its lock released");
    assert(transientRow?.attemptCount === 1, `First attempt recorded (attemptCount: ${transientRow?.attemptCount})`);
    assert(transientJob?.status === BackgroundJobStatus.QUEUED, "Durable WHATSAPP_MESSAGE retry job created");
    assert(metaCalls === 1, `Meta called once (calls: ${metaCalls})`);

    // -------------------------------------------------------------------------
    console.log("\n▶ [Test 2] Processor retries and delivers...");
    metaMode = "OK";
    await runJobs(transient.id);
    const retriedRow = await prisma.message.findUnique({ where: { id: transient.id } });
    const retriedJob = await jobFor(transient.id);
    assert(retriedRow?.status === MessageStatus.SENT && Boolean(retriedRow?.providerMessageId), `Message SENT after retry (actual: ${retriedRow?.status})`);
    assert(retriedRow?.attemptCount === 2 && retriedRow?.lockedBy === null, "Second attempt recorded and lock cleared");
    assert(retriedJob?.status === BackgroundJobStatus.COMPLETED, `Retry job COMPLETED (actual: ${retriedJob?.status})`);
    assert(metaCalls === 2, `Exactly one additional Meta call (calls: ${metaCalls})`);

    // -------------------------------------------------------------------------
    console.log("\n▶ [Test 3] Permanent rejection fails immediately...");
    metaMode = "PERMANENT_400";
    const permanent = await MessageService.send({ to: "919800000002", type: "text", body: "Rejected" } as never, { clientId: tenantId });
    const permanentJob = await jobFor(permanent.id);
    assert(permanent.status === MessageStatus.FAILED, `Permanent rejection is FAILED (actual: ${permanent.status})`);
    assert(permanentJob === null, "No retry job for a permanent rejection");

    // -------------------------------------------------------------------------
    console.log("\n▶ [Test 4] Retries stop at the attempt limit...");
    metaMode = "TRANSIENT_503";
    const exhausted = await prisma.message.create({
      data: {
        clientId: tenantId,
        direction: MessageDirection.OUTBOUND,
        type: MessageType.TEXT,
        status: MessageStatus.QUEUED,
        from: "system",
        to: "919800000003",
        body: "Last attempt",
        attemptCount: 4,
      },
    });
    await prisma.backgroundJob.create({
      data: { clientId: tenantId, type: "WHATSAPP_MESSAGE", payload: JSON.stringify({ messageId: exhausted.id, clientId: tenantId }) },
    });
    await runJobs(exhausted.id);
    const exhaustedRow = await prisma.message.findUnique({ where: { id: exhausted.id } });
    const exhaustedJob = await jobFor(exhausted.id);
    assert(exhaustedRow?.status === MessageStatus.FAILED && exhaustedRow?.attemptCount === 5, `Fifth failed attempt is final (actual: ${exhaustedRow?.status}/${exhaustedRow?.attemptCount})`);
    assert(exhaustedJob?.status === BackgroundJobStatus.FAILED, `Job FAILED, not re-queued (actual: ${exhaustedJob?.status})`);

    // -------------------------------------------------------------------------
    console.log("\n▶ [Test 5] Crashed mid-send message is flagged, not re-sent...");
    metaMode = "OK";
    const inFlight = await prisma.message.create({
      data: {
        clientId: tenantId,
        direction: MessageDirection.OUTBOUND,
        type: MessageType.TEXT,
        status: MessageStatus.QUEUED,
        from: "system",
        to: "919800000004",
        body: "Maybe delivered",
        attemptCount: 1,
        lockedBy: `crashed-worker${SEND_IN_FLIGHT_SUFFIX}`,
        lockedAt: new Date(Date.now() - 15 * 60 * 1000),
      },
    });
    await prisma.backgroundJob.create({
      data: { clientId: tenantId, type: "WHATSAPP_MESSAGE", payload: JSON.stringify({ messageId: inFlight.id, clientId: tenantId }) },
    });
    const callsBefore = metaCalls;
    await runJobs(inFlight.id);
    assert(metaCalls === callsBefore, "In-flight message is not re-sent by the processor");
    await ReconciliationExecutor.reconcile({ staleMinutes: 10 });
    const inFlightRow = await prisma.message.findUnique({ where: { id: inFlight.id } });
    assert(
      inFlightRow?.status === MessageStatus.FAILED && inFlightRow?.errorCode === SEND_OUTCOME_UNKNOWN,
      `Reconciliation flags it ${SEND_OUTCOME_UNKNOWN} (actual: ${inFlightRow?.status}/${inFlightRow?.errorCode})`
    );

    // -------------------------------------------------------------------------
    console.log("\n▶ [Test 6] Retry job for an already-sent message is a no-op...");
    await prisma.backgroundJob.create({
      data: { clientId: tenantId, type: "WHATSAPP_MESSAGE", payload: JSON.stringify({ messageId: transient.id, clientId: tenantId, replay: true }) },
    });
    const callsBeforeReplay = metaCalls;
    await runJobs(transient.id);
    assert(metaCalls === callsBeforeReplay, "Already-sent message is not sent again");
  } finally {
    globalThis.fetch = originalFetch;
    await prisma.backgroundJob.deleteMany({ where: { clientId: tenantId } });
    await prisma.message.deleteMany({ where: { clientId: tenantId } });
    await prisma.apiClient.deleteMany({ where: { id: tenantId } });
    await prisma.$disconnect();
  }

  console.log("\n===============================================================================");
  if (failed === 0) {
    console.log(`🎉 ALL ${passed} WHATSAPP RETRY TESTS PASSED!`);
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
