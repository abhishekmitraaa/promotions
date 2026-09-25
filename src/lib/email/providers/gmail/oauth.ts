/**
 * Google OAuth 2.0 Server-Side Integration
 *
 * Implements the authorization code flow, credential exchange,
 * and automated provider onboarding for Google Workspace / Gmail.
 */

import crypto from "crypto";
import { prisma } from "../../../prisma";
import { encryptProviderCredential } from "../../../crypto";
import { EmailProviderStatus, EmailProviderType } from "@prisma/client";
import { GMAIL_SEND_SCOPE, GOOGLE_TOKEN_ENDPOINT } from "./gmail-provider";

export const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_USERINFO_ENDPOINT = "https://www.googleapis.com/oauth2/v2/userinfo";

export interface GoogleAuthUrlOptions {
  googleClientId: string;
  redirectUri: string;
  tenantId: string;
  stateSecret?: string;
}

export interface ExchangeCodeOptions {
  code: string;
  googleClientId: string;
  googleClientSecret: string;
  redirectUri: string;
  fetchFn?: typeof fetch;
}

export interface GoogleTokensResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scope: string;
  email: string;
}

/**
 * Creates a signed state token encoding tenant information to protect against CSRF.
 */
export function createOAuthState(tenantId: string, secret?: string): string {
  const pepper = secret || process.env.AUTH_SESSION_SECRET || "default_oauth_state_secret_32_chars!";
  const payload = JSON.stringify({
    tenantId,
    timestamp: Date.now(),
    nonce: crypto.randomBytes(16).toString("hex"),
  });
  const hmac = crypto.createHmac("sha256", pepper).update(payload).digest("hex");
  return `${Buffer.from(payload).toString("base64url")}.${hmac}`;
}

/**
 * Validates the signed OAuth state token and extracts the tenant ID.
 */
export function verifyOAuthState(stateString: string, secret?: string): { valid: boolean; tenantId?: string } {
  if (!stateString || !stateString.includes(".")) return { valid: false };
  const [b64Payload, signature] = stateString.split(".");
  const pepper = secret || process.env.AUTH_SESSION_SECRET || "default_oauth_state_secret_32_chars!";

  try {
    const rawPayload = Buffer.from(b64Payload, "base64url").toString("utf8");
    const expectedHmac = crypto.createHmac("sha256", pepper).update(rawPayload).digest("hex");

    if (!crypto.timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expectedHmac, "hex"))) {
      return { valid: false };
    }

    const parsed = JSON.parse(rawPayload);
    // 15-minute validity window for OAuth initiation
    if (Date.now() - parsed.timestamp > 15 * 60 * 1000) {
      return { valid: false };
    }

    return { valid: true, tenantId: parsed.tenantId };
  } catch {
    return { valid: false };
  }
}

/**
 * Generates the Google OAuth 2.0 authorization URL.
 * Requests offline access with prompt=consent to ensure a refresh token is returned.
 */
export function generateGoogleAuthUrl(options: GoogleAuthUrlOptions): string {
  const state = createOAuthState(options.tenantId, options.stateSecret);

  const params = new URLSearchParams({
    client_id: options.googleClientId,
    redirect_uri: options.redirectUri,
    response_type: "code",
    scope: `${GMAIL_SEND_SCOPE} https://www.googleapis.com/auth/userinfo.email`,
    access_type: "offline",
    prompt: "consent",
    state,
  });

  return `${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`;
}

/**
 * Exchanges the authorization code for refresh and access tokens.
 */
export async function exchangeGoogleAuthCode(options: ExchangeCodeOptions): Promise<GoogleTokensResult> {
  const fetchFn = options.fetchFn || fetch;

  const params = new URLSearchParams({
    code: options.code,
    client_id: options.googleClientId,
    client_secret: options.googleClientSecret,
    redirect_uri: options.redirectUri,
    grant_type: "authorization_code",
  });

  const response = await fetchFn(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`Google token exchange failed (${response.status}): ${errText}`);
  }

  const tokenData = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope: string;
  };

  if (!tokenData.refresh_token) {
    throw new Error("Google did not return a refresh token. Ensure prompt=consent and access_type=offline were used.");
  }

  // Obtain verified sender email
  const userinfoRes = await fetchFn(GOOGLE_USERINFO_ENDPOINT, {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });

  let verifiedEmail = "";
  if (userinfoRes.ok) {
    const userInfo = (await userinfoRes.json()) as { email?: string };
    verifiedEmail = userInfo.email || "";
  }

  if (!verifiedEmail) {
    throw new Error("Unable to verify Google account email address during OAuth callback");
  }

  return {
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token,
    expiresIn: tokenData.expires_in,
    scope: tokenData.scope,
    email: verifiedEmail,
  };
}

/**
 * Encrypts tokens and persists an active Gmail provider configuration and verified sender identity.
 */
export async function setupGmailProvider(options: {
  tenantId: string;
  googleClientId: string;
  googleClientSecret: string;
  refreshToken: string;
  senderEmail: string;
  senderName?: string;
  isDefault?: boolean;
}) {
  const credentialsPayload = JSON.stringify({
    clientId: options.googleClientId,
    clientSecret: options.googleClientSecret,
    refreshToken: options.refreshToken,
    senderEmail: options.senderEmail,
  });

  const encryptedCredentials = encryptProviderCredential(credentialsPayload);
  const encryptedOAuthRefreshToken = encryptProviderCredential(options.refreshToken);

  // If set to default, clear previous default
  if (options.isDefault) {
    await prisma.emailProviderConfig.updateMany({
      where: { clientId: options.tenantId, isDefault: true },
      data: { isDefault: false },
    });
  }

  // 1. Create or update EmailProviderConfig
  const config = await prisma.emailProviderConfig.create({
    data: {
      clientId: options.tenantId,
      name: `Google Workspace (${options.senderEmail})`,
      providerType: EmailProviderType.GMAIL,
      status: EmailProviderStatus.ACTIVE,
      isDefault: options.isDefault ?? true,
      senderEmail: options.senderEmail,
      senderName: options.senderName || options.senderEmail,
      encryptedCredentials,
      encryptedOAuthRefreshToken,
      lastVerifiedAt: new Date(),
    },
  });

  // 2. Upsert verified EmailSenderIdentity
  const identity = await prisma.emailSenderIdentity.upsert({
    where: {
      clientId_email: {
        clientId: options.tenantId,
        email: options.senderEmail.toLowerCase(),
      },
    },
    update: {
      verified: true,
      verifiedAt: new Date(),
      providerConfigId: config.id,
      name: options.senderName || undefined,
      isDefault: options.isDefault ?? true,
    },
    create: {
      clientId: options.tenantId,
      email: options.senderEmail.toLowerCase(),
      name: options.senderName || undefined,
      verified: true,
      verifiedAt: new Date(),
      providerConfigId: config.id,
      isDefault: options.isDefault ?? true,
    },
  });

  return { config, identity };
}
