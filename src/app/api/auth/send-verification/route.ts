import { NextRequest, NextResponse } from "next/server";
import { checkRateLimit } from "@/lib/rate-limit";
import { AuthTokenService } from "@/lib/services/auth-token-service";
import { getAuthenticatedUser } from "@/lib/auth";
import { isValidEmail, normalizeEmail } from "@/lib/email/normalization";

export async function POST(req: NextRequest) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";

  // Rate limit: 5 verification dispatch requests per 15 minutes per IP
  const rl = await checkRateLimit(`send_ver_ip_${ip}`, 5, 15 * 60 * 1000);
  if (!rl.success) {
    return NextResponse.json(
      {
        success: false,
        error: { code: "RATE_LIMITED", message: "Too many verification requests. Please wait." },
      },
      { status: 429, headers: { "Retry-After": String(rl.resetSeconds) } }
    );
  }

  let email = "";

  // 1. Try authenticated user
  const user = await getAuthenticatedUser(req);
  if (user && user.email) {
    email = user.email;
  } else {
    // 2. Otherwise read from body
    try {
      const body = await req.json();
      if (body && typeof body.email === "string") {
        email = body.email.trim();
      }
    } catch {
      return NextResponse.json(
        { success: false, error: { code: "BAD_REQUEST", message: "Invalid JSON body" } },
        { status: 400 }
      );
    }
  }

  if (!email || !isValidEmail(email)) {
    return NextResponse.json(
      { success: false, error: { code: "VALIDATION_ERROR", message: "Valid email is required" } },
      { status: 400 }
    );
  }

  const normalized = normalizeEmail(email);

  try {
    await AuthTokenService.sendVerificationEmail(normalized);
    return NextResponse.json({
      success: true,
      message: "Verification email has been dispatched. Please check your inbox.",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to dispatch verification email";
    return NextResponse.json(
      { success: false, error: { code: "DISPATCH_FAILED", message: msg } },
      { status: 500 }
    );
  }
}
