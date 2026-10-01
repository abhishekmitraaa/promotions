import { NextRequest, NextResponse } from "next/server";
import { authenticateEmailApi } from "@/lib/email/api-auth-helper";
import { EmailSegmentService } from "@/lib/services/email-segment-service";
import { EmailAudienceResolver } from "@/lib/services/email-audience-resolver";
import { EmailType } from "@prisma/client";

export async function POST(req: NextRequest) {
  // Evaluates ad-hoc criteria preview for rule builder with explainable counts
  const auth = await authenticateEmailApi(req, { requireAdminForMutations: false });
  if (!auth.authorized || !auth.clientId) return auth.errorResponse!;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { success: false, error: { code: "BAD_REQUEST", message: "Invalid JSON body" } },
      { status: 400 }
    );
  }

  if (!body.criteria) {
    return NextResponse.json(
      { success: false, error: { code: "VALIDATION_ERROR", message: "Segment 'criteria' is required" } },
      { status: 400 }
    );
  }

  try {
    const limit = typeof body.limit === "number" ? body.limit : 20;
    const campaignType =
      body.type === EmailType.TRANSACTIONAL ? EmailType.TRANSACTIONAL : EmailType.PROMOTIONAL;

    const [sampleResult, explainableResult] = await Promise.all([
      EmailSegmentService.previewContacts(auth.clientId, body.criteria, { limit }),
      EmailAudienceResolver.resolvePreview(auth.clientId, {
        criteria: body.criteria,
        type: campaignType,
      }),
    ]);

    return NextResponse.json({
      success: true,
      data: {
        totalMatching: sampleResult.matchingCount,
        matchingCount: sampleResult.matchingCount,
        totalAudience: explainableResult.totalAudience,
        eligibleCount: explainableResult.eligibleCount,
        suppressedCount: explainableResult.suppressedCount,
        unsubscribedCount: explainableResult.unsubscribedCount,
        invalidCount: explainableResult.invalidCount,
        breakdown: explainableResult.breakdown,
        explainSummary: explainableResult.explainSummary,
        contacts: sampleResult.sampleContacts,
        sampleContacts: sampleResult.sampleContacts,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error previewing segment";
    return NextResponse.json(
      { success: false, error: { code: "BAD_REQUEST", message: msg } },
      { status: 400 }
    );
  }
}
