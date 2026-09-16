import { NextRequest, NextResponse } from "next/server";
import { authenticateApiKey } from "@/lib/api-auth";
import { requestOtpSchema } from "@/lib/validation/otp";
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

  const parseResult = requestOtpSchema.safeParse(bodyJson);
  if (!parseResult.success) {
    return NextResponse.json(
      {
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "OTP request validation failed",
          details: parseResult.error.format(),
        },
      },
      { status: 400 }
    );
  }

  // Layered distributed rate limiting:
  // 1. Per normalized destination phone (5 req / 60s)
  const normalizedPhone = normalizePhoneNumber(parseResult.data.to);
  const phoneRateLimit = await checkRateLimit(`otp_req_phone_${normalizedPhone}`, 5, 60000);
  if (!phoneRateLimit.success) {
    return NextResponse.json(
      {
        success: false,
        error: {
          code: "RATE_LIMITED",
          message: `Too many OTP requests for this phone number. Please wait ${phoneRateLimit.resetSeconds} seconds.`,
        },
      },
      {
        status: 429,
        headers: { "Retry-After": String(phoneRateLimit.resetSeconds) },
      }
    );
  }

  // 2. Per API Client tenant (100 req / 60s)
  const clientRateLimit = await checkRateLimit(`otp_req_client_${auth.clientId}`, 100, 60000);
  if (!clientRateLimit.success) {
    return NextResponse.json(
      {
        success: false,
        error: {
          code: "RATE_LIMITED",
          message: `Client OTP request limit reached. Please wait ${clientRateLimit.resetSeconds} seconds.`,
        },
      },
      {
        status: 429,
        headers: { "Retry-After": String(clientRateLimit.resetSeconds) },
      }
    );
  }

  // 3. Per caller IP if present (20 req / 60s)
  const clientIp = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip");
  if (clientIp) {
    const ipRateLimit = await checkRateLimit(`otp_req_ip_${clientIp}`, 20, 60000);
    if (!ipRateLimit.success) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: "RATE_LIMITED",
            message: `Too many requests from your IP. Please wait ${ipRateLimit.resetSeconds} seconds.`,
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
    const result = await OtpService.requestOtp(
      auth.clientId,
      parseResult.data.to,
      parseResult.data.purpose
    );

    return NextResponse.json(result, { status: result.status });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : "Internal error requesting OTP";
    return NextResponse.json(
      {
        success: false,
        error: { code: "INTERNAL_ERROR", message: errorMsg },
      },
      { status: 500 }
    );
  }
}
