import { NextRequest, NextResponse } from "next/server";
import { processWebhookDeliveryQueue } from "@/lib/webhooks/dispatcher";
import { logger } from "@/lib/logger";

export async function POST(req: NextRequest) {
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

export async function GET(req: NextRequest) {
  return POST(req);
}
