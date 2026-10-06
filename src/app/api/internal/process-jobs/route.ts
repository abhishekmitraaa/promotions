import { NextRequest, NextResponse } from "next/server";
import { ServerlessJobProcessor } from "@/lib/services/serverless-job-processor";
import { logger } from "@/lib/logger";
import { requireUser } from "@/lib/auth";
import { timingSafeEqualSecret } from "@/lib/timing-safe";

async function handleProcessingRequest(req: NextRequest) {
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
    const runReconciliation = searchParams.get("reconcile") === "true";

    const result = await ServerlessJobProcessor.processAll({
      runReconciliation,
    });

    return NextResponse.json({
      success: true,
      data: result,
    });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : "Error during serverless job processing";
    logger.error("[API:ProcessJobs] Error during execution:", err);
    return NextResponse.json(
      { success: false, error: errorMsg },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  return handleProcessingRequest(req);
}

export async function GET(req: NextRequest) {
  return handleProcessingRequest(req);
}
