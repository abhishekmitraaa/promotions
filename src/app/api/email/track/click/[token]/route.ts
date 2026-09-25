import { NextRequest, NextResponse } from "next/server";
import { EmailTrackingService } from "@/lib/email/tracking/email-tracking-service";

interface RouteParams {
  params: Promise<{ token: string }>;
}

export async function GET(req: NextRequest, { params }: RouteParams) {
  const { token } = await params;

  if (!token) {
    return NextResponse.json(
      {
        success: false,
        error: { code: "BAD_REQUEST", message: "Tracking token is required" },
      },
      { status: 400 }
    );
  }

  // 1. Verify token signature, expiration, and authenticated destination URL
  const verification = EmailTrackingService.verifyClickToken(token);

  if (!verification.valid || !verification.targetUrl || !verification.deliveryId) {
    return NextResponse.json(
      {
        success: false,
        error: {
          code: "INVALID_TOKEN",
          message: verification.error || "Invalid, expired, or unsafe tracking token",
        },
      },
      { status: 400 }
    );
  }

  // 2. Strict Open-Redirect Defense: Validate destination URL again
  try {
    EmailTrackingService.validateTargetUrl(verification.targetUrl);
  } catch (urlErr) {
    const msg = urlErr instanceof Error ? urlErr.message : "Prohibited destination URL";
    return NextResponse.json(
      {
        success: false,
        error: { code: "PROHIBITED_DESTINATION", message: msg },
      },
      { status: 400 }
    );
  }

  // 3. Record click event
  const ip = req.headers.get("x-forwarded-for") || req.headers.get("x-real-ip") || undefined;
  const userAgent = req.headers.get("user-agent") || undefined;

  EmailTrackingService.recordClick(
    verification.deliveryId,
    verification.targetUrl,
    { ip, userAgent }
  ).catch(() => {
    // Non-fatal
  });

  // 4. Safe 302 Redirect to authenticated destination URL
  return NextResponse.redirect(verification.targetUrl, 302);
}
