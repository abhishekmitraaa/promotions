import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { getEmailQueueHealth } from "@/lib/email/queue/health";

export async function GET(req: NextRequest) {
  // Requires authenticated admin or viewer
  const auth = await requireUser(req);
  if (auth.response) return auth.response;

  try {
    const health = await getEmailQueueHealth();
    const httpStatus = health.status === "DOWN" ? 503 : 200;
    return NextResponse.json({ success: true, data: health }, { status: httpStatus });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to retrieve queue health";
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
