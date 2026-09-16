import { NextRequest, NextResponse } from "next/server";
import { authenticateApiKey } from "@/lib/api-auth";
import { MessageService } from "@/lib/services/message-service";

export async function GET(req: NextRequest) {
  const auth = await authenticateApiKey(req);
  if (!auth.authenticated || !auth.clientId) return auth.errorResponse!;

  try {
    const conversations = await MessageService.getConversations(auth.clientId);

    return NextResponse.json({
      success: true,
      data: conversations,
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
