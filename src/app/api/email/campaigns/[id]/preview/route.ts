import { NextRequest, NextResponse } from "next/server";
import { authenticateEmailApi } from "@/lib/email/api-auth-helper";
import { EmailCampaignService } from "@/lib/services/email-campaign-service";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  // Read-only: permitted for VIEWER and ADMIN
  const auth = await authenticateEmailApi(req, { requireAdminForMutations: false });
  if (!auth.authorized || !auth.clientId) return auth.errorResponse!;

  try {
    const preview = await EmailCampaignService.previewCampaign(auth.clientId, id);
    return NextResponse.json({ success: true, data: preview });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error generating campaign preview";
    const status = msg.includes("not found") ? 404 : 400;
    return NextResponse.json(
      { success: false, error: { code: status === 404 ? "NOT_FOUND" : "BAD_REQUEST", message: msg } },
      { status }
    );
  }
}
