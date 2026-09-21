import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { validateAdminWebhookUrl, validateSubscribedEvents } from "@/lib/webhooks/validation";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireUser(req, "VIEWER");
  if (auth.response && auth.response.status !== 403) return auth.response;
  const { id } = await params;

  try {
    const endpoint = await prisma.webhookEndpoint.findUnique({
      where: { id },
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
    });

    if (!endpoint) {
      return NextResponse.json(
        { success: false, error: "Webhook endpoint not found" },
        { status: 404 }
      );
    }

    return NextResponse.json({
      success: true,
      data: endpoint,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error fetching webhook endpoint";
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}

export async function PATCH(
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

    const body = await req.json();
    const updateData: {
      name?: string;
      url?: string;
      subscribedEvents?: string;
      active?: boolean;
    } = {};

    if (body.name !== undefined) {
      const name = String(body.name).trim();
      if (!name) {
        return NextResponse.json(
          { success: false, error: "Name cannot be empty" },
          { status: 400 }
        );
      }
      updateData.name = name;
    }

    if (body.url !== undefined) {
      const urlCheck = validateAdminWebhookUrl(body.url);
      if (!urlCheck.valid || !urlCheck.value) {
        return NextResponse.json(
          { success: false, error: urlCheck.reason || "Invalid webhook URL" },
          { status: 400 }
        );
      }
      updateData.url = urlCheck.value;
    }

    if (body.subscribedEvents !== undefined) {
      const eventsCheck = validateSubscribedEvents(body.subscribedEvents);
      if (!eventsCheck.valid || !eventsCheck.value) {
        return NextResponse.json(
          { success: false, error: eventsCheck.reason || "Invalid subscribedEvents" },
          { status: 400 }
        );
      }
      updateData.subscribedEvents = JSON.stringify(eventsCheck.value);
    }

    if (body.active !== undefined) {
      updateData.active = Boolean(body.active);
    }

    const updated = await prisma.webhookEndpoint.update({
      where: { id },
      data: updateData,
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
      data: updated,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error updating webhook endpoint";
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
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

    await prisma.webhookEndpoint.delete({
      where: { id },
    });

    return NextResponse.json({
      success: true,
      data: { id, deleted: true },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error deleting webhook endpoint";
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
