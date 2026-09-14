import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { isMetaConfigured } from "@/lib/env";
import { MessageDirection, MessageStatus } from "@prisma/client";

export async function GET() {
  try {
    const [totalMessages, outboundCount, inboundCount, failedCount, recentMessages] =
      await Promise.all([
        prisma.message.count(),
        prisma.message.count({ where: { direction: MessageDirection.OUTBOUND } }),
        prisma.message.count({ where: { direction: MessageDirection.INBOUND } }),
        prisma.message.count({ where: { status: MessageStatus.FAILED } }),
        prisma.message.findMany({
          orderBy: { createdAt: "desc" },
          take: 10,
        }),
      ]);

    let dbStatus = "healthy";
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch {
      dbStatus = "error";
    }

    return NextResponse.json({
      success: true,
      stats: {
        totalMessages,
        outboundCount,
        inboundCount,
        failedCount,
      },
      health: {
        database: dbStatus,
        metaCloudApi: isMetaConfigured() ? "configured" : "unconfigured",
      },
      recentMessages,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error loading dashboard overview";
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
