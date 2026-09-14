import { NextResponse } from "next/server";
import { MessageService } from "@/lib/services/message-service";

export async function GET() {
  try {
    const conversations = await MessageService.getConversations();

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
