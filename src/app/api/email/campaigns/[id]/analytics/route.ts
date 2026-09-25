import { NextRequest, NextResponse } from "next/server";
import { authenticateEmailApi } from "@/lib/email/api-auth-helper";
import { EmailAnalyticsService } from "@/lib/services/email-analytics-service";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(req: NextRequest, { params }: RouteParams) {
  const auth = await authenticateEmailApi(req, { requireAdminForMutations: false });
  if (!auth.authorized || !auth.clientId) {
    return auth.errorResponse || NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  try {
    const analytics = await EmailAnalyticsService.getCampaignAnalytics(
      auth.clientId,
      id
    );

    return NextResponse.json({
      success: true,
      data: analytics,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to retrieve analytics";
    const status = msg.includes("not found") ? 404 : 500;
    return NextResponse.json(
      {
        success: false,
        error: { code: status === 404 ? "NOT_FOUND" : "SERVER_ERROR", message: msg },
      },
      { status }
    );
  }
}
