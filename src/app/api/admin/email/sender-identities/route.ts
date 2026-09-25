import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { normalizeEmail, isValidEmail } from "@/lib/email/normalization";

export async function GET(req: NextRequest) {
  const auth = await requireUser(req);
  if (auth.response) return auth.response;

  try {
    const { searchParams } = new URL(req.url);
    const clientId = searchParams.get("clientId");

    const identities = await prisma.emailSenderIdentity.findMany({
      where: clientId ? { clientId } : undefined,
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

    if (!clientId) {
      return NextResponse.json({ success: false, error: "clientId is required" }, { status: 400 });
    }

    if (!email || !isValidEmail(email)) {
      return NextResponse.json({ success: false, error: "A valid email is required" }, { status: 400 });
    }

    const cleanEmail = normalizeEmail(email);

    if (isDefault) {
      await prisma.emailSenderIdentity.updateMany({
        where: { clientId, isDefault: true },
        data: { isDefault: false },
      });
    }

    const identity = await prisma.emailSenderIdentity.upsert({
      where: {
        clientId_email: {
          clientId,
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
        clientId,
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
