import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { EmailProviderStatus, EmailProviderType } from "@prisma/client";
import { encryptProviderCredential } from "@/lib/crypto";

export async function GET(req: NextRequest) {
  const auth = await requireUser(req);
  if (auth.response) return auth.response;

  try {
    const { searchParams } = new URL(req.url);
    const clientId = searchParams.get("clientId");

    const providers = await prisma.emailProviderConfig.findMany({
      where: clientId ? { clientId } : undefined,
      select: {
        id: true,
        clientId: true,
        name: true,
        providerType: true,
        status: true,
        isDefault: true,
        senderEmail: true,
        senderName: true,
        configMetadata: true,
        lastVerifiedAt: true,
        errorMessage: true,
        createdAt: true,
        updatedAt: true,
        // encryptedCredentials and encryptedOAuthRefreshToken strictly omitted!
      },
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json({ success: true, data: providers });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error listing email providers";
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  // Only ADMIN can mutate or connect email providers
  const auth = await requireUser(req, "ADMIN");
  if (auth.response) return auth.response;

  try {
    const body = await req.json();
    const { clientId, name, providerType, senderEmail, senderName, credentials, isDefault } = body;

    if (!clientId) {
      return NextResponse.json({ success: false, error: "clientId is required" }, { status: 400 });
    }

    if (!providerType || !Object.values(EmailProviderType).includes(providerType)) {
      return NextResponse.json({ success: false, error: "Valid providerType is required" }, { status: 400 });
    }

    // Verify tenant exists
    const client = await prisma.apiClient.findUnique({ where: { id: clientId } });
    if (!client) {
      return NextResponse.json({ success: false, error: "ApiClient not found" }, { status: 404 });
    }

    let encryptedCredentials: string | null = null;
    let encryptedOAuthRefreshToken: string | null = null;

    if (credentials) {
      encryptedCredentials = encryptProviderCredential(JSON.stringify(credentials));
      if (credentials.refreshToken) {
        encryptedOAuthRefreshToken = encryptProviderCredential(credentials.refreshToken);
      }
    }

    if (isDefault) {
      await prisma.emailProviderConfig.updateMany({
        where: { clientId, isDefault: true },
        data: { isDefault: false },
      });
    }

    const providerConfig = await prisma.emailProviderConfig.create({
      data: {
        clientId,
        name: name || `${providerType} Provider`,
        providerType,
        status: EmailProviderStatus.ACTIVE,
        isDefault: Boolean(isDefault),
        senderEmail: senderEmail || null,
        senderName: senderName || null,
        encryptedCredentials,
        encryptedOAuthRefreshToken,
        lastVerifiedAt: credentials ? new Date() : null,
      },
      select: {
        id: true,
        clientId: true,
        name: true,
        providerType: true,
        status: true,
        isDefault: true,
        senderEmail: true,
        senderName: true,
        createdAt: true,
        // secrets omitted
      },
    });

    return NextResponse.json({ success: true, data: providerConfig }, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error creating email provider";
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
