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
  adminUserId?: string;
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

export interface OAuthTransaction {
  tenantId: string;
  adminUserId?: string;
  createdAt: number;
  expiresAt: number;
  used: boolean;
}

/**
 * In-memory registry for one-time OAuth transactions/nonces.
 * Provides replay protection, tenant binding, and admin session verification.
 */
export class OAuthTransactionStore {
  private static store = new Map<string, OAuthTransaction>();

  static save(nonce: string, tx: OAuthTransaction): void {
    // Purge expired entries on each write
    const now = Date.now();
    for (const [key, val] of this.store.entries()) {
      if (now > val.expiresAt) {
        this.store.delete(key);
      }
    }
    this.store.set(nonce, tx);
  }

  static get(nonce: string): OAuthTransaction | undefined {
    return this.store.get(nonce);
  }

  static consume(nonce: string): boolean {
    const tx = this.store.get(nonce);
    if (!tx || tx.used) return false;
    tx.used = true;
    return true;
  }

  static clear(): void {
    this.store.clear();
  }
}

/**
 * Creates a signed state token encoding tenant, admin, and one-time nonce information.
 * Backward compatible with createOAuthState(tenantId, secret) from Phase 2.
 */
export function createOAuthState(
  tenantId: string,
  adminUserIdOrSecret?: string,
  secret?: string
): string {
  let adminUserId: string | undefined;
  let signingSecret: string | undefined;

  if (secret !== undefined) {
    adminUserId = adminUserIdOrSecret;
    signingSecret = secret;
  } else if (adminUserIdOrSecret !== undefined) {
    // If only 2 arguments are provided:
    // If it looks like a secret (length >= 20 or contains "secret"), treat as secret for Phase 2 backward compatibility
    if (adminUserIdOrSecret.length >= 20 || adminUserIdOrSecret.includes("secret")) {
      signingSecret = adminUserIdOrSecret;
    } else {
      adminUserId = adminUserIdOrSecret;
      signingSecret = process.env.AUTH_SESSION_SECRET;
    }
  }

  const pepper = signingSecret || process.env.AUTH_SESSION_SECRET || "default_oauth_state_secret_32_chars!";
  const nonce = crypto.randomBytes(24).toString("hex");
  const timestamp = Date.now();
  const ttlMs = 15 * 60 * 1000; // 15-minute validity

  // Register one-time transaction nonce
  OAuthTransactionStore.save(nonce, {
    tenantId,
    adminUserId,
    createdAt: timestamp,
    expiresAt: timestamp + ttlMs,
    used: false,
  });

  const payload = JSON.stringify({
    tenantId,
    adminUserId,
    timestamp,
    nonce,
  });
  const hmac = crypto.createHmac("sha256", pepper).update(payload).digest("hex");
  return `${Buffer.from(payload).toString("base64url")}.${hmac}`;
}

export type OAuthStateFailureReason =
  | "MALFORMED"
  | "INVALID_SIGNATURE"
  | "EXPIRED"
  | "UNKNOWN_NONCE"
  | "REPLAYED"
  | "TENANT_MISMATCH"
  | "ADMIN_MISMATCH";

export interface VerifyOAuthStateResult {
  valid: boolean;
  tenantId?: string;
  adminUserId?: string;
  reason?: OAuthStateFailureReason;
}

/**
 * Validates the signed OAuth state token and atomically consumes its one-time transaction nonce.
 * Prevents replay attacks, verifies HMAC signature, checks time expiration, and enforces tenant/admin binding.
 */
export function verifyAndConsumeOAuthState(
  stateString: string,
  expectedAdminUserId?: string,
  secret?: string
): VerifyOAuthStateResult {
  if (!stateString || typeof stateString !== "string" || !stateString.includes(".")) {
    return { valid: false, reason: "MALFORMED" };
  }
  const [b64Payload, signature] = stateString.split(".");
  if (!b64Payload || !signature) {
    return { valid: false, reason: "MALFORMED" };
  }

  const pepper = secret || process.env.AUTH_SESSION_SECRET || "default_oauth_state_secret_32_chars!";

  try {
    const rawPayload = Buffer.from(b64Payload, "base64url").toString("utf8");
    const expectedHmac = crypto.createHmac("sha256", pepper).update(rawPayload).digest("hex");

    if (
      signature.length !== expectedHmac.length ||
      !crypto.timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expectedHmac, "hex"))
    ) {
      return { valid: false, reason: "INVALID_SIGNATURE" };
    }

    const parsed = JSON.parse(rawPayload) as {
      tenantId?: string;
      adminUserId?: string;
      timestamp?: number;
      nonce?: string;
    };

    if (!parsed.tenantId || !parsed.timestamp || !parsed.nonce) {
      return { valid: false, reason: "MALFORMED" };
    }

    // 15-minute validity window for OAuth initiation
    if (Date.now() - parsed.timestamp > 15 * 60 * 1000) {
      return { valid: false, reason: "EXPIRED" };
    }

    // Look up one-time transaction in store
    const tx = OAuthTransactionStore.get(parsed.nonce);
    if (!tx) {
      return { valid: false, reason: "UNKNOWN_NONCE" };
    }

    if (tx.used) {
      return { valid: false, reason: "REPLAYED" };
    }

    if (Date.now() > tx.expiresAt) {
      return { valid: false, reason: "EXPIRED" };
    }

    if (tx.tenantId !== parsed.tenantId) {
      return { valid: false, reason: "TENANT_MISMATCH" };
    }

    // Enforce admin user binding if initiating user was recorded
    if (tx.adminUserId && expectedAdminUserId && tx.adminUserId !== expectedAdminUserId) {
      return { valid: false, reason: "ADMIN_MISMATCH" };
    }

    if (tx.adminUserId && parsed.adminUserId && tx.adminUserId !== parsed.adminUserId) {
      return { valid: false, reason: "ADMIN_MISMATCH" };
    }

    // Atomically consume nonce to prevent replay
    OAuthTransactionStore.consume(parsed.nonce);

    return {
      valid: true,
      tenantId: parsed.tenantId,
      adminUserId: parsed.adminUserId,
    };
  } catch {
    return { valid: false, reason: "MALFORMED" };
  }
}

/**
 * Validates the signed OAuth state token and extracts the tenant ID.
 * (Backward compatible wrapper for verifyAndConsumeOAuthState)
 */
export function verifyOAuthState(
  stateString: string,
  secret?: string
): { valid: boolean; tenantId?: string; adminUserId?: string; reason?: string } {
  return verifyAndConsumeOAuthState(stateString, undefined, secret);
}

/**
 * Generates the Google OAuth 2.0 authorization URL.
 * Requests offline access with prompt=consent to ensure a refresh token is returned.
 * Requests minimum scopes: gmail.send (dispatch only) and userinfo.email (verified address lookup).
 */
export function generateGoogleAuthUrl(options: GoogleAuthUrlOptions): string {
  const state = createOAuthState(options.tenantId, options.adminUserId, options.stateSecret);

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
