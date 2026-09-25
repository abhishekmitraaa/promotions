import { NextRequest, NextResponse } from "next/server";
import { authenticateEmailApi } from "@/lib/email/api-auth-helper";
import { EmailCampaignService } from "@/lib/services/email-campaign-service";
import { checkRateLimit } from "@/lib/rate-limit";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  // Mutation: strictly ADMIN only (VIEWER denied)
  const auth = await authenticateEmailApi(req, { requireAdminForMutations: true });
  if (!auth.authorized || !auth.clientId) return auth.errorResponse!;

  const rl = await checkRateLimit(`test_email_${auth.clientId}`, 10, 60000);
  if (!rl.success) {
    return NextResponse.json(
      {
        success: false,
        error: {
          code: "RATE_LIMITED",
          message: "Too many test email requests. Rate limit exceeded.",
        },
      },
      { status: 429, headers: { "Retry-After": String(rl.resetSeconds) } }
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

  if (!body.testEmail || typeof body.testEmail !== "string") {
    return NextResponse.json(
      { success: false, error: { code: "VALIDATION_ERROR", message: "'testEmail' is required" } },
      { status: 400 }
    );
  }

  const customVariables =
    typeof body.customVariables === "object" && body.customVariables !== null
      ? (body.customVariables as Record<string, unknown>)
      : {};

  try {
    const result = await EmailCampaignService.sendTestEmail(
      auth.clientId,
      id,
      body.testEmail,
      customVariables
    );

    return NextResponse.json({ success: true, data: result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to send test email";
    return NextResponse.json(
      { success: false, error: { code: "BAD_REQUEST", message: msg } },
      { status: 400 }
    );
  }
}
