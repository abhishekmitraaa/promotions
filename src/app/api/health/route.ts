import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { isMetaConfigured } from "@/lib/env";

export async function GET() {
  let dbStatus = "connected";
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    dbStatus = "error";
  }

  const metaConfigured = isMetaConfigured();

  return NextResponse.json(
    {
      status: dbStatus === "connected" ? "ok" : "degraded",
      timestamp: new Date().toISOString(),
      services: {
        database: dbStatus,
        metaCloudApi: metaConfigured ? "configured" : "unconfigured",
      },
    },
    { status: dbStatus === "connected" ? 200 : 503 }
  );
}
