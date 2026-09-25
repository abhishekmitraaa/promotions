import { NextRequest, NextResponse } from "next/server";
import { authenticateEmailApi } from "@/lib/email/api-auth-helper";
import { EmailTemplateService } from "@/lib/services/email-template-service";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
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

  if (!body.subject || typeof body.subject !== "string") {
    return NextResponse.json(
      { success: false, error: { code: "VALIDATION_ERROR", message: "Version 'subject' is required" } },
      { status: 400 }
    );
  }

  if (!body.htmlContent || typeof body.htmlContent !== "string") {
    return NextResponse.json(
      { success: false, error: { code: "VALIDATION_ERROR", message: "Version 'htmlContent' is required" } },
      { status: 400 }
    );
  }

  try {
    const version = await EmailTemplateService.createVersion(auth.clientId, id, {
      subject: body.subject,
      htmlContent: body.htmlContent,
      textContent: typeof body.textContent === "string" ? body.textContent : null,
      variableSchema: body.variableSchema,
    });

    return NextResponse.json({ success: true, data: version }, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to create template version";
    const status = msg.includes("not found") ? 404 : 400;
    return NextResponse.json(
      { success: false, error: { code: status === 404 ? "NOT_FOUND" : "BAD_REQUEST", message: msg } },
      { status }
    );
  }
}
