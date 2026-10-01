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

  try {
    const activated = await EmailAutomationService.activateAutomation(auth.clientId, id);

    EmailAuditLogger.log(
      auth.clientId,
      auth.role || "ADMIN",
      "AUTOMATION_ACTIVATED",
      activated.id,
      { name: activated.name, nextRunAt: activated.nextRunAt }
    );

    return NextResponse.json({ success: true, data: activated });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to activate automation";
    return NextResponse.json(
      { success: false, error: { code: "VALIDATION_ERROR", message: msg } },
      { status: 400 }
    );
  }
}
