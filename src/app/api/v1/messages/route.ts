import { NextRequest, NextResponse } from "next/server";
import { authenticateApiKey } from "@/lib/api-auth";
import { createMessageSchema } from "@/lib/validation/messages";
import { MessageService } from "@/lib/services/message-service";
import { MessageDirection, MessageStatus } from "@prisma/client";
import { checkRateLimit, getClientIp, rateLimitResponse } from "@/lib/rate-limit";

export async function POST(req: NextRequest) {
  const auth = await authenticateApiKey(req);
  if (!auth.authenticated || !auth.clientId) return auth.errorResponse!;

  const clientIp = getClientIp(req);

  // Distributed rate limiting per API key (60 messages per minute)
  const rateLimit = await checkRateLimit(`msg_key_${auth.keyId || "anon"}`, 60, 60000, {
    criticality: "HIGH",
    syncToDb: true,
  });
  if (!rateLimit.success) {
    return rateLimitResponse(
      rateLimit,
      `Too many message dispatch requests. Rate limit exceeded. Retry in ${rateLimit.resetSeconds} seconds.`,
      "RATE_LIMITED"
    );
  }

  // IP rate limiting: 60 messages per minute
  const ipLimit = await checkRateLimit(`rl:ip:${clientIp}:messages`, 60, 60000, {
    criticality: "HIGH",
  });
  if (!ipLimit.success) {
    return rateLimitResponse(
      ipLimit,
      `Too many message dispatch requests from IP address. Retry in ${ipLimit.resetSeconds} seconds.`,
      "IP_RATE_LIMITED"
    );
  }

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
  // Per-recipient phone number rate limiting: 30 messages per minute
  const rcptLimit = await checkRateLimit(
    `rl:rcpt:${auth.clientId}:${parseResult.data.to}:messages`,
    30,
    60000,
    { criticality: "HIGH" }
  );
  if (!rcptLimit.success) {
    return rateLimitResponse(
      rcptLimit,
      `Too many messages dispatched to destination '${parseResult.data.to}'. Rate limit exceeded. Retry in ${rcptLimit.resetSeconds} seconds.`,
      "RECIPIENT_RATE_LIMITED"
    );
  }

  const idempotencyKey = req.headers.get("idempotency-key") || undefined;

  try {
    const result = await MessageService.send(parseResult.data, {
      idempotencyKey,
      clientId: auth.clientId,
    });
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
        message: messageData,
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
  if (!auth.authenticated || !auth.clientId) return auth.errorResponse!;

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
      clientId: auth.clientId,
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
