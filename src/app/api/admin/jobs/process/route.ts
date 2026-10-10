import { NextRequest, NextResponse } from "next/server";
import { ServerlessJobProcessor } from "@/lib/services/serverless-job-processor";
import { requireUser } from "@/lib/auth";
import { logger } from "@/lib/logger";

/**
 * Admin-Only Manual Job Processing Route
 *
 * Allows authenticated administrators to manually trigger job execution and reconciliation cycles.
 */
export async function POST(req: NextRequest) {
  const auth = await requireUser(req, "ADMIN");
  if (auth.response) return auth.response;

  try {
    const { searchParams } = new URL(req.url);
    const runReconciliation = searchParams.get("reconcile") === "true";

    const result = await ServerlessJobProcessor.processAll({
      runReconciliation,
    });

    return NextResponse.json({
      success: true,
      data: result,
      triggeredBy: auth.user.email,
    });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : "Error during manual admin job processing";
    logger.error("[API:AdminProcessJobs] Error during execution:", err);
    return NextResponse.json(
      { success: false, error: errorMsg },
      { status: 500 }
    );
  }
}
