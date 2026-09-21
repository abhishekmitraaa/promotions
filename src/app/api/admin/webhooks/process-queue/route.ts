import { NextRequest, NextResponse } from "next/server";
import { processWebhookDeliveryQueue } from "@/lib/webhooks/dispatcher";
import { logger } from "@/lib/logger";
import { requireUser } from "@/lib/auth";

export async function POST(req: NextRequest) {
  const workerSecret = req.headers.get("x-worker-secret");
  const isWorkerAuthorized =
    Boolean(workerSecret && process.env.INTERNAL_WORKER_SECRET && workerSecret === process.env.INTERNAL_WORKER_SECRET);

  if (!isWorkerAuthorized) {
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
