import { NextRequest, NextResponse } from "next/server";
import { checkRateLimit, getClientIp, rateLimitResponse } from "@/lib/rate-limit";
import { AuthTokenService } from "@/lib/services/auth-token-service";
import { getAuthenticatedUser } from "@/lib/auth";
import { isValidEmail, normalizeEmail } from "@/lib/email/normalization";

export async function POST(req: NextRequest) {
  const ip = getClientIp(req);

  // Rate limit: 5 verification dispatch requests per 15 minutes per IP
  const rl = await checkRateLimit(`send_ver_ip_${ip}`, 5, 15 * 60 * 1000, {
    criticality: "CRITICAL",
    failClosed: true,
    syncToDb: true,
  });
  if (!rl.success) {
    return rateLimitResponse(
      rl,
      "Too many verification requests from this IP. Please wait."
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

  // Rate limit: 3 requests per 15 minutes per email
  const emailRl = await checkRateLimit(`send_ver_email_${normalized}`, 3, 15 * 60 * 1000, {
    criticality: "CRITICAL",
    failClosed: true,
    syncToDb: true,
  });
  if (!emailRl.success) {
    return rateLimitResponse(
      emailRl,
      "Too many verification requests for this email address. Please try again later."
    );
  }

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
