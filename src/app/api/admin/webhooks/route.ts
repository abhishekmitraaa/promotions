import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import crypto from "crypto";
import { encryptWebhookSecret } from "@/lib/crypto";
import { validateAdminWebhookUrl, validateSubscribedEvents } from "@/lib/webhooks/validation";

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

    if (!name) {
      return NextResponse.json(
        { success: false, error: "Name is required" },
        { status: 400 }
      );
    }

    // Strong URL validation (syntax, length, control chars, SSRF)
    const urlValidation = validateAdminWebhookUrl(url);
    if (!urlValidation.valid || !urlValidation.value) {
      return NextResponse.json(
        { success: false, error: urlValidation.reason || "Invalid webhook URL" },
        { status: 400 }
      );
    }
    const validatedUrl = urlValidation.value;

    // Subscribed events catalog validation
    const eventsValidation = validateSubscribedEvents(events);
    if (!eventsValidation.valid || !eventsValidation.value) {
      return NextResponse.json(
        { success: false, error: eventsValidation.reason || "Invalid subscribedEvents" },
        { status: 400 }
      );
    }
    const validatedEvents = eventsValidation.value;

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

    // Duplicate check: Prevent registering identical active URL for the same client
    const existingActive = await prisma.webhookEndpoint.findFirst({
      where: {
        clientId,
        url: validatedUrl,
        active: true,
      },
    });

    if (existingActive) {
      return NextResponse.json(
        {
          success: false,
          error: `An active webhook endpoint with this URL already exists for this client (id: ${existingActive.id})`,
        },
        { status: 409 }
      );
    }

    // Generate random 48-char hex signing secret
    const signingSecret = crypto.randomBytes(24).toString("hex");
    const encryptedSecret = encryptWebhookSecret(signingSecret);

    const endpoint = await prisma.webhookEndpoint.create({
      data: {
        clientId,
        name,
        url: validatedUrl,
        encryptedSecret,
        subscribedEvents: JSON.stringify(validatedEvents),
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
