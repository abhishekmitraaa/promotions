import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { deliverWebhookPayload } from "@/lib/webhooks/dispatcher";
import { decryptWebhookSecret } from "@/lib/crypto";

export async function GET(req: NextRequest) {
  const auth = await requireUser(req);
  if (auth.response) return auth.response;
  try {
    const { searchParams } = new URL(req.url);
    const clientId = searchParams.get("clientId") || undefined;

    const deliveries = await prisma.webhookDelivery.findMany({
      where: clientId ? { clientId } : undefined,
      include: {
        endpoint: {
          select: { id: true, clientId: true, name: true, url: true },
        },
      },
      orderBy: { createdAt: "desc" },
      take: 50,
    });

    return NextResponse.json({ success: true, data: deliveries });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error fetching delivery history";
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireUser(req, "ADMIN");
  if (auth.response) return auth.response;
  try {
    const body = await req.json();
    const deliveryId = body.deliveryId;

    if (!deliveryId) {
      return NextResponse.json({ success: false, error: "deliveryId is required" }, { status: 400 });
    }

    const delivery = await prisma.webhookDelivery.findUnique({
      where: { id: deliveryId },
      include: { endpoint: true },
    });

    if (!delivery || !delivery.endpoint) {
      return NextResponse.json({ success: false, error: "Delivery or endpoint not found" }, { status: 404 });
    }

    // Decrypt signing secret from endpoint
    let signingSecret: string;
    try {
      signingSecret = decryptWebhookSecret(delivery.endpoint.encryptedSecret);
    } catch {
      return NextResponse.json(
        { success: false, error: "Failed to decrypt webhook signing secret for endpoint" },
        { status: 500 }
      );
    }

    // Trigger async retry
    deliverWebhookPayload(
      delivery.id,
      delivery.endpoint.url,
      signingSecret,
      delivery.payload,
      delivery.eventType
    ).catch(() => {});

    return NextResponse.json({
      success: true,
      data: { message: "Delivery retry initiated", deliveryId },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error retrying webhook delivery";
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
