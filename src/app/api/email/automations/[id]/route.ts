import { NextRequest, NextResponse } from "next/server";
import { authenticateEmailApi } from "@/lib/email/api-auth-helper";
import { EmailAutomationService, UpdateAutomationInput } from "@/lib/services/email-automation-service";
import { EmailAuditLogger } from "@/lib/email/audit-logger";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(req: NextRequest, { params }: RouteParams) {
  const auth = await authenticateEmailApi(req, { requireAdminForMutations: false });
  if (!auth.authorized || !auth.clientId) return auth.errorResponse!;

  const { id } = await params;
  if (!id) {
    return NextResponse.json(
      { success: false, error: { code: "BAD_REQUEST", message: "Automation ID is required" } },
      { status: 400 }
    );
  }

  try {
    const automation = await EmailAutomationService.getAutomationById(auth.clientId, id);
    if (!automation) {
      return NextResponse.json(
        { success: false, error: { code: "NOT_FOUND", message: `Automation '${id}' not found` } },
        { status: 404 }
      );
    }

    return NextResponse.json({ success: true, data: automation });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to fetch automation";
    return NextResponse.json(
      { success: false, error: { code: "SERVER_ERROR", message: msg } },
      { status: 500 }
    );
  }
}

export async function PATCH(req: NextRequest, { params }: RouteParams) {
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
    const updated = await EmailAutomationService.updateAutomation(
      auth.clientId,
      id,
      body as unknown as UpdateAutomationInput
    );

    EmailAuditLogger.log(
      auth.clientId,
      auth.role || "ADMIN",
      "AUTOMATION_UPDATED",
      updated.id,
      body
    );

    return NextResponse.json({ success: true, data: updated });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to update automation";
    return NextResponse.json(
      { success: false, error: { code: "VALIDATION_ERROR", message: msg } },
      { status: 400 }
    );
  }
}

export async function DELETE(req: NextRequest, { params }: RouteParams) {
  const auth = await authenticateEmailApi(req, { requireAdminForMutations: true });
  if (!auth.authorized || !auth.clientId) return auth.errorResponse!;

  const { id } = await params;
  if (!id) {
    return NextResponse.json(
      { success: false, error: { code: "BAD_REQUEST", message: "Automation ID is required" } },
      { status: 400 }
    );
  }

  try {
    const result = await EmailAutomationService.deleteAutomation(auth.clientId, id);

    EmailAuditLogger.log(
      auth.clientId,
      auth.role || "ADMIN",
      "AUTOMATION_DELETED",
      id
    );

    return NextResponse.json({ success: true, data: result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to delete automation";
    return NextResponse.json(
      { success: false, error: { code: "SERVER_ERROR", message: msg } },
      { status: 500 }
    );
  }
}
