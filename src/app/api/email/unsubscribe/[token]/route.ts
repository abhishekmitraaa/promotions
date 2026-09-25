import { NextRequest, NextResponse } from "next/server";
import { EmailUnsubscribeService } from "@/lib/services/email-unsubscribe-service";

interface RouteParams {
  params: Promise<{ token: string }>;
}

export async function GET(req: NextRequest, { params }: RouteParams) {
  const { token } = await params;

  if (!token) {
    return NextResponse.json(
      { success: false, error: { code: "BAD_REQUEST", message: "Token is required" } },
      { status: 400 }
    );
  }

  const result = await EmailUnsubscribeService.verifyToken(token);

  if (!result.valid) {
    return NextResponse.json(
      {
        success: false,
        error: {
          code: "INVALID_TOKEN",
          message: result.error || "Invalid or expired unsubscribe token",
        },
      },
      { status: 400 }
    );
  }

  return NextResponse.json({
    success: true,
    data: {
      valid: true,
      emailMasked: result.emailMasked,
      message: `Unsubscribe confirmation for ${result.emailMasked}`,
    },
  });
}

export async function POST(req: NextRequest, { params }: RouteParams) {
  const { token } = await params;

  if (!token) {
    return NextResponse.json(
      { success: false, error: { code: "BAD_REQUEST", message: "Token is required" } },
      { status: 400 }
    );
  }

  try {
    let source = "UNSUBSCRIBE_LINK";
    const contentType = req.headers.get("content-type") || "";
    if (contentType.includes("application/x-www-form-urlencoded")) {
      const text = await req.text().catch(() => "");
      if (text.includes("List-Unsubscribe=One-Click")) {
        source = "RFC8058_ONE_CLICK";
      }
    }

    const result = await EmailUnsubscribeService.executeUnsubscribe(token, source);
    return NextResponse.json({
      success: true,
      data: result,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to process unsubscribe";
    return NextResponse.json(
      {
        success: false,
        error: {
          code: "UNSUBSCRIBE_FAILED",
          message: msg,
        },
      },
      { status: 400 }
    );
  }
}
