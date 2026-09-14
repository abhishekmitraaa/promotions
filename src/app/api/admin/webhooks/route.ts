import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import crypto from "crypto";

export async function GET() {
  try {
    const endpoints = await prisma.webhookEndpoint.findMany({
      include: {
        _count: { select: { deliveries: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json({ success: true, endpoints, data: endpoints });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error fetching webhooks";
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const name = body.name?.trim();
    const url = body.url?.trim();
    const events = body.subscribedEvents || ["*"];

    if (!name || !url) {
      return NextResponse.json(
        { success: false, error: "Name and URL are required" },
        { status: 400 }
      );
    }

    const secretHash = crypto.randomBytes(24).toString("hex");

    const endpoint = await prisma.webhookEndpoint.create({
      data: {
        name,
        url,
        secretHash,
        subscribedEvents: JSON.stringify(events),
        active: true,
      },
    });

    return NextResponse.json({ success: true, endpoint, data: endpoint });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error creating webhook endpoint";
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
