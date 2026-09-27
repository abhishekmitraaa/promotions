import { NextRequest, NextResponse } from "next/server";
import { authenticateEmailApi } from "@/lib/email/api-auth-helper";
import { EmailSegmentService } from "@/lib/services/email-segment-service";

export async function POST(req: NextRequest) {
  // Evaluates ad-hoc criteria preview for rule builder
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
    const result = await EmailSegmentService.previewContacts(auth.clientId, body.criteria, { limit });
    return NextResponse.json({
      success: true,
      data: {
        totalMatching: result.matchingCount,
        matchingCount: result.matchingCount,
        contacts: result.sampleContacts,
        sampleContacts: result.sampleContacts,
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
