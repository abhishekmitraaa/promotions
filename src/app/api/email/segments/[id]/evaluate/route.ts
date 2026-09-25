import { NextRequest, NextResponse } from "next/server";
import { authenticateEmailApi } from "@/lib/email/api-auth-helper";
import { EmailSegmentService } from "@/lib/services/email-segment-service";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const auth = await authenticateEmailApi(req, { requireAdminForMutations: false });
  if (!auth.authorized || !auth.clientId) return auth.errorResponse!;

  try {
    const segment = await EmailSegmentService.getSegmentById(auth.clientId, id);
    if (!segment) {
      return NextResponse.json(
        { success: false, error: { code: "NOT_FOUND", message: `Segment '${id}' not found` } },
        { status: 404 }
      );
    }

    const criteria = JSON.parse(segment.criteria);
    const { searchParams } = new URL(req.url);
    const limit = parseInt(searchParams.get("limit") || "20", 10);

    const result = await EmailSegmentService.previewContacts(auth.clientId, criteria, { limit });
    return NextResponse.json({ success: true, data: result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error evaluating segment";
    return NextResponse.json(
      { success: false, error: { code: "SERVER_ERROR", message: msg } },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  // Evaluates ad-hoc criteria preview
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
    return NextResponse.json({ success: true, data: result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error previewing segment";
    return NextResponse.json(
      { success: false, error: { code: "BAD_REQUEST", message: msg } },
      { status: 400 }
    );
  }
}
