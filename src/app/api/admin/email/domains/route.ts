import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { emailDomainService } from "@/lib/services/email-domain-service";
import { EmailProviderType } from "@prisma/client";

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

    const domains = await emailDomainService.listDomains(targetClientId);
    return NextResponse.json({ success: true, data: domains });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { success: false, error: { code: "SERVER_ERROR", message: msg } },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireUser(req, "ADMIN");
  if (auth.response) return auth.response;

  try {
    const body = await req.json();
    let targetClientId = body?.clientId;

    if (!targetClientId) {
      const defaultClient = await prisma.apiClient.findFirst({
        where: { active: true },
        orderBy: { createdAt: "asc" },
        select: { id: true },
      });
      targetClientId = defaultClient?.id;
    }

    if (!targetClientId) {
      return NextResponse.json(
        { success: false, error: { code: "VALIDATION_ERROR", message: "Client ID is required" } },
        { status: 400 }
      );
    }

    const domain = body?.domain;
    if (!domain || typeof domain !== "string") {
      return NextResponse.json(
        { success: false, error: { code: "VALIDATION_ERROR", message: "Domain name is required" } },
        { status: 400 }
      );
    }

    const providerType = (body?.providerType as EmailProviderType) || EmailProviderType.GMAIL;
    const selector = body?.dkimSelector || "whub";

    const result = await emailDomainService.createDomain(
      targetClientId,
      domain,
      providerType,
      selector
    );

    return NextResponse.json({ success: true, data: result }, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { success: false, error: { code: "DOMAIN_CREATION_FAILED", message: msg } },
      { status: 400 }
    );
  }
}
