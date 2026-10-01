import { NextRequest, NextResponse } from "next/server";
import { authenticateEmailApi } from "@/lib/email/api-auth-helper";
import { EmailAutomationService } from "@/lib/services/email-automation-service";
import { EmailAuditLogger } from "@/lib/email/audit-logger";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, { params }: RouteParams) {
  const auth = await authenticateEmailApi(req, { requireAdminForMutations: true });
  if (!auth.authorized || !auth.clientId) return auth.errorResponse!;

  const { id } = await params;
  if (!id) {
    return NextResponse.json(
      { success: false, error: { code: "BAD_REQUEST", message: "Automation ID is required" } },
      { status: 400 }
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { success: false, error: { code: "BAD_REQUEST", message: "Invalid JSON body" } },
      { status: 400 }
    );
  }

  try {
    // Mode 1: Single contact enrollment
    if (body.contactId && typeof body.contactId === "string") {
      const enrollment = await EmailAutomationService.enrollContact(
        auth.clientId,
        id,
        body.contactId,
        (body.contextData as Record<string, unknown>) || {}
      );

      EmailAuditLogger.log(
        auth.clientId,
        auth.role || "ADMIN",
        "AUTOMATION_ENROLLED",
        id,
        { contactId: body.contactId, enrollmentId: enrollment.id, status: enrollment.status }
      );

      return NextResponse.json({ success: true, data: enrollment }, { status: 201 });
    }

    // Mode 2: Audience enrollment (segment or list)
    const segmentId = typeof body.segmentId === "string" ? body.segmentId : undefined;
    const listId = typeof body.listId === "string" ? body.listId : undefined;

    const result = await EmailAutomationService.enrollAudience(auth.clientId, id, {
      segmentId,
      listId,
    });

    EmailAuditLogger.log(
      auth.clientId,
      auth.role || "ADMIN",
      "AUTOMATION_ENROLLED",
      id,
      result
    );

    return NextResponse.json({ success: true, data: result }, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to enroll in automation";
    return NextResponse.json(
      { success: false, error: { code: "VALIDATION_ERROR", message: msg } },
      { status: 400 }
    );
  }
}
