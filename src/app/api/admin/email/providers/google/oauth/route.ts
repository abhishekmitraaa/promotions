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
    let clientId = searchParams.get("clientId");
    const googleClientId = searchParams.get("googleClientId") || process.env.GMAIL_CLIENT_ID;
    const redirectUri =
      searchParams.get("redirectUri") ||
      `${process.env.APP_URL || new URL(req.url).origin}/api/admin/email/providers/google/callback`;

    // Resolve tenant: explicit clientId param or fallback to default registered client
    if (!clientId) {
      const defaultClient = await prisma.apiClient.findFirst({ orderBy: { createdAt: "asc" } });
      if (defaultClient) {
        clientId = defaultClient.id;
      }
    }

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
      adminUserId: auth.user.id,
    });

    const wantsJson =
      req.headers.get("accept")?.includes("application/json") ||
      searchParams.get("format") === "json";

    // If browser navigates directly without requesting JSON, perform HTTP redirect to Google
    if (!wantsJson && req.headers.get("accept")?.includes("text/html")) {
      return NextResponse.redirect(authUrl);
    }

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
