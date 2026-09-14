import { NextRequest, NextResponse } from "next/server";
import { authenticateApiKey } from "@/lib/api-auth";
import { createMessageSchema } from "@/lib/validation/messages";
import { MessageService } from "@/lib/services/message-service";
import { MessageDirection, MessageStatus } from "@prisma/client";

export async function POST(req: NextRequest) {
  const auth = await authenticateApiKey(req);
  if (!auth.authenticated) return auth.errorResponse!;

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

  const idempotencyKey = req.headers.get("idempotency-key") || undefined;

  try {
    const result = await MessageService.send(parseResult.data, { idempotencyKey });
    const statusCode = result.status === MessageStatus.FAILED ? 502 : 200;

    return NextResponse.json(
      {
        success: result.status !== MessageStatus.FAILED,
        message: {
          id: result.id,
          providerMessageId: result.providerMessageId,
          status: result.status,
          to: result.to,
          type: result.type,
          sentAt: result.sentAt,
          ...(result.error ? { error: result.error } : {}),
        },
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

export async function GET(req: NextRequest) {
  const auth = await authenticateApiKey(req);
  if (!auth.authenticated) return auth.errorResponse!;

  const { searchParams } = new URL(req.url);

  const directionParam = searchParams.get("direction");
  const statusParam = searchParams.get("status");
  const search = searchParams.get("search") || undefined;
  const page = parseInt(searchParams.get("page") || "1", 10);
  const limit = parseInt(searchParams.get("limit") || "20", 10);

  const direction =
    directionParam === "INBOUND" || directionParam === "OUTBOUND"
      ? (directionParam as MessageDirection)
      : undefined;

  const status = Object.values(MessageStatus).includes(statusParam as MessageStatus)
    ? (statusParam as MessageStatus)
    : undefined;

  try {
    const result = await MessageService.getMessages({
      direction,
      status,
      search,
      page,
      limit,
    });

    return NextResponse.json({
      success: true,
      data: result.messages,
      pagination: result.pagination,
    });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : "Internal error listing messages";
    return NextResponse.json(
      {
        success: false,
        error: { code: "INTERNAL_ERROR", message: errorMsg },
      },
      { status: 500 }
    );
  }
}
