import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { emailDomainService } from "@/lib/services/email-domain-service";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireUser(req, "ADMIN");
  if (auth.response) return auth.response;

  try {
    const { id } = await params;
    const domain = await prisma.emailDomain.findUnique({
      where: { id },
    });

    if (!domain) {
      return NextResponse.json(
        { success: false, error: { code: "NOT_FOUND", message: "Domain not found" } },
        { status: 404 }
      );
    }

    const verificationResult = await emailDomainService.verifyDomain(domain.clientId, id);

    return NextResponse.json({
      success: true,
      data: verificationResult,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { success: false, error: { code: "VERIFICATION_ERROR", message: msg } },
      { status: 500 }
    );
  }
}
