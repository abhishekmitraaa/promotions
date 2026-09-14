import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function POST(req: NextRequest) {
  // Permanently disabled in production
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json(
      {
        success: false,
        error: {
          code: "FORBIDDEN_IN_PRODUCTION",
          message: "Database cleanup endpoint is permanently disabled in production environments.",
        },
      },
      { status: 403 }
    );
  }

  // Require explicit confirmation body
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      {
        success: false,
        error: {
          code: "CONFIRMATION_REQUIRED",
          message:
            'Dangerous operation blocked. You must provide a JSON body with: { "confirm": "DELETE_ALL_LOCAL_DATA" }',
        },
      },
      { status: 400 }
    );
  }

  const isConfirmed =
    typeof body === "object" &&
    body !== null &&
    (body as { confirm?: string }).confirm === "DELETE_ALL_LOCAL_DATA";

  if (!isConfirmed) {
    return NextResponse.json(
      {
        success: false,
        error: {
          code: "CONFIRMATION_REQUIRED",
          message:
            'Dangerous operation blocked. You must provide a JSON body with: { "confirm": "DELETE_ALL_LOCAL_DATA" }',
        },
      },
      { status: 400 }
    );
  }

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
      message: "All local test data deleted successfully",
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
    return NextResponse.json(
      {
        success: false,
        error: {
          code: "INTERNAL_ERROR",
          message,
        },
      },
      { status: 500 }
    );
  }
}

export async function DELETE(req: NextRequest) {
  return POST(req);
}
