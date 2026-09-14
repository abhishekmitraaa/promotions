import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { generateApiKey } from "@/lib/crypto";

export async function GET() {
  try {
    const clients = await prisma.apiClient.findMany({
      include: {
        keys: {
          select: {
            id: true,
            name: true,
            keyPrefix: true,
            lastUsedAt: true,
            expiresAt: true,
            revokedAt: true,
            createdAt: true,
          },
          orderBy: { createdAt: "desc" },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json({ success: true, data: clients });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error listing API clients";
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const clientName = body.clientName?.trim();
    const keyName = body.keyName?.trim() || "Default Key";
    const description = body.description?.trim();

    if (!clientName) {
      return NextResponse.json(
        { success: false, error: "Client name is required" },
        { status: 400 }
      );
    }

    // 1. Find or create ApiClient
    let client = await prisma.apiClient.findFirst({
      where: { name: clientName },
    });

    if (!client) {
      client = await prisma.apiClient.create({
        data: {
          name: clientName,
          description,
        },
      });
    }

    // 2. Generate new API key
    const { rawKey, keyPrefix, keyHash } = generateApiKey();

    // 3. Save ApiKey record
    const apiKeyRecord = await prisma.apiKey.create({
      data: {
        clientId: client.id,
        name: keyName,
        keyPrefix,
        keyHash,
      },
    });

    return NextResponse.json({
      success: true,
      data: {
        clientId: client.id,
        clientName: client.name,
        keyId: apiKeyRecord.id,
        keyName: apiKeyRecord.name,
        keyPrefix: apiKeyRecord.keyPrefix,
        rawKey, // RAW KEY IS ONLY RETURNED ONCE HERE
        createdAt: apiKeyRecord.createdAt,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error creating API key";
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
