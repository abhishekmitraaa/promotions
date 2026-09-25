import { NextRequest, NextResponse } from "next/server";
import { authenticateEmailApi } from "@/lib/email/api-auth-helper";
import { EmailDeliveryService } from "@/lib/services/email-delivery-service";
import { EmailDeliveryStatus, EmailType } from "@prisma/client";

export async function GET(req: NextRequest) {
  const auth = await authenticateEmailApi(req, { requireAdminForMutations: false });
  if (!auth.authorized || !auth.clientId) {
    return auth.errorResponse || NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const page = searchParams.get("page") ? parseInt(searchParams.get("page")!, 10) : undefined;
  const limit = searchParams.get("limit") ? parseInt(searchParams.get("limit")!, 10) : undefined;
  const status = (searchParams.get("status") as EmailDeliveryStatus) || undefined;
  const category = (searchParams.get("category") as EmailType) || undefined;
  const to = searchParams.get("to") || undefined;
  const campaignId = searchParams.get("campaignId") || undefined;

  try {
    const result = await EmailDeliveryService.listDeliveries(auth.clientId, {
      page,
      limit,
      status,
      category,
      to,
      campaignId,
    });

    return NextResponse.json({
      success: true,
      data: result,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to list deliveries";
    return NextResponse.json(
      {
        success: false,
        error: { code: "SERVER_ERROR", message: msg },
      },
      { status: 500 }
    );
  }
}
