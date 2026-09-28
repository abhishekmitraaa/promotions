import { NextRequest, NextResponse } from "next/server";
import { checkRateLimit, getClientIp, rateLimitResponse } from "@/lib/rate-limit";
import { AuthTokenService } from "@/lib/services/auth-token-service";
import { normalizeEmail, isValidEmail } from "@/lib/email/normalization";

export async function POST(req: NextRequest) {
  const ip = getClientIp(req);

  // Rate limit: 5 requests per 15 minutes per IP
  const ipRateLimit = await checkRateLimit(`forgot_pw_ip_${ip}`, 5, 15 * 60 * 1000, {
    criticality: "CRITICAL",
    failClosed: true,
    syncToDb: true,
  });
  if (!ipRateLimit.success) {
    return rateLimitResponse(
      ipRateLimit,
      "Too many password reset attempts. Please try again later."
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
  const emailRateLimit = await checkRateLimit(
    `forgot_pw_email_${normalizedEmail}`,
    3,
    15 * 60 * 1000,
    { criticality: "CRITICAL", failClosed: true, syncToDb: true }
  );
  if (!emailRateLimit.success) {
    return rateLimitResponse(
      emailRateLimit,
      "Too many reset requests for this email. Please try again later."
    );
  }

  const result = await AuthTokenService.requestPasswordReset(normalizedEmail);
  return NextResponse.json(result);
}
