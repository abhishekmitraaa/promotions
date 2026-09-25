import { NextRequest, NextResponse } from "next/server";
import { authenticateEmailApi } from "@/lib/email/api-auth-helper";
import { EmailTemplateService } from "@/lib/services/email-template-service";
import { EmailTemplateType } from "@prisma/client";

export async function GET(req: NextRequest) {
  // Read-only: permitted for VIEWER and ADMIN
  const auth = await authenticateEmailApi(req, { requireAdminForMutations: false });
  if (!auth.authorized || !auth.clientId) return auth.errorResponse!;

  try {
    const { searchParams } = new URL(req.url);
    const type = (searchParams.get("type") as EmailTemplateType) || undefined;

    const templates = await EmailTemplateService.listTemplates(auth.clientId, { type });
    return NextResponse.json({ success: true, data: templates });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to list templates";
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
      { success: false, error: { code: "VALIDATION_ERROR", message: "Template 'name' is required" } },
      { status: 400 }
    );
  }

  if (!body.subject || typeof body.subject !== "string") {
    return NextResponse.json(
      { success: false, error: { code: "VALIDATION_ERROR", message: "Template 'subject' is required" } },
      { status: 400 }
    );
  }

  if (!body.htmlContent || typeof body.htmlContent !== "string") {
    return NextResponse.json(
      { success: false, error: { code: "VALIDATION_ERROR", message: "Template 'htmlContent' is required" } },
      { status: 400 }
    );
  }

  try {
    const template = await EmailTemplateService.createTemplate(auth.clientId, {
      name: body.name,
      description: typeof body.description === "string" ? body.description : null,
      type: typeof body.type === "string" ? (body.type as EmailTemplateType) : undefined,
      subject: body.subject,
      htmlContent: body.htmlContent,
      textContent: typeof body.textContent === "string" ? body.textContent : null,
      variableSchema: body.variableSchema,
    });

    return NextResponse.json({ success: true, data: template }, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to create template";
    const status = msg.includes("already exists") ? 409 : 400;
    return NextResponse.json(
      { success: false, error: { code: status === 409 ? "CONFLICT" : "BAD_REQUEST", message: msg } },
      { status }
    );
  }
}
