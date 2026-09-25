import { NextRequest, NextResponse } from "next/server";
import { authenticateEmailApi } from "@/lib/email/api-auth-helper";
import { EmailTemplateService } from "@/lib/services/email-template-service";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const auth = await authenticateEmailApi(req, { requireAdminForMutations: false });
  if (!auth.authorized || !auth.clientId) return auth.errorResponse!;

  try {
    const template = await EmailTemplateService.getTemplateById(auth.clientId, id);
    if (!template) {
      return NextResponse.json(
        { success: false, error: { code: "NOT_FOUND", message: `Template '${id}' not found` } },
        { status: 404 }
      );
    }
    return NextResponse.json({ success: true, data: template });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error retrieving template";
    return NextResponse.json(
      { success: false, error: { code: "SERVER_ERROR", message: msg } },
      { status: 500 }
    );
  }
}

export async function DELETE(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  // Mutation: strictly ADMIN only (VIEWER denied)
  const auth = await authenticateEmailApi(req, { requireAdminForMutations: true });
  if (!auth.authorized || !auth.clientId) return auth.errorResponse!;

  try {
    const result = await EmailTemplateService.deleteTemplate(auth.clientId, id);
    return NextResponse.json({ success: true, data: result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to delete template";
    const status = msg.includes("not found") ? 404 : 400;
    return NextResponse.json(
      { success: false, error: { code: status === 404 ? "NOT_FOUND" : "BAD_REQUEST", message: msg } },
      { status }
    );
  }
}
