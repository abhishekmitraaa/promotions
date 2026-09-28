import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { getProductionMetricsSnapshot, getPrometheusMetrics } from "@/lib/email/queue/metrics";

export async function GET(req: NextRequest) {
  // Requires authenticated admin or viewer
  const auth = await requireUser(req);
  if (auth.response) return auth.response;

  try {
    const format = req.nextUrl.searchParams.get("format");
    const acceptHeader = req.headers.get("accept") || "";

    if (format === "prometheus" || acceptHeader.includes("text/plain")) {
      const prometheusData = await getPrometheusMetrics();
      return new NextResponse(prometheusData, {
        status: 200,
        headers: {
          "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
        },
      });
    }

    const snapshot = await getProductionMetricsSnapshot();
    return NextResponse.json({
      success: true,
      data: snapshot,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Failed to generate metrics";
    return NextResponse.json(
      { success: false, error: msg },
      { status: 500 }
    );
  }
}
