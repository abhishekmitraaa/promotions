import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { emailDiagnosticsService } from "@/lib/services/email-diagnostics-service";
import { EmailDeliveryStatus, EmailFailureCategory } from "@prisma/client";

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

    const categoryFilter = searchParams.get("category") as EmailFailureCategory | null;
    const limit = Math.min(100, Math.max(1, parseInt(searchParams.get("limit") || "50", 10)));

    const failedDeliveries = await prisma.emailDelivery.findMany({
      where: {
        clientId: targetClientId,
        status: { in: [EmailDeliveryStatus.FAILED, EmailDeliveryStatus.BOUNCED, EmailDeliveryStatus.COMPLAINED] },
        failureCategory: categoryFilter || undefined,
      },
      select: {
        id: true,
        to: true,
        from: true,
        subject: true,
        status: true,
        category: true,
        failureCategory: true,
        diagnosticDetails: true,
        smtpCode: true,
        errorCode: true,
        errorMessage: true,
        attemptCount: true,
        failedAt: true,
        createdAt: true,
        campaign: {
          select: { id: true, name: true },
        },
      },
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    // Augment any unclassified legacy records on the fly
    const diagnosticsList = failedDeliveries.map((d) => {
      let classification = {
        category: d.failureCategory || EmailFailureCategory.UNKNOWN,
        smtpCode: d.smtpCode || null,
        humanSummary: d.diagnosticDetails || d.errorMessage || "Delivery failed",
        recommendedRemediation: "Inspect provider error message.",
      };

      if (!d.failureCategory || !d.diagnosticDetails) {
        const diag = emailDiagnosticsService.classifyFailure(d.errorMessage, d.errorCode);
        classification = {
          category: diag.category,
          smtpCode: diag.smtpCode,
          humanSummary: diag.humanSummary,
          recommendedRemediation: diag.recommendedRemediation,
        };
      } else {
        const diag = emailDiagnosticsService.classifyFailure(d.diagnosticDetails || d.errorMessage, d.smtpCode);
        classification.recommendedRemediation = diag.recommendedRemediation;
      }

      return {
        id: d.id,
        recipient: d.to,
        from: d.from,
        subject: d.subject,
        status: d.status,
        type: d.category,
        failureCategory: classification.category,
        smtpCode: classification.smtpCode,
        humanSummary: classification.humanSummary,
        recommendedRemediation: classification.recommendedRemediation,
        rawErrorMessage: d.errorMessage,
        rawErrorCode: d.errorCode,
        attemptCount: d.attemptCount,
        failedAt: d.failedAt || d.createdAt,
        campaignName: d.campaign?.name || null,
      };
    });

    // Also compute failure category distribution summary
    const categorySummary: Record<string, number> = {};
    for (const item of diagnosticsList) {
      categorySummary[item.failureCategory] = (categorySummary[item.failureCategory] || 0) + 1;
    }

    return NextResponse.json({
      success: true,
      data: {
        diagnostics: diagnosticsList,
        summary: categorySummary,
        total: diagnosticsList.length,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { success: false, error: { code: "SERVER_ERROR", message: msg } },
      { status: 500 }
    );
  }
}
