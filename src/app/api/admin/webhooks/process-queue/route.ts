import { NextRequest, NextResponse } from "next/server";
import { processWebhookDeliveryQueue } from "@/lib/webhooks/dispatcher";
import { logger } from "@/lib/logger";
import { requireUser } from "@/lib/auth";
import { timingSafeEqualSecret } from "@/lib/timing-safe";

async function handleProcessQueue(req: NextRequest) {
  const workerSecret = req.headers.get("x-worker-secret");
  const authHeader = req.headers.get("authorization");
  const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.substring(7) : null;

  const configuredWorkerSecret = process.env.INTERNAL_WORKER_SECRET;
  const configuredCronSecret = process.env.CRON_SECRET;

  const isWorkerAuthorized = await timingSafeEqualSecret(workerSecret, configuredWorkerSecret);
  const isBearerAuthorized =
    (Boolean(bearerToken && configuredWorkerSecret) && (await timingSafeEqualSecret(bearerToken, configuredWorkerSecret))) ||
    (Boolean(bearerToken && configuredCronSecret) && (await timingSafeEqualSecret(bearerToken, configuredCronSecret)));

  if (!isWorkerAuthorized && !isBearerAuthorized) {
    const auth = await requireUser(req, "ADMIN");
    if (auth.response) return auth.response;
  }

  try {
    const { searchParams } = new URL(req.url);
    const batchSize = Math.min(
      Math.max(parseInt(searchParams.get("batchSize") || "10", 10), 1),
      50
    );

    const result = await processWebhookDeliveryQueue({ batchSize });

    return NextResponse.json({
      success: true,
      data: result,
    });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : "Error processing webhook queue";
    logger.error("Error in webhook process-queue route:", err);
    return NextResponse.json(
      { success: false, error: errorMsg },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  return handleProcessQueue(req);
}

export async function GET(req: NextRequest) {
  return handleProcessQueue(req);
}
