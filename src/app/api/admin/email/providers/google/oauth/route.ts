import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { generateGoogleAuthUrl } from "@/lib/email/providers/gmail/oauth";

export async function GET(req: NextRequest) {
  // Only ADMIN can initiate Google OAuth connection
  const auth = await requireUser(req, "ADMIN");
  if (auth.response) return auth.response;

  try {
    const { searchParams } = new URL(req.url);
    const clientId = searchParams.get("clientId");
    const googleClientId = searchParams.get("googleClientId") || process.env.GMAIL_CLIENT_ID;
    const redirectUri =
      searchParams.get("redirectUri") ||
      `${process.env.APP_URL || "http://localhost:3000"}/api/admin/email/providers/google/callback`;

    if (!clientId) {
      return NextResponse.json({ success: false, error: "clientId is required" }, { status: 400 });
    }

    if (!googleClientId) {
      return NextResponse.json(
        { success: false, error: "googleClientId is required (either in query param or GMAIL_CLIENT_ID env)" },
        { status: 400 }
      );
    }

    // Verify tenant exists
    const tenant = await prisma.apiClient.findUnique({ where: { id: clientId } });
    if (!tenant) {
      return NextResponse.json({ success: false, error: "ApiClient not found" }, { status: 404 });
    }

    const authUrl = generateGoogleAuthUrl({
      googleClientId,
      redirectUri,
      tenantId: clientId,
    });

    return NextResponse.json({
      success: true,
      data: {
        authUrl,
        redirectUri,
        tenantId: clientId,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error initiating Google OAuth";
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
