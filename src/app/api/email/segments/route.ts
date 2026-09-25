import { NextRequest, NextResponse } from "next/server";
import { authenticateEmailApi } from "@/lib/email/api-auth-helper";
import { EmailSegmentService } from "@/lib/services/email-segment-service";

export async function GET(req: NextRequest) {
  // Read-only: permitted for VIEWER and ADMIN
  const auth = await authenticateEmailApi(req, { requireAdminForMutations: false });
  if (!auth.authorized || !auth.clientId) return auth.errorResponse!;

  try {
    const segments = await EmailSegmentService.listSegments(auth.clientId);
    return NextResponse.json({ success: true, data: segments });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to list segments";
    return NextResponse.json(
      { success: false, error: { code: "SERVER_ERROR", message: msg } },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  // Mutation: strictly ADMIN only (VIEWER denied)
  const auth = await authenticateEmailApi(req, { requireAdminForMutations: true });
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

  if (!body.name || typeof body.name !== "string") {
    return NextResponse.json(
      { success: false, error: { code: "VALIDATION_ERROR", message: "Segment 'name' is required" } },
      { status: 400 }
    );
  }

  if (!body.criteria) {
    return NextResponse.json(
      { success: false, error: { code: "VALIDATION_ERROR", message: "Segment 'criteria' object is required" } },
      { status: 400 }
    );
  }

  try {
    const segment = await EmailSegmentService.createSegment(
      auth.clientId,
      body.name,
      body.criteria,
      typeof body.description === "string" ? body.description : null
    );

    return NextResponse.json({ success: true, data: segment }, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to create segment";
    const status = msg.includes("already exists") ? 409 : 400;
    return NextResponse.json(
      { success: false, error: { code: status === 409 ? "CONFLICT" : "BAD_REQUEST", message: msg } },
      { status }
    );
  }
}
