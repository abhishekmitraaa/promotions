import { NextRequest, NextResponse } from "next/server";
import { authenticateEmailApi } from "@/lib/email/api-auth-helper";
import { EmailDeliveryService } from "@/lib/services/email-delivery-service";

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
    const delivery = await EmailDeliveryService.getDeliveryById(auth.clientId, id);

    if (!delivery) {
      return NextResponse.json(
        {
          success: false,
          error: { code: "NOT_FOUND", message: `Delivery '${id}' not found` },
        },
        { status: 404 }
      );
    }

    return NextResponse.json({
      success: true,
      data: delivery,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to retrieve delivery";
    return NextResponse.json(
      {
        success: false,
        error: { code: "SERVER_ERROR", message: msg },
      },
      { status: 500 }
    );
  }
}
