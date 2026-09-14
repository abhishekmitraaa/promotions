import { NextRequest, NextResponse } from "next/server";
import { authenticateApiKey } from "@/lib/api-auth";
import { requestOtpSchema } from "@/lib/validation/otp";
import { OtpService } from "@/lib/services/otp-service";

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

  try {
    const result = await OtpService.requestOtp(
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
