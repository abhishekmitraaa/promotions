import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { MessageService } from "@/lib/services/message-service";

export async function GET(req: NextRequest) {
  const auth = await requireUser(req);
  if (auth.response) return auth.response;
  const { searchParams } = new URL(req.url);
  const clientId = searchParams.get("clientId") || undefined;
  const page = parseInt(searchParams.get("page") || "1", 10);
  const limit = parseInt(searchParams.get("limit") || "50", 10);

  try {
    const conversations = await MessageService.getConversations(clientId, {
      page,
      limit,
    });

    return NextResponse.json({
      success: true,
      data: conversations,
      pagination: {
        page: Math.max(1, page),
        limit: Math.min(Math.max(1, limit), 200),
      },
    });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : "Internal error listing conversations";
    return NextResponse.json(
      {
        success: false,
        error: { code: "INTERNAL_ERROR", message: errorMsg },
      },
      { status: 500 }
    );
  }
}
