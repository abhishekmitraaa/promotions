import { NextRequest, NextResponse } from "next/server";
import { authenticateEmailApi } from "@/lib/email/api-auth-helper";
import { EmailAnalyticsService } from "@/lib/services/email-analytics-service";

export async function GET(req: NextRequest) {
  // Read-only analytics accessible to VIEWER and ADMIN
  const auth = await authenticateEmailApi(req, { requireAdminForMutations: false });
  if (!auth.authorized || !auth.clientId) return auth.errorResponse!;

  try {
    const analytics = await EmailAnalyticsService.getTenantAnalytics(auth.clientId);
    return NextResponse.json({ success: true, data: analytics });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error retrieving analytics";
    return NextResponse.json(
      { success: false, error: { code: "SERVER_ERROR", message: msg } },
      { status: 500 }
    );
  }
}
