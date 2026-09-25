import { NextRequest, NextResponse } from "next/server";
import { checkRateLimit } from "@/lib/rate-limit";
import { AuthTokenService } from "@/lib/services/auth-token-service";

export async function POST(req: NextRequest) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";

  // Rate limit: 10 attempts per 15 minutes per IP
  const rl = await checkRateLimit(`reset_pw_ip_${ip}`, 10, 15 * 60 * 1000);
  if (!rl.success) {
    return NextResponse.json(
      {
        success: false,
        error: {
          code: "RATE_LIMITED",
          message: "Too many password reset attempts. Please try again later.",
        },
      },
      { status: 429, headers: { "Retry-After": String(rl.resetSeconds) } }
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { success: false, error: { code: "BAD_REQUEST", message: "Invalid JSON body" } },
      { status: 400 }
    );
  }

  const bodyObj = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const token = typeof bodyObj.token === "string" ? bodyObj.token.trim() : "";
  const password = typeof bodyObj.password === "string" ? bodyObj.password : "";

  if (!token) {
    return NextResponse.json(
      { success: false, error: { code: "VALIDATION_ERROR", message: "Reset token is required." } },
      { status: 400 }
    );
  }

  if (!password || password.length < 8) {
    return NextResponse.json(
      {
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "New password must be at least 8 characters long.",
        },
      },
      { status: 400 }
    );
  }

  const result = await AuthTokenService.resetPassword(token, password);

  if (!result.success) {
    return NextResponse.json(
      { success: false, error: { code: result.code || "RESET_FAILED", message: result.message } },
      { status: 400 }
    );
  }

  return NextResponse.json({ success: true, message: result.message });
}
