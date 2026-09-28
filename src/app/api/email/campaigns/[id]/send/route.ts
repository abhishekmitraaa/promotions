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

  // Tenant limit: 10 campaign sends or schedules per minute
  const tenantLimit = await checkRateLimit(
    `rl:tenant:${auth.clientId}:campaign_send`,
    10,
    60000,
    { criticality: "HIGH", syncToDb: true }
  );
  if (!tenantLimit.success) {
    return rateLimitResponse(
      tenantLimit,
      "Too many campaign dispatch or schedule requests for this tenant. Please wait."
    );
  }

  // IP limit: 20 per minute
  const ipLimit = await checkRateLimit(
    `rl:ip:${clientIp}:campaign_send`,
    20,
    60000,
    { criticality: "HIGH" }
  );
  if (!ipLimit.success) {
    return rateLimitResponse(
      ipLimit,
      "Too many campaign dispatch requests from this IP address."
    );
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    // Body optional (if send now)
  }

  try {
    if (body.scheduledAt && typeof body.scheduledAt === "string") {
      const scheduledDate = new Date(body.scheduledAt);
      const scheduled = await EmailCampaignService.scheduleCampaign(auth.clientId, id, scheduledDate);
      return NextResponse.json({ success: true, data: scheduled });
    }

    const result = await EmailCampaignService.sendCampaignNow(auth.clientId, id);
    return NextResponse.json({ success: true, data: result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to initiate campaign send";
    const status = msg.includes("not found") ? 404 : (msg.includes("Failed to enqueue") ? 500 : 400);
    const code = status === 404 ? "NOT_FOUND" : (status === 500 ? "QUEUE_ERROR" : "BAD_REQUEST");
    return NextResponse.json(
      { success: false, error: { code, message: msg } },
      { status }
    );
  }
}
