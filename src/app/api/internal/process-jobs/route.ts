import { NextRequest, NextResponse } from "next/server";
import { ServerlessJobProcessor } from "@/lib/services/serverless-job-processor";
import { logger } from "@/lib/logger";
import { timingSafeEqualSecret } from "@/lib/timing-safe";

/**
 * Machine-to-Machine Internal Job Processing Endpoint
 *
 * Triggered exclusively by Supabase Cron via pg_net HTTP POST.
 * Requires dedicated INTERNAL_PROCESSOR_SECRET provided via Bearer Authorization header
 * or x-processor-secret header.
 *
 * Fails closed in production if secret is unconfigured or mismatch occurs.
 * Never allows processing on GET requests (returns HTTP 405).
 */
export async function POST(req: NextRequest) {
  const configuredSecret = process.env.INTERNAL_PROCESSOR_SECRET;

  if (!configuredSecret || configuredSecret.trim().length === 0) {
    logger.error("[API:ProcessJobs] INTERNAL_PROCESSOR_SECRET is not configured on server.");
    return NextResponse.json(
      { success: false, error: "Server authentication misconfigured" },
      { status: 500 }
    );
  }

  const authHeader = req.headers.get("authorization");
  const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.substring(7).trim() : null;
  const headerSecret = req.headers.get("x-processor-secret")?.trim() || req.headers.get("x-worker-secret")?.trim();
  const candidateSecret = bearerToken || headerSecret;

  if (!candidateSecret) {
    return NextResponse.json(
      { success: false, error: "Missing authorization credential" },
      { status: 401 }
    );
  }

  const isAuthorized = await timingSafeEqualSecret(candidateSecret, configuredSecret);
  if (!isAuthorized) {
    logger.warn("[API:ProcessJobs] Unauthorized invocation attempt with invalid secret.");
    return NextResponse.json(
      { success: false, error: "Invalid authorization credential" },
      { status: 403 }
    );
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

/**
 * GET is strictly non-destructive and rejected with 405 Method Not Allowed.
 */
export async function GET() {
  return NextResponse.json(
    {
      success: false,
      error: "Method Not Allowed. Job processing cannot be triggered via GET.",
    },
    { status: 405 }
  );
}
