import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  verifyAndConsumeOAuthState,
  exchangeGoogleAuthCode,
  setupGmailProvider,
} from "@/lib/email/providers/gmail/oauth";

function handleCallbackResponse(
  req: NextRequest,
  outcome:
    | { success: true; data: Record<string, unknown> }
    | { success: false; error: string; status: number }
) {
  const wantsJson =
    req.headers.get("accept")?.includes("application/json") ||
    new URL(req.url).searchParams.get("format") === "json";

  if (wantsJson) {
    if (outcome.success) {
      return NextResponse.json({ success: true, data: outcome.data });
    } else {
      return NextResponse.json(
        { success: false, error: outcome.error },
        { status: outcome.status }
      );
    }
  }

  // Browser redirect flow to dashboard providers page
  const baseUrl = new URL("/dashboard/email/providers", req.url);
  if (outcome.success) {
    baseUrl.searchParams.set("status", "success");
    if (outcome.data.senderEmail) {
      baseUrl.searchParams.set("provider", String(outcome.data.senderEmail));
    }
  } else {
    baseUrl.searchParams.set("status", "error");
    baseUrl.searchParams.set("message", outcome.error);
  }
  return NextResponse.redirect(baseUrl);
}

/**
 * GET Handler for Google OAuth 2.0 Browser Redirect Callback.
 * Google redirects the user's browser here with authorization code and state (or error).
 */
export async function GET(req: NextRequest) {
  // Only ADMIN can complete Google OAuth connection
  const auth = await requireUser(req, "ADMIN");
  if (auth.response) {
    const wantsJson =
      req.headers.get("accept")?.includes("application/json") ||
      new URL(req.url).searchParams.get("format") === "json";
    if (wantsJson) return auth.response;

    const errMsg = auth.user
      ? "Admin role required to connect email providers"
      : "Authentication required to connect email providers";
    return NextResponse.redirect(
      new URL(`/dashboard/email/providers?status=error&message=${encodeURIComponent(errMsg)}`, req.url)
    );
  }

  const { searchParams } = new URL(req.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const error = searchParams.get("error");
  const errorDescription = searchParams.get("error_description");

  // 1. Handle OAuth Denial from Google consent screen
  if (error) {
    const message = `Google authorization denied: ${error}${errorDescription ? ` (${errorDescription})` : ""}`;
    return handleCallbackResponse(req, { success: false, error: message, status: 400 });
  }

  // 2. Validate presence of code and state
  if (!code || !state) {
    return handleCallbackResponse(req, {
      success: false,
      error: "Both 'code' and 'state' are required for OAuth callback",
      status: 400,
    });
  }

  // 3. Verify and atomically consume the one-time CSRF/transaction state
  const stateCheck = verifyAndConsumeOAuthState(state, auth.user.id);
  if (!stateCheck.valid || !stateCheck.tenantId) {
    let message = "Invalid or expired OAuth state parameter";
    let status = 403;

    if (stateCheck.reason === "EXPIRED") {
      message = "OAuth state has expired. Please initiate connection again.";
    } else if (stateCheck.reason === "REPLAYED") {
      message = "OAuth state has already been used. Please initiate a new connection.";
      status = 409;
    } else if (stateCheck.reason === "ADMIN_MISMATCH" || stateCheck.reason === "TENANT_MISMATCH") {
      message = "Cross-tenant or cross-session OAuth completion forbidden: Admin user does not match the initiating session.";
    } else if (stateCheck.reason === "MALFORMED" || stateCheck.reason === "INVALID_SIGNATURE") {
      message = "Invalid or tampered OAuth state parameter.";
    }

    return handleCallbackResponse(req, { success: false, error: message, status });
  }

  // 4. Ensure tenant exists
  const tenant = await prisma.apiClient.findUnique({ where: { id: stateCheck.tenantId } });
  if (!tenant) {
    return handleCallbackResponse(req, {
      success: false,
      error: `ApiClient '${stateCheck.tenantId}' not found`,
      status: 404,
    });
  }

  const googleClientId = searchParams.get("googleClientId") || process.env.GMAIL_CLIENT_ID;
  const googleClientSecret = searchParams.get("googleClientSecret") || process.env.GMAIL_CLIENT_SECRET;
  const redirectUri =
    searchParams.get("redirectUri") ||
    `${process.env.APP_URL || new URL(req.url).origin}/api/admin/email/providers/google/callback`;

  if (!googleClientId || !googleClientSecret) {
    return handleCallbackResponse(req, {
      success: false,
      error: "Google OAuth client ID and client secret are required",
      status: 500,
    });
  }

  try {
    // 5. Exchange code for tokens (with authoritative email lookup)
    const tokens = await exchangeGoogleAuthCode({
      code,
      googleClientId,
      googleClientSecret,
      redirectUri,
    });

    // 6. Encrypt & persist provider configuration & verified identity
    const result = await setupGmailProvider({
      tenantId: stateCheck.tenantId,
      googleClientId,
      googleClientSecret,
      refreshToken: tokens.refreshToken,
      senderEmail: tokens.email,
      isDefault: true,
    });

    return handleCallbackResponse(req, {
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
    return handleCallbackResponse(req, { success: false, error: msg, status: 502 });
  }
}

/**
 * POST Handler for programmatic / API-level OAuth callback completion.
 */
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

    // 1. Verify and atomically consume the one-time state
    const stateCheck = verifyAndConsumeOAuthState(state, auth.user.id);
    if (!stateCheck.valid || !stateCheck.tenantId) {
      let status = 403;
      if (stateCheck.reason === "REPLAYED") status = 409;
      return NextResponse.json(
        { success: false, error: `Invalid or expired OAuth state parameter (${stateCheck.reason || "FAILED"})` },
        { status }
      );
    }

    const clientId = googleClientId || process.env.GMAIL_CLIENT_ID;
    const clientSecret = googleClientSecret || process.env.GMAIL_CLIENT_SECRET;
    const finalRedirectUri =
      redirectUri ||
      `${process.env.APP_URL || new URL(req.url).origin}/api/admin/email/providers/google/callback`;

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
