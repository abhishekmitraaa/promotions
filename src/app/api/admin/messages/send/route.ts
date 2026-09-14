import { NextRequest, NextResponse } from "next/server";
import { createMessageSchema } from "@/lib/validation/messages";
import { MessageService } from "@/lib/services/message-service";
import { MessageStatus } from "@prisma/client";

export async function POST(req: NextRequest) {
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

  try {
    const result = await MessageService.send(parseResult.data);
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
