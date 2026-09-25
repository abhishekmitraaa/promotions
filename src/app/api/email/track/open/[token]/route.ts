import { NextRequest, NextResponse } from "next/server";
import { EmailTrackingService } from "@/lib/email/tracking/email-tracking-service";

interface RouteParams {
  params: Promise<{ token: string }>;
}

/**
 * Open Tracking Pixel Endpoint
 *
 * NOTE: Email open tracking relies on image rendering signals. Opens may not
 * accurately represent genuine human opens due to automatic image pre-fetching by
 * email security appliances, privacy proxies (such as Apple Mail Privacy Protection),
 * or client applications disabling remote image rendering.
 */
export async function GET(req: NextRequest, { params }: RouteParams) {
  const { token } = await params;
  const pixel = EmailTrackingService.getTransparentPixelBuffer();

  const responseHeaders = {
    "Content-Type": "image/gif",
    "Content-Length": String(pixel.length),
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0",
    Pragma: "no-cache",
    Expires: "0",
  };

  if (!token) {
    return new NextResponse(new Uint8Array(pixel), { status: 200, headers: responseHeaders });
  }

  const verification = EmailTrackingService.verifyOpenToken(token);

  if (verification.valid && verification.deliveryId) {
    const ip = req.headers.get("x-forwarded-for") || req.headers.get("x-real-ip") || undefined;
    const userAgent = req.headers.get("user-agent") || undefined;

    // Record open asynchronously
    EmailTrackingService.recordOpen(verification.deliveryId, { ip, userAgent }).catch(() => {
      // Non-fatal
    });
  }

  return new NextResponse(new Uint8Array(pixel), {
    status: 200,
    headers: responseHeaders,
  });
}
