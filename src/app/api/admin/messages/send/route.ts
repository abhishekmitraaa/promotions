import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { createMessageSchema } from "@/lib/validation/messages";
import { MessageService } from "@/lib/services/message-service";
import { MessageStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export async function POST(req: NextRequest) {
  const auth = await requireUser(req, "ADMIN");
  if (auth.response) return auth.response;
  let bodyJson: unknown;
  try {
    bodyJson = await req.json();
  } catch {
    return NextResponse.json(
      {
        success: false,
        error: { code: "BAD_REQUEST", message: "Invalid JSON request body" },
      },
      { status: 400 }
    );
  }

  const parseResult = createMessageSchema.safeParse(bodyJson);
  if (!parseResult.success) {
    return NextResponse.json(
      {
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "Request payload validation failed",
          details: parseResult.error.format(),
        },
      },
      { status: 400 }
    );
  }

  // Resolve clientId (explicit or default active client)
  const bodyObj = bodyJson as Record<string, unknown>;
  let clientId = typeof bodyObj?.clientId === "string" ? bodyObj.clientId.trim() : undefined;

  if (!clientId) {
    const defaultClient = await prisma.apiClient.findFirst({
      where: { active: true },
      orderBy: { createdAt: "asc" },
    });
    if (!defaultClient) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: "NO_ACTIVE_CLIENT",
            message: "No active API client found to associate message with.",
          },
        },
        { status: 400 }
      );
    }
    clientId = defaultClient.id;
  }

  try {
    const result = await MessageService.send(parseResult.data, { clientId });
    const statusCode = result.status === MessageStatus.FAILED ? 502 : 200;

    const messageData = {
      id: result.id,
      providerMessageId: result.providerMessageId,
      status: result.status,
      to: result.to,
      type: result.type,
      sentAt: result.sentAt,
      ...(result.error ? { error: result.error } : {}),
    };

    return NextResponse.json(
      {
        success: result.status !== MessageStatus.FAILED,
        data: messageData,
      },
      { status: statusCode }
    );
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : "Internal error sending message";
    return NextResponse.json(
      {
        success: false,
        error: { code: "INTERNAL_ERROR", message: errorMsg },
      },
      { status: 500 }
    );
  }
}
