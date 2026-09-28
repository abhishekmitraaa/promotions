import { NextRequest, NextResponse } from "next/server";
import { authenticateEmailApi } from "@/lib/email/api-auth-helper";
import { EmailCampaignService } from "@/lib/services/email-campaign-service";
import { checkRateLimit, getClientIp, rateLimitResponse } from "@/lib/rate-limit";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  // Mutation: strictly ADMIN only (VIEWER denied)
  const auth = await authenticateEmailApi(req, { requireAdminForMutations: true });
  if (!auth.authorized || !auth.clientId) return auth.errorResponse!;

  const clientIp = getClientIp(req);

  // Tenant limit: 10 test sends per minute
  const rl = await checkRateLimit(`test_email_${auth.clientId}`, 10, 60000, {
    criticality: "HIGH",
    syncToDb: true,
  });
  if (!rl.success) {
    return rateLimitResponse(
      rl,
      "Too many test email requests for this tenant. Rate limit exceeded."
    );
  }

  // IP limit: 15 test sends per minute per IP
  const ipRl = await checkRateLimit(`rl:ip:${clientIp}:campaign_test_send`, 15, 60000, {
    criticality: "HIGH",
  });
  if (!ipRl.success) {
    return rateLimitResponse(
      ipRl,
      "Too many test email requests from this IP address.",
      "IP_RATE_LIMITED"
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

  // Per-recipient test send abuse protection: 5 test emails per minute to same address
  const normalizedTestEmail = body.testEmail.trim().toLowerCase();
  const rcptRl = await checkRateLimit(
    `rl:rcpt:${auth.clientId}:${normalizedTestEmail}:campaign_test_send`,
    5,
    60000,
    { criticality: "HIGH" }
  );
  if (!rcptRl.success) {
    return rateLimitResponse(
      rcptRl,
      `Too many test emails sent to '${body.testEmail}'. Please wait before sending more test emails to this address.`,
      "RECIPIENT_RATE_LIMITED"
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
