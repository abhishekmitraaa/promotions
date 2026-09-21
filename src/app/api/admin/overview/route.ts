import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isMetaConfigured } from "@/lib/env";
import { MessageDirection, MessageStatus } from "@prisma/client";

export async function GET(req: NextRequest) {
  const auth = await requireUser(req);
  if (auth.response) return auth.response;
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
      data: {
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
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error loading dashboard overview";
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
