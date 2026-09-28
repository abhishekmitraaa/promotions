import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { normalizeEmail, isValidEmail } from "@/lib/email/normalization";

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

    const identities = await prisma.emailSenderIdentity.findMany({
      where: targetClientId ? { clientId: targetClientId } : undefined,
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json({ success: true, data: identities });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error listing sender identities";
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  // Only ADMIN can create or mutate sender identities
  const auth = await requireUser(req, "ADMIN");
  if (auth.response) return auth.response;

  try {
    const body = await req.json();
    const { clientId, email, name, replyToEmail, isDefault, verified } = body;

    let targetClientId = clientId;
    if (!targetClientId) {
      const defaultClient = await prisma.apiClient.findFirst({
        where: { active: true },
        orderBy: { createdAt: "asc" },
        select: { id: true },
      });
      targetClientId = defaultClient?.id;
    }
    if (!targetClientId) {
      const anyClient = await prisma.apiClient.findFirst({
        orderBy: { createdAt: "asc" },
        select: { id: true },
      });
      targetClientId = anyClient?.id;
    }
    if (!targetClientId) {
      const created = await prisma.apiClient.create({
        data: { name: "Default Organization", active: true },
        select: { id: true },
      });
      targetClientId = created.id;
    }

    if (!email || !isValidEmail(email)) {
      return NextResponse.json({ success: false, error: "A valid email is required" }, { status: 400 });
    }

    const cleanEmail = normalizeEmail(email);

    if (isDefault) {
      await prisma.emailSenderIdentity.updateMany({
        where: { clientId: targetClientId, isDefault: true },
        data: { isDefault: false },
      });
    }

    const identity = await prisma.emailSenderIdentity.upsert({
      where: {
        clientId_email: {
          clientId: targetClientId,
          email: cleanEmail,
        },
      },
      update: {
        name: name || undefined,
        replyToEmail: replyToEmail || undefined,
        verified: verified ?? false,
        verifiedAt: verified ? new Date() : undefined,
        isDefault: Boolean(isDefault),
      },
      create: {
        clientId: targetClientId,
        email: cleanEmail,
        name: name || null,
        replyToEmail: replyToEmail || null,
        verified: verified ?? false,
        verifiedAt: verified ? new Date() : null,
        isDefault: Boolean(isDefault),
      },
    });

    return NextResponse.json({ success: true, data: identity }, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error creating sender identity";
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
