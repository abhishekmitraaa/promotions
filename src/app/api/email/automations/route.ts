import { NextRequest, NextResponse } from "next/server";
import { authenticateEmailApi } from "@/lib/email/api-auth-helper";
import { EmailAutomationService } from "@/lib/services/email-automation-service";
import { EmailAutomationStatus, EmailAutomationTriggerType, AudienceReEvaluationPolicy } from "@prisma/client";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { EmailAuditLogger } from "@/lib/email/audit-logger";

export async function GET(req: NextRequest) {
  const auth = await authenticateEmailApi(req, { requireAdminForMutations: false });
  if (!auth.authorized || !auth.clientId) return auth.errorResponse!;

  try {
    const { searchParams } = new URL(req.url);
    const status = (searchParams.get("status") as EmailAutomationStatus) || undefined;

    const automations = await EmailAutomationService.listAutomations(auth.clientId, { status });
    return NextResponse.json({ success: true, data: automations });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to list automations";
    return NextResponse.json(
      { success: false, error: { code: "SERVER_ERROR", message: msg } },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  const auth = await authenticateEmailApi(req, { requireAdminForMutations: true });
  if (!auth.authorized || !auth.clientId) return auth.errorResponse!;

  const rl = await checkRateLimit(`create_auto_${auth.clientId}`, 20, 60000, {
    criticality: "HIGH",
    syncToDb: true,
  });
  if (!rl.success) {
    return rateLimitResponse(rl, "Too many automation creation requests. Please wait.");
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

  if (!body.name || typeof body.name !== "string" || !body.name.trim()) {
    return NextResponse.json(
      { success: false, error: { code: "VALIDATION_ERROR", message: "Automation 'name' is required" } },
      { status: 400 }
    );
  }

  if (!body.steps || !Array.isArray(body.steps) || body.steps.length === 0) {
    return NextResponse.json(
      { success: false, error: { code: "VALIDATION_ERROR", message: "'steps' must be a non-empty array" } },
      { status: 400 }
    );
  }

  try {
    const automation = await EmailAutomationService.createAutomation(auth.clientId, {
      name: body.name.trim(),
      description: typeof body.description === "string" ? body.description.trim() : null,
      triggerType: (body.triggerType as EmailAutomationTriggerType) || EmailAutomationTriggerType.MANUAL,
      triggerConfig: body.triggerConfig as any,
      reEvaluationPolicy: (body.reEvaluationPolicy as AudienceReEvaluationPolicy) || AudienceReEvaluationPolicy.ALWAYS_RE_EVALUATE,
      steps: body.steps as any,
    });

    EmailAuditLogger.log(
      auth.clientId,
      auth.role || "ADMIN",
      "AUTOMATION_CREATED",
      automation.id,
      { name: automation.name, triggerType: automation.triggerType }
    );

    return NextResponse.json({ success: true, data: automation }, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to create automation";
    return NextResponse.json(
      { success: false, error: { code: "VALIDATION_ERROR", message: msg } },
      { status: 400 }
    );
  }
}
