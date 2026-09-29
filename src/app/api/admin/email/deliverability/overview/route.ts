import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { emailReputationService } from "@/lib/services/email-reputation-service";

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
      return NextResponse.json({
        success: true,
        data: {
          score: 100,
          grade: "EXCELLENT",
          metrics24h: { sentCount: 0, deliveredCount: 0, bouncedCount: 0, complaintCount: 0, bounceRate: 0, complaintRate: 0, deliveryRate: 100 },
          metrics7d: { sentCount: 0, deliveredCount: 0, bouncedCount: 0, complaintCount: 0, bounceRate: 0, complaintRate: 0, deliveryRate: 100 },
          googleYahooCompliance: { compliant: true, checks: { spfVerified: true, dkimVerified: true, dmarcVerified: true, complaintRateSafe: true, oneClickUnsubscribeSupported: true }, missingRequirements: [] },
          factors: { authenticationScore: 30, complaintScore: 35, bounceScore: 25, deliveryScore: 10 },
          actionableAlerts: [],
        },
      });
    }

    const report = await emailReputationService.getClientReputation(targetClientId);
    return NextResponse.json({ success: true, data: report });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { success: false, error: { code: "SERVER_ERROR", message: msg } },
      { status: 500 }
    );
  }
}
