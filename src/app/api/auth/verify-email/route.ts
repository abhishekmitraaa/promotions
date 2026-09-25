import { NextRequest, NextResponse } from "next/server";
import { checkRateLimit } from "@/lib/rate-limit";
import { AuthTokenService } from "@/lib/services/auth-token-service";

export async function GET(req: NextRequest) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";

  // Rate limit: 20 verification requests per 15 minutes per IP
  const rl = await checkRateLimit(`verify_email_ip_${ip}`, 20, 15 * 60 * 1000);
  if (!rl.success) {
    return NextResponse.json(
      {
        success: false,
        error: { code: "RATE_LIMITED", message: "Too many verification attempts. Please wait." },
      },
      { status: 429, headers: { "Retry-After": String(rl.resetSeconds) } }
    );
  }

  const { searchParams } = new URL(req.url);
  const token = searchParams.get("token");

  if (!token) {
    return NextResponse.json(
      { success: false, error: { code: "VALIDATION_ERROR", message: "Verification token is required" } },
      { status: 400 }
    );
  }

  const result = await AuthTokenService.verifyEmailToken(token);

  if (!result.success) {
    return NextResponse.json(
      { success: false, error: { code: result.code || "VERIFICATION_FAILED", message: result.message } },
      { status: 400 }
    );
  }

  // Redirect to login with verified flag
  const appUrl = process.env.APP_URL || new URL(req.url).origin;
  return NextResponse.redirect(new URL("/login?verified=true", appUrl));
}

export async function POST(req: NextRequest) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";

  const rl = await checkRateLimit(`verify_email_ip_${ip}`, 20, 15 * 60 * 1000);
  if (!rl.success) {
    return NextResponse.json(
      {
        success: false,
        error: { code: "RATE_LIMITED", message: "Too many verification attempts. Please wait." },
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

  if (!token) {
    return NextResponse.json(
      { success: false, error: { code: "VALIDATION_ERROR", message: "Verification token is required." } },
      { status: 400 }
    );
  }

  const result = await AuthTokenService.verifyEmailToken(token);

  if (!result.success) {
    return NextResponse.json(
      { success: false, error: { code: result.code || "VERIFICATION_FAILED", message: result.message } },
      { status: 400 }
    );
  }

  return NextResponse.json({
    success: true,
    message: result.message || "Email address successfully verified.",
  });
}
