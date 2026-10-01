import { NextRequest, NextResponse } from "next/server";
import { authenticateEmailApi } from "@/lib/email/api-auth-helper";
import { EmailAudienceResolver } from "@/lib/services/email-audience-resolver";
import { EmailType } from "@prisma/client";

export async function POST(req: NextRequest) {
  // Read-only preview evaluation permitted for VIEWER and ADMIN
  const auth = await authenticateEmailApi(req, { requireAdminForMutations: false });
  if (!auth.authorized || !auth.clientId) return auth.errorResponse!;

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    // Body is optional
  }

  const listId = typeof body.listId === "string" ? body.listId : null;
  const segmentId = typeof body.segmentId === "string" ? body.segmentId : null;
  const criteria = body.criteria || null;
  const campaignType =
    body.type === EmailType.TRANSACTIONAL ? EmailType.TRANSACTIONAL : EmailType.PROMOTIONAL;

  try {
    const preview = await EmailAudienceResolver.resolvePreview(auth.clientId, {
      listId,
      segmentId,
      criteria,
      type: campaignType,
    });

    return NextResponse.json({
      success: true,
      data: {
        totalAudience: preview.totalAudience,
        eligibleCount: preview.eligibleCount,
        suppressedCount: preview.suppressedCount,
        unsubscribedCount: preview.unsubscribedCount,
        invalidCount: preview.invalidCount,
        breakdown: preview.breakdown,
        explainSummary: preview.explainSummary,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error generating audience preview";
    return NextResponse.json(
      { success: false, error: { code: "BAD_REQUEST", message: msg } },
      { status: 400 }
    );
  }
}
