import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { MessageService } from "@/lib/services/message-service";
import { MessageDirection, MessageStatus } from "@prisma/client";

export async function GET(req: NextRequest) {
  const auth = await requireUser(req);
  if (auth.response) return auth.response;
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
