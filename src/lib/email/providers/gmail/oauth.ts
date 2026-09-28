/**
 * Google OAuth 2.0 Server-Side Integration
 *
 * Implements the authorization code flow, credential exchange,
 * and automated provider onboarding for Google Workspace / Gmail.
 */

import crypto from "crypto";
import { Redis } from "ioredis";
import { prisma } from "../../../prisma";
import { encryptProviderCredential, redactSecrets } from "../../../crypto";
import { EmailProviderStatus, EmailProviderType } from "@prisma/client";
import { GMAIL_SEND_SCOPE, GOOGLE_TOKEN_ENDPOINT } from "./gmail-provider";
import { getRedisConnection } from "../../queue/connection";
import { logger } from "../../../logger";

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
  nonce: string;
  tenantId: string;
  adminUserId?: string;
  createdAt: number;
  expiresAt: number;
  used: boolean;
  consumedAt?: number;
}

export type OAuthConsumeStatus = "OK" | "NOT_FOUND" | "ALREADY_USED" | "EXPIRED";

export interface OAuthConsumeResult {
  status: OAuthConsumeStatus;
  data?: OAuthTransaction;
}

export interface IOAuthTransactionStore {
  save(nonce: string, tx: OAuthTransaction): Promise<void>;
  get(nonce: string): Promise<OAuthTransaction | null>;
  consume(nonce: string, now?: number): Promise<OAuthConsumeResult>;
  clear(): Promise<void>;
}

const LUA_CONSUME_OAUTH_STATE = `
  local key = KEYS[1]
  local now = tonumber(ARGV[1])
  local raw = redis.call('GET', key)

  if not raw then
    return cjson.encode({ status = 'NOT_FOUND' })
  end

  local data = cjson.decode(raw)

  if data.used then
    return cjson.encode({ status = 'ALREADY_USED', data = data })
  end

  if data.expiresAt and now > data.expiresAt then
    return cjson.encode({ status = 'EXPIRED', data = data })
  end

  data.used = true
  data.consumedAt = now

  local ttl = redis.call('PTTL', key)
  local encoded = cjson.encode(data)
  if ttl > 0 then
    redis.call('PSETEX', key, ttl, encoded)
  else
    redis.call('SET', key, encoded)
  end

  return cjson.encode({ status = 'OK', data = data })
`;

/**
 * Distributed Redis-backed store for OAuth transactions.
 * Supports multi-instance deployments, serverless functions, and process restarts.
 * Uses atomic Lua script for single-use consumption and race condition prevention.
 */
export class RedisOAuthTransactionStore implements IOAuthTransactionStore {
  private client: Redis;
  private keyPrefix: string;

  constructor(client?: Redis, keyPrefix = "oauth:state:") {
    this.client = client || getRedisConnection();
    this.keyPrefix = keyPrefix;
  }

  private getKey(nonce: string): string {
    return `${this.keyPrefix}${nonce}`;
  }

  async save(nonce: string, tx: OAuthTransaction): Promise<void> {
    const key = this.getKey(nonce);
    const ttlMs = Math.max(1000, tx.expiresAt - Date.now());
    await this.client.psetex(key, ttlMs, JSON.stringify(tx));
  }

  async get(nonce: string): Promise<OAuthTransaction | null> {
    const key = this.getKey(nonce);
    const raw = await this.client.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as OAuthTransaction;
    } catch {
      return null;
    }
  }

  async consume(nonce: string, now: number = Date.now()): Promise<OAuthConsumeResult> {
    const key = this.getKey(nonce);
    const resRaw = (await this.client.eval(
      LUA_CONSUME_OAUTH_STATE,
      1,
      key,
      now
    )) as string;
    try {
      return JSON.parse(resRaw) as OAuthConsumeResult;
    } catch (err) {
      logger.error("[RedisOAuthTransactionStore] Failed to parse Lua consume result:", redactSecrets(String(err)));
      return { status: "NOT_FOUND" };
    }
  }

  async clear(): Promise<void> {
    const keys = await this.client.keys(`${this.keyPrefix}*`);
    if (keys.length > 0) {
      await this.client.del(...keys);
    }
  }
}

/**
 * In-memory fallback store for standalone testing or development without Redis.
 */
export class MemoryOAuthTransactionStore implements IOAuthTransactionStore {
  private store = new Map<string, OAuthTransaction>();

  async save(nonce: string, tx: OAuthTransaction): Promise<void> {
    const now = Date.now();
    for (const [k, v] of this.store.entries()) {
      if (now > v.expiresAt) {
        this.store.delete(k);
      }
    }
    this.store.set(nonce, tx);
  }

  async get(nonce: string): Promise<OAuthTransaction | null> {
    const tx = this.store.get(nonce);
    if (!tx) return null;
    if (Date.now() > tx.expiresAt) {
      this.store.delete(nonce);
      return null;
    }
    return tx;
  }

  async consume(nonce: string, now: number = Date.now()): Promise<OAuthConsumeResult> {
    const tx = this.store.get(nonce);
    if (!tx) return { status: "NOT_FOUND" };
    if (tx.used) return { status: "ALREADY_USED", data: tx };
    if (now > tx.expiresAt) {
      this.store.delete(nonce);
      return { status: "EXPIRED", data: tx };
    }
    tx.used = true;
    tx.consumedAt = now;
    return { status: "OK", data: tx };
  }

  async clear(): Promise<void> {
    this.store.clear();
  }
}

/**
 * Global shared registry for one-time OAuth transactions/nonces.
 * Delegates to Redis by default (or configured backend) for multi-instance production safety.
 */
export class OAuthTransactionStore {
  private static backend: IOAuthTransactionStore | null = null;

  static getBackend(): IOAuthTransactionStore {
    if (!this.backend) {
      try {
        this.backend = new RedisOAuthTransactionStore();
      } catch (err) {
        logger.warn("[OAuthTransactionStore] Redis connection unavailable, falling back to memory store:", redactSecrets(String(err)));
        this.backend = new MemoryOAuthTransactionStore();
      }
    }
    return this.backend;
  }

  static setBackend(store: IOAuthTransactionStore | null): void {
    this.backend = store;
  }

  static async save(nonce: string, tx: OAuthTransaction): Promise<void> {
    return this.getBackend().save(nonce, tx);
  }

  static async get(nonce: string): Promise<OAuthTransaction | null> {
    return this.getBackend().get(nonce);
  }

  static async consume(nonce: string, now?: number): Promise<OAuthConsumeResult> {
    return this.getBackend().consume(nonce, now);
  }

  static async clear(): Promise<void> {
    return this.getBackend().clear();
  }
}

/**
 * Creates a signed state token encoding tenant, admin, and one-time nonce information.
 * Persists the transaction in the durable shared store.
 */
export async function createOAuthState(
  tenantId: string,
  adminUserIdOrSecret?: string,
  secret?: string
): Promise<string> {
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

  // Register one-time transaction nonce into durable shared store
  await OAuthTransactionStore.save(nonce, {
    nonce,
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
 * Validates the signed OAuth state token and atomically consumes its one-time transaction nonce
 * from the shared durable store.
 * Prevents replay attacks, verifies HMAC signature, checks time expiration, and enforces tenant/admin binding.
 */
export async function verifyAndConsumeOAuthState(
  stateString: string,
  expectedAdminUserId?: string,
  secret?: string
): Promise<VerifyOAuthStateResult> {
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

    // Atomically consume nonce from shared durable store
    const consumeRes = await OAuthTransactionStore.consume(parsed.nonce);

    if (consumeRes.status === "NOT_FOUND") {
      return { valid: false, reason: "UNKNOWN_NONCE" };
    }

    if (consumeRes.status === "ALREADY_USED") {
      return { valid: false, reason: "REPLAYED" };
    }

    if (consumeRes.status === "EXPIRED") {
      return { valid: false, reason: "EXPIRED" };
    }

    const tx = consumeRes.data;
    if (!tx) {
      return { valid: false, reason: "UNKNOWN_NONCE" };
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
export async function verifyOAuthState(
  stateString: string,
  secret?: string
): Promise<{ valid: boolean; tenantId?: string; adminUserId?: string; reason?: string }> {
  return verifyAndConsumeOAuthState(stateString, undefined, secret);
}

/**
 * Generates the Google OAuth 2.0 authorization URL.
 * Requests offline access with prompt=consent to ensure a refresh token is returned.
 * Requests minimum scopes: gmail.send (dispatch only) and userinfo.email (verified address lookup).
 */
export async function generateGoogleAuthUrl(options: GoogleAuthUrlOptions): Promise<string> {
  const state = await createOAuthState(options.tenantId, options.adminUserId, options.stateSecret);

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
    throw new Error(`Google token exchange failed (${response.status}): ${redactSecrets(errText)}`);
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
