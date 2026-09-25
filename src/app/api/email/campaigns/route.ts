import { NextRequest, NextResponse } from "next/server";
import { authenticateEmailApi } from "@/lib/email/api-auth-helper";
import { EmailCampaignService } from "@/lib/services/email-campaign-service";
import { EmailCampaignStatus, EmailType } from "@prisma/client";
import { checkRateLimit } from "@/lib/rate-limit";
import { EmailAuditLogger } from "@/lib/email/audit-logger";

export async function GET(req: NextRequest) {
  // Read-only: permitted for VIEWER and ADMIN
  const auth = await authenticateEmailApi(req, { requireAdminForMutations: false });
  if (!auth.authorized || !auth.clientId) return auth.errorResponse!;

  try {
    const { searchParams } = new URL(req.url);
    const status = (searchParams.get("status") as EmailCampaignStatus) || undefined;

    const campaigns = await EmailCampaignService.listCampaigns(auth.clientId, { status });
    return NextResponse.json({ success: true, data: campaigns });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to list campaigns";
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

  const rl = await checkRateLimit(`create_cmp_${auth.clientId}`, 20, 60000);
  if (!rl.success) {
    return NextResponse.json(
      {
        success: false,
        error: {
          code: "RATE_LIMITED",
          message: "Too many campaign creation requests. Please wait.",
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

  if (!body.name || typeof body.name !== "string") {
    return NextResponse.json(
      { success: false, error: { code: "VALIDATION_ERROR", message: "Campaign 'name' is required" } },
      { status: 400 }
    );
  }

  try {
    const scheduledAt = typeof body.scheduledAt === "string" ? new Date(body.scheduledAt) : null;

    const campaign = await EmailCampaignService.createCampaign(auth.clientId, {
      name: body.name,
      description: typeof body.description === "string" ? body.description : null,
      type: typeof body.type === "string" ? (body.type as EmailType) : undefined,
      templateId: typeof body.templateId === "string" ? body.templateId : undefined,
      templateVersionId: typeof body.templateVersionId === "string" ? body.templateVersionId : undefined,
      listId: typeof body.listId === "string" ? body.listId : null,
      segmentId: typeof body.segmentId === "string" ? body.segmentId : null,
      senderIdentityId: typeof body.senderIdentityId === "string" ? body.senderIdentityId : null,
      scheduledAt,
    });

    EmailAuditLogger.log(
      auth.clientId,
      auth.role || "ADMIN",
      "CAMPAIGN_CREATED",
      campaign.id,
      { name: campaign.name, type: campaign.type }
    );

    return NextResponse.json({ success: true, data: campaign }, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to create campaign";
    return NextResponse.json(
      { success: false, error: { code: "BAD_REQUEST", message: msg } },
      { status: 400 }
    );
  }
}
