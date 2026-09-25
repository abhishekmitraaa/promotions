import { NextRequest, NextResponse } from "next/server";
import { checkRateLimit } from "@/lib/rate-limit";
import { AuthTokenService } from "@/lib/services/auth-token-service";
import { normalizeEmail, isValidEmail } from "@/lib/email/normalization";

export async function POST(req: NextRequest) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";

  // Rate limit: 5 requests per 15 minutes per IP
  const ipRateLimit = await checkRateLimit(`forgot_pw_ip_${ip}`, 5, 15 * 60 * 1000);
  if (!ipRateLimit.success) {
    return NextResponse.json(
      {
        success: false,
        error: {
          code: "RATE_LIMITED",
          message: "Too many password reset attempts. Please try again later.",
        },
      },
      { status: 429, headers: { "Retry-After": String(ipRateLimit.resetSeconds) } }
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
  const rawEmail = typeof bodyObj.email === "string" ? bodyObj.email.trim() : "";

  // Generic response to prevent user enumeration
  const genericResponse = {
    success: true,
    message: "If an account with that email exists, password reset instructions have been sent.",
  };

  if (!rawEmail || !isValidEmail(rawEmail)) {
    // Return generic response without disclosing validation discrepancy
    return NextResponse.json(genericResponse);
  }

  const normalizedEmail = normalizeEmail(rawEmail);

  // Rate limit per normalized email (3 requests per 15 minutes)
  const emailRateLimit = await checkRateLimit(`forgot_pw_email_${normalizedEmail}`, 3, 15 * 60 * 1000);
  if (!emailRateLimit.success) {
    return NextResponse.json(
      {
        success: false,
        error: {
          code: "RATE_LIMITED",
          message: "Too many reset requests for this email. Please try again later.",
        },
      },
      { status: 429, headers: { "Retry-After": String(emailRateLimit.resetSeconds) } }
    );
  }

  const result = await AuthTokenService.requestPasswordReset(normalizedEmail);
  return NextResponse.json(result);
}
