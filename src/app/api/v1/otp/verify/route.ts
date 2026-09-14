import { NextRequest, NextResponse } from "next/server";
import { authenticateApiKey } from "@/lib/api-auth";
import { verifyOtpSchema } from "@/lib/validation/otp";
import { OtpService } from "@/lib/services/otp-service";
import { checkRateLimit } from "@/lib/rate-limit";
import { normalizePhoneNumber } from "@/lib/crypto";

export async function POST(req: NextRequest) {
  const auth = await authenticateApiKey(req);
  if (!auth.authenticated) return auth.errorResponse!;

  let bodyJson: unknown;
  try {
    bodyJson = await req.json();
  } catch {
    return NextResponse.json(
      {
        success: false,
        error: { code: "BAD_REQUEST", message: "Invalid JSON request body" },
      },
      { status: 400 }
    );
  }

  const parseResult = verifyOtpSchema.safeParse(bodyJson);
  if (!parseResult.success) {
    return NextResponse.json(
      {
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "OTP verification payload validation failed",
          details: parseResult.error.format(),
        },
      },
      { status: 400 }
    );
  }

  // Rate limit: max 10 verification attempts per normalized phone number per minute
  const normalizedPhone = normalizePhoneNumber(parseResult.data.to);
  const rateLimit = checkRateLimit(`otp_ver_${normalizedPhone}`, 10, 60000);
  if (!rateLimit.success) {
    return NextResponse.json(
      {
        success: false,
        error: {
          code: "RATE_LIMITED",
          message: `Too many OTP verification attempts for this phone number. Please wait ${rateLimit.resetSeconds} seconds.`,
        },
      },
      {
        status: 429,
        headers: { "Retry-After": String(rateLimit.resetSeconds) },
      }
    );
  }

  try {
    const result = await OtpService.verifyOtp(
      parseResult.data.to,
      parseResult.data.purpose,
      parseResult.data.code
    );

    return NextResponse.json(result, { status: result.status });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : "Internal error verifying OTP";
    return NextResponse.json(
      {
        success: false,
        error: { code: "INTERNAL_ERROR", message: errorMsg },
      },
      { status: 500 }
    );
  }
}
