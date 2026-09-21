import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import crypto from "crypto";
import { encryptWebhookSecret } from "@/lib/crypto";
import { requireUser } from "@/lib/auth";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireUser(req, "ADMIN");
  if (auth.response) return auth.response;
  const { id } = await params;

  try {
    const existing = await prisma.webhookEndpoint.findUnique({
      where: { id },
    });

    if (!existing) {
      return NextResponse.json(
        { success: false, error: "Webhook endpoint not found" },
        { status: 404 }
      );
    }

    const newSigningSecret = crypto.randomBytes(24).toString("hex");
    const encryptedSecret = encryptWebhookSecret(newSigningSecret);

    const updated = await prisma.webhookEndpoint.update({
      where: { id },
      data: { encryptedSecret },
      select: {
        id: true,
        clientId: true,
        name: true,
        url: true,
        active: true,
        subscribedEvents: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return NextResponse.json({
      success: true,
      data: {
        ...updated,
        signingSecret: newSigningSecret,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error regenerating signing secret";
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
