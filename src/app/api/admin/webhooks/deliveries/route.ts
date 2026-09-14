import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { deliverWebhookPayload } from "@/lib/webhooks/dispatcher";

export async function GET() {
  try {
    const deliveries = await prisma.webhookDelivery.findMany({
      include: {
        endpoint: {
          select: { name: true, url: true },
        },
      },
      orderBy: { createdAt: "desc" },
      take: 50,
    });

    return NextResponse.json({ success: true, deliveries, data: deliveries });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error fetching delivery history";
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
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

    // Trigger async retry
    deliverWebhookPayload(
      delivery.id,
      delivery.endpoint.url,
      delivery.endpoint.secretHash,
      delivery.payload,
      delivery.eventType
    ).catch(() => {});

    return NextResponse.json({ success: true, message: "Delivery retry initiated" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error retrying webhook delivery";
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
