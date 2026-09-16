import { NextRequest, NextResponse } from "next/server";
import { authenticateApiKey } from "@/lib/api-auth";
import { MessageService } from "@/lib/services/message-service";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await authenticateApiKey(req);
  if (!auth.authenticated || !auth.clientId) return auth.errorResponse!;

  const { id } = await params;

  if (!id) {
    return NextResponse.json(
      {
        success: false,
        error: { code: "BAD_REQUEST", message: "Message ID is required" },
      },
      { status: 400 }
    );
  }

  try {
    const message = await MessageService.getById(id, auth.clientId);

    if (!message) {
      return NextResponse.json(
        {
          success: false,
          error: { code: "NOT_FOUND", message: `Message not found with ID '${id}'` },
        },
        { status: 404 }
      );
    }

    return NextResponse.json({
      success: true,
      data: message,
    });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : "Internal error retrieving message";
    return NextResponse.json(
      {
        success: false,
        error: { code: "INTERNAL_ERROR", message: errorMsg },
      },
      { status: 500 }
    );
  }
}
