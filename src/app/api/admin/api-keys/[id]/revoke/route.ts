import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const updated = await prisma.apiKey.update({
      where: { id },
      data: { revokedAt: new Date() },
    });

    return NextResponse.json({ success: true, key: updated });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error revoking API key";
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
