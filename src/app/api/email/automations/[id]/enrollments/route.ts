import { NextRequest, NextResponse } from "next/server";
import { authenticateEmailApi } from "@/lib/email/api-auth-helper";
import { prisma } from "@/lib/prisma";
import { EmailEnrollmentStatus, Prisma } from "@prisma/client";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(req: NextRequest, { params }: RouteParams) {
  const auth = await authenticateEmailApi(req, { requireAdminForMutations: false });
  if (!auth.authorized || !auth.clientId) return auth.errorResponse!;

  const { id } = await params;
  if (!id) {
    return NextResponse.json(
      { success: false, error: { code: "BAD_REQUEST", message: "Automation ID is required" } },
      { status: 400 }
    );
  }

  try {
    const { searchParams } = new URL(req.url);
    const status = (searchParams.get("status") as EmailEnrollmentStatus) || undefined;
    const limit = Math.min(100, Math.max(1, parseInt(searchParams.get("limit") || "50", 10)));
    const offset = Math.max(0, parseInt(searchParams.get("offset") || "0", 10));

    const where: Prisma.EmailAutomationEnrollmentWhereInput = {
      automationId: id,
      clientId: auth.clientId,
    };
    if (status) where.status = status;

    const [total, enrollments] = await Promise.all([
      prisma.emailAutomationEnrollment.count({ where }),
      prisma.emailAutomationEnrollment.findMany({
        where,
        include: {
          contact: {
            select: {
              id: true,
              email: true,
              firstName: true,
              lastName: true,
              hasMarketingConsent: true,
              status: true,
            },
          },
        },
        orderBy: { enrolledAt: "desc" },
        take: limit,
        skip: offset,
      }),
    ]);

    return NextResponse.json({
      success: true,
      data: {
        total,
        limit,
        offset,
        enrollments,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to list enrollments";
    return NextResponse.json(
      { success: false, error: { code: "SERVER_ERROR", message: msg } },
      { status: 500 }
    );
  }
}
