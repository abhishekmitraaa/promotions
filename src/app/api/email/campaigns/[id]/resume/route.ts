import { NextRequest, NextResponse } from "next/server";
import { authenticateEmailApi } from "@/lib/email/api-auth-helper";
import { EmailCampaignService } from "@/lib/services/email-campaign-service";
import { EmailAuditLogger } from "@/lib/email/audit-logger";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  // Mutation: strictly ADMIN only (VIEWER denied with 403)
  const auth = await authenticateEmailApi(req, { requireAdminForMutations: true });
  if (!auth.authorized || !auth.clientId) return auth.errorResponse!;

  try {
    const result = await EmailCampaignService.resumeCampaign(auth.clientId, id);
    EmailAuditLogger.log(auth.clientId, auth.role || "ADMIN", "CAMPAIGN_RESUMED", id);
    return NextResponse.json({ success: true, data: result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to resume campaign";
    const status = msg.includes("not found") ? 404 : 400;
    return NextResponse.json(
      {
        success: false,
        error: {
          code: status === 404 ? "NOT_FOUND" : "BAD_REQUEST",
          message: msg,
        },
      },
      { status }
    );
  }
}
