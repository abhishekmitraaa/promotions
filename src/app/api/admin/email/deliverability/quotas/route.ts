import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { emailQuotaService } from "@/lib/services/email-quota-service";

export async function GET(req: NextRequest) {
  const auth = await requireUser(req);
  if (auth.response) return auth.response;

  try {
    const { searchParams } = new URL(req.url);
    let targetClientId = searchParams.get("clientId") || undefined;
    if (!targetClientId) {
      const defaultClient = await prisma.apiClient.findFirst({
        where: { active: true },
        orderBy: { createdAt: "asc" },
        select: { id: true },
      });
      targetClientId = defaultClient?.id;
    }

    if (!targetClientId) {
      return NextResponse.json({ success: true, data: [] });
    }

    const quotas = await emailQuotaService.getTenantQuotas(targetClientId);
    return NextResponse.json({ success: true, data: quotas });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { success: false, error: { code: "SERVER_ERROR", message: msg } },
      { status: 500 }
    );
  }
}
