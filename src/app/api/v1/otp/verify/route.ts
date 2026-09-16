import { NextRequest, NextResponse } from "next/server";
import { authenticateApiKey } from "@/lib/api-auth";
import { verifyOtpSchema } from "@/lib/validation/otp";
import { OtpService } from "@/lib/services/otp-service";
import { checkRateLimit } from "@/lib/rate-limit";
import { normalizePhoneNumber } from "@/lib/crypto";

export async function POST(req: NextRequest) {
  const auth = await authenticateApiKey(req);
  if (!auth.authenticated || !auth.clientId) return auth.errorResponse!;

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

  // Layered distributed rate limiting:
  // 1. Per normalized destination phone (10 attempts / 60s)
  const normalizedPhone = normalizePhoneNumber(parseResult.data.to);
  const phoneRateLimit = await checkRateLimit(`otp_ver_phone_${normalizedPhone}`, 10, 60000);
  if (!phoneRateLimit.success) {
    return NextResponse.json(
      {
        success: false,
        error: {
          code: "RATE_LIMITED",
          message: `Too many OTP verification attempts for this phone number. Please wait ${phoneRateLimit.resetSeconds} seconds.`,
        },
      },
      {
        status: 429,
        headers: { "Retry-After": String(phoneRateLimit.resetSeconds) },
      }
    );
  }

  // 2. Per API Client tenant (200 attempts / 60s)
  const clientRateLimit = await checkRateLimit(`otp_ver_client_${auth.clientId}`, 200, 60000);
  if (!clientRateLimit.success) {
    return NextResponse.json(
      {
        success: false,
        error: {
          code: "RATE_LIMITED",
          message: `Client OTP verification attempt limit reached. Please wait ${clientRateLimit.resetSeconds} seconds.`,
        },
      },
      {
        status: 429,
        headers: { "Retry-After": String(clientRateLimit.resetSeconds) },
      }
    );
  }

  // 3. Per caller IP if present (30 attempts / 60s)
  const clientIp = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip");
  if (clientIp) {
    const ipRateLimit = await checkRateLimit(`otp_ver_ip_${clientIp}`, 30, 60000);
    if (!ipRateLimit.success) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: "RATE_LIMITED",
            message: `Too many verification attempts from your IP. Please wait ${ipRateLimit.resetSeconds} seconds.`,
          },
        },
        {
          status: 429,
          headers: { "Retry-After": String(ipRateLimit.resetSeconds) },
        }
      );
    }
  }

  try {
    const result = await OtpService.verifyOtp(
      auth.clientId,
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
