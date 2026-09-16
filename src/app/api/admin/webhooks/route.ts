import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import crypto from "crypto";
import { encryptWebhookSecret } from "@/lib/crypto";
import { validateWebhookUrlSync } from "@/lib/webhooks/ssrf";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const clientId = searchParams.get("clientId") || undefined;

    const endpoints = await prisma.webhookEndpoint.findMany({
      where: clientId ? { clientId } : undefined,
      select: {
        id: true,
        clientId: true,
        name: true,
        url: true,
        active: true,
        subscribedEvents: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { deliveries: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json({
      success: true,
      data: endpoints,
    });
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
    let clientId = body.clientId?.trim();

    if (!name || !url) {
      return NextResponse.json(
        { success: false, error: "Name and URL are required" },
        { status: 400 }
      );
    }

    // SSRF URL validation
    const urlCheck = validateWebhookUrlSync(url);
    if (!urlCheck.valid) {
      return NextResponse.json(
        { success: false, error: `Invalid or disallowed webhook URL: ${urlCheck.reason}` },
        { status: 400 }
      );
    }

    // Resolve clientId if not explicitly provided
    if (!clientId) {
      const defaultClient = await prisma.apiClient.findFirst({
        where: { active: true },
        orderBy: { createdAt: "asc" },
      });
      if (!defaultClient) {
        return NextResponse.json(
          { success: false, error: "No active API client exists to own this webhook endpoint" },
          { status: 400 }
        );
      }
      clientId = defaultClient.id;
    } else {
      const clientExists = await prisma.apiClient.findUnique({
        where: { id: clientId },
      });
      if (!clientExists) {
        return NextResponse.json(
          { success: false, error: `API client with id '${clientId}' not found` },
          { status: 404 }
        );
      }
    }

    // Generate random 48-char hex signing secret
    const signingSecret = crypto.randomBytes(24).toString("hex");
    const encryptedSecret = encryptWebhookSecret(signingSecret);

    const endpoint = await prisma.webhookEndpoint.create({
      data: {
        clientId,
        name,
        url,
        encryptedSecret,
        subscribedEvents: JSON.stringify(events),
        active: true,
      },
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

    // Return the raw signing secret ONLY ONCE upon creation.
    // The database only stores encryptedSecret.
    return NextResponse.json({
      success: true,
      data: {
        ...endpoint,
        signingSecret,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error creating webhook endpoint";
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
