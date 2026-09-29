import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { emailDomainService } from "@/lib/services/email-domain-service";
import { EmailProviderType } from "@prisma/client";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireUser(req);
  if (auth.response) return auth.response;

  try {
    const { id } = await params;
    const domain = await prisma.emailDomain.findUnique({
      where: { id },
      include: {
        senderIdentities: true,
      },
    });

    if (!domain) {
      return NextResponse.json(
        { success: false, error: { code: "NOT_FOUND", message: "Domain not found" } },
        { status: 404 }
      );
    }

    const guidance = emailDomainService.generateDnsGuidance(
      domain.domain,
      EmailProviderType.GMAIL,
      domain.verificationToken,
      domain.dkimSelector || "whub"
    );

    return NextResponse.json({
      success: true,
      data: {
        domain,
        guidance,
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

export async function DELETE(
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

    await emailDomainService.deleteDomain(domain.clientId, id);

    return NextResponse.json({ success: true, message: "Domain deleted successfully" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { success: false, error: { code: "DELETE_FAILED", message: msg } },
      { status: 400 }
    );
  }
}
