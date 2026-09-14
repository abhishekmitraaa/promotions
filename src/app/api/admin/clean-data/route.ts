import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function POST() {
  try {
    const delDeliveries = await prisma.webhookDelivery.deleteMany({});
    const delEndpoints = await prisma.webhookEndpoint.deleteMany({});
    const delEvents = await prisma.messageEvent.deleteMany({});
    const delMessages = await prisma.message.deleteMany({});
    const delOtps = await prisma.otpVerification.deleteMany({});
    const delKeys = await prisma.apiKey.deleteMany({});
    const delClients = await prisma.apiClient.deleteMany({});

    return NextResponse.json({
      success: true,
      message: "All dummy data deleted successfully",
      deleted: {
        messages: delMessages.count,
        events: delEvents.count,
        deliveries: delDeliveries.count,
        endpoints: delEndpoints.count,
        otps: delOtps.count,
        keys: delKeys.count,
        clients: delClients.count,
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to clean database";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export async function DELETE() {
  return POST();
}
