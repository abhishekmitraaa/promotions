import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import {
  verifyOAuthState,
  exchangeGoogleAuthCode,
  setupGmailProvider,
} from "@/lib/email/providers/gmail/oauth";

export async function POST(req: NextRequest) {
  // Only ADMIN can complete Google OAuth connection
  const auth = await requireUser(req, "ADMIN");
  if (auth.response) return auth.response;

  try {
    const body = await req.json();
    const { code, state, redirectUri, googleClientId, googleClientSecret, isDefault } = body;

    if (!code || !state) {
      return NextResponse.json(
        { success: false, error: "Both 'code' and 'state' are required for OAuth callback" },
        { status: 400 }
      );
    }

    // 1. Verify CSRF State
    const stateCheck = verifyOAuthState(state);
    if (!stateCheck.valid || !stateCheck.tenantId) {
      return NextResponse.json(
        { success: false, error: "Invalid or expired OAuth state parameter" },
        { status: 403 }
      );
    }

    const clientId = googleClientId || process.env.GMAIL_CLIENT_ID;
    const clientSecret = googleClientSecret || process.env.GMAIL_CLIENT_SECRET;
    const finalRedirectUri =
      redirectUri ||
      `${process.env.APP_URL || "http://localhost:3000"}/api/admin/email/providers/google/callback`;

    if (!clientId || !clientSecret) {
      return NextResponse.json(
        { success: false, error: "Google OAuth client ID and client secret are required" },
        { status: 400 }
      );
    }

    // 2. Exchange authorization code for tokens
    const tokens = await exchangeGoogleAuthCode({
      code,
      googleClientId: clientId,
      googleClientSecret: clientSecret,
      redirectUri: finalRedirectUri,
    });

    // 3. Encrypt and persist provider configuration & verified identity
    const result = await setupGmailProvider({
      tenantId: stateCheck.tenantId,
      googleClientId: clientId,
      googleClientSecret: clientSecret,
      refreshToken: tokens.refreshToken,
      senderEmail: tokens.email,
      isDefault: isDefault ?? true,
    });

    return NextResponse.json({
      success: true,
      data: {
        providerId: result.config.id,
        senderEmail: result.config.senderEmail,
        status: result.config.status,
        verifiedIdentityId: result.identity.id,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error handling Google OAuth callback";
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
