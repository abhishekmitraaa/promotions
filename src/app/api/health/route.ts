import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { isMetaConfigured } from "@/lib/env";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const probe = searchParams.get("probe");

  // Pure liveness probe: does not touch database, ultra fast (for Kubernetes/load balancers)
  if (probe === "live") {
    return NextResponse.json(
      {
        status: "ok",
        uptimeSeconds: Math.floor(process.uptime()),
        timestamp: new Date().toISOString(),
      },
      { status: 200 }
    );
  }

  // Deep readiness probe
  let dbStatus: "connected" | "disconnected" = "connected";
  let pendingDeliveries = 0;

  try {
    await prisma.$queryRaw`SELECT 1`;
    pendingDeliveries = await prisma.webhookDelivery.count({
      where: { status: "PENDING" },
    });
  } catch {
    dbStatus = "disconnected";
  }

  const metaConfigured = isMetaConfigured();
  const isHealthy = dbStatus === "connected";

  return NextResponse.json(
    {
      status: isHealthy ? "ok" : "degraded",
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
      services: {
        database: dbStatus,
        metaCloudApi: metaConfigured ? "configured" : "unconfigured",
        webhookQueue: {
          pendingCount: pendingDeliveries,
        },
      },
    },
    { status: isHealthy ? 200 : 503 }
  );
}
