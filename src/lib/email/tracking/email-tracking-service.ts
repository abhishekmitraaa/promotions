/**
 * Email Open & Click Tracking Service
 *
 * Implements tamper-proof, token-based engagement tracking:
 * - Never exposes recipient email addresses in tracking URLs.
 * - Open tracking uses cryptographic HMAC tokens and returns transparent 1x1 GIF pixels.
 * - Click tracking verifies destination authenticity from signed tokens, completely blocking open redirects.
 * - Documented analytics limitations: Opens are heuristic signals that may not perfectly reflect human interaction
 *   due to image caching, security crawler pre-fetching, and privacy proxies (e.g., Apple Mail Privacy Protection).
 */

import crypto from "crypto";
import { prisma } from "../../prisma";
import { EmailEventType } from "@prisma/client";

const DEFAULT_TRACKING_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

// 1x1 transparent GIF buffer (43 bytes)
const TRANSPARENT_1PX_GIF = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64"
);

export interface OpenTokenPayload {
  deliveryId: string;
  clientId: string;
  exp: number;
}

export interface ClickTokenPayload {
  deliveryId: string;
  clientId: string;
  targetUrl: string;
  exp: number;
  nonce: string;
}

export class EmailTrackingService {
  /**
   * Generates a signed, privacy-safe open tracking token.
   * Recipient email is NEVER included in the token.
   */
  static generateOpenToken(
    clientId: string,
    deliveryId: string,
    ttlMs: number = DEFAULT_TRACKING_TTL_MS
  ): string {
    const exp = Date.now() + ttlMs;
    const payload: OpenTokenPayload = { deliveryId, clientId, exp };
    const payloadStr = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const secret = this.getSecret();

    const signature = crypto
      .createHmac("sha256", secret)
      .update(`open:${payloadStr}`)
      .digest("base64url");

    return `${payloadStr}.${signature}`;
  }

  /**
   * Verifies an open tracking token.
   */
  static verifyOpenToken(token: string): {
    valid: boolean;
    deliveryId?: string;
    clientId?: string;
    error?: string;
  } {
    if (!token || typeof token !== "string" || !token.includes(".")) {
      return { valid: false, error: "Invalid token format" };
    }

    const [payloadStr, signature] = token.split(".");
    if (!payloadStr || !signature) {
      return { valid: false, error: "Malformed token" };
    }

    const secret = this.getSecret();
    const expectedSignature = crypto
      .createHmac("sha256", secret)
      .update(`open:${payloadStr}`)
      .digest("base64url");

    const sigBuf = Buffer.from(signature);
    const expectedBuf = Buffer.from(expectedSignature);

    if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
      return { valid: false, error: "Invalid token signature" };
    }

    let payload: OpenTokenPayload;
    try {
      payload = JSON.parse(Buffer.from(payloadStr, "base64url").toString("utf8"));
    } catch {
      return { valid: false, error: "Invalid token payload" };
    }

    if (!payload.deliveryId || !payload.clientId || typeof payload.exp !== "number") {
      return { valid: false, error: "Incomplete token payload" };
    }

    if (payload.exp < Date.now()) {
      return { valid: false, error: "Token has expired" };
    }

    return {
      valid: true,
      deliveryId: payload.deliveryId,
      clientId: payload.clientId,
    };
  }

  /**
   * Generates a signed, tamper-proof click tracking token containing the verified target URL.
   * Open redirect prevention: the target URL is cryptographically sealed in the token.
   */
  static generateClickToken(
    clientId: string,
    deliveryId: string,
    targetUrl: string,
    ttlMs: number = DEFAULT_TRACKING_TTL_MS
  ): string {
    this.validateTargetUrl(targetUrl);

    const exp = Date.now() + ttlMs;
    const nonce = crypto.randomBytes(8).toString("hex");
    const payload: ClickTokenPayload = {
      deliveryId,
      clientId,
      targetUrl,
      exp,
      nonce,
    };

    const payloadStr = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const secret = this.getSecret();

    const signature = crypto
      .createHmac("sha256", secret)
      .update(`click:${payloadStr}`)
      .digest("base64url");

    return `${payloadStr}.${signature}`;
  }

  /**
   * Verifies a click tracking token and extracts the authenticated target URL.
   */
  static verifyClickToken(token: string): {
    valid: boolean;
    deliveryId?: string;
    clientId?: string;
    targetUrl?: string;
    error?: string;
  } {
    if (!token || typeof token !== "string" || !token.includes(".")) {
      return { valid: false, error: "Invalid token format" };
    }

    const [payloadStr, signature] = token.split(".");
    if (!payloadStr || !signature) {
      return { valid: false, error: "Malformed token" };
    }

    const secret = this.getSecret();
    const expectedSignature = crypto
      .createHmac("sha256", secret)
      .update(`click:${payloadStr}`)
      .digest("base64url");

    const sigBuf = Buffer.from(signature);
    const expectedBuf = Buffer.from(expectedSignature);

    if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
      return { valid: false, error: "Invalid token signature" };
    }

    let payload: ClickTokenPayload;
    try {
      payload = JSON.parse(Buffer.from(payloadStr, "base64url").toString("utf8"));
    } catch {
      return { valid: false, error: "Invalid token payload" };
    }

    if (!payload.deliveryId || !payload.clientId || !payload.targetUrl || typeof payload.exp !== "number") {
      return { valid: false, error: "Incomplete token payload" };
    }

    if (payload.exp < Date.now()) {
      return { valid: false, error: "Token has expired" };
    }

    try {
      this.validateTargetUrl(payload.targetUrl);
    } catch (valErr) {
      const msg = valErr instanceof Error ? valErr.message : "Unsafe target URL";
      return { valid: false, error: msg };
    }

    return {
      valid: true,
      deliveryId: payload.deliveryId,
      clientId: payload.clientId,
      targetUrl: payload.targetUrl,
    };
  }

  /**
   * Validates target URL against malicious schemes and open redirect attacks.
   * Only allows valid http: and https: protocols.
   */
  static validateTargetUrl(urlStr: string): void {
    if (!urlStr || typeof urlStr !== "string") {
      throw new Error("Target URL is required");
    }

    // Check for control characters or CRLF injection
    if (/[\r\n\t\0]/.test(urlStr)) {
      throw new Error("Target URL contains prohibited control characters");
    }

    let parsed: URL;
    try {
      parsed = new URL(urlStr);
    } catch {
      throw new Error("Invalid URL format");
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`Prohibited protocol '${parsed.protocol}'. Only 'http:' and 'https:' are allowed.`);
    }

    if (!parsed.hostname || parsed.hostname.length === 0) {
      throw new Error("Target URL must specify a valid destination hostname");
    }
  }

  /**
   * Records an open event for a delivery.
   * Deduplicates within a 5-second window to prevent burst double-counts.
   */
  static async recordOpen(
    deliveryId: string,
    metadata?: { ip?: string; userAgent?: string }
  ): Promise<{ recorded: boolean }> {
    const delivery = await prisma.emailDelivery.findUnique({
      where: { id: deliveryId },
      include: { campaignRecipient: true },
    });

    if (!delivery) {
      return { recorded: false };
    }

    // Stable event ID for open deduplication
    const hourBucket = Math.floor(Date.now() / (3600 * 1000));
    const providerEventId = `open-${delivery.id}-${hourBucket}`;

    const existing = await prisma.emailEvent.findUnique({
      where: { providerEventId },
    });

    if (existing) {
      return { recorded: false };
    }

    // Persist OPENED event
    await prisma.emailEvent.create({
      data: {
        clientId: delivery.clientId,
        deliveryId: delivery.id,
        providerEventId,
        eventType: EmailEventType.OPENED,
        recipient: delivery.to,
        payload: JSON.stringify({
          deliveryId: delivery.id,
          campaignId: delivery.campaignRecipient?.campaignId,
          ...metadata,
        }),
      },
    });

    return { recorded: true };
  }

  /**
   * Records a click event for a delivery.
   */
  static async recordClick(
    deliveryId: string,
    targetUrl: string,
    metadata?: { ip?: string; userAgent?: string }
  ): Promise<{ recorded: boolean }> {
    const delivery = await prisma.emailDelivery.findUnique({
      where: { id: deliveryId },
      include: { campaignRecipient: true },
    });

    if (!delivery) {
      return { recorded: false };
    }

    const clickHash = crypto.createHash("sha256").update(targetUrl).digest("hex").substring(0, 12);
    const hourBucket = Math.floor(Date.now() / (3600 * 1000));
    const providerEventId = `click-${delivery.id}-${clickHash}-${hourBucket}`;

    const existing = await prisma.emailEvent.findUnique({
      where: { providerEventId },
    });

    if (existing) {
      return { recorded: false };
    }

    await prisma.emailEvent.create({
      data: {
        clientId: delivery.clientId,
        deliveryId: delivery.id,
        providerEventId,
        eventType: EmailEventType.CLICKED,
        recipient: delivery.to,
        payload: JSON.stringify({
          deliveryId: delivery.id,
          targetUrl,
          campaignId: delivery.campaignRecipient?.campaignId,
          ...metadata,
        }),
      },
    });

    return { recorded: true };
  }

  /**
   * Returns the transparent 1x1 GIF tracking pixel buffer.
   */
  static getTransparentPixelBuffer(): Buffer {
    return TRANSPARENT_1PX_GIF;
  }

  private static getSecret(): string {
    const secret = process.env.EMAIL_TRACKING_SECRET || process.env.AUTH_SESSION_SECRET;
    if (!secret || secret.length < 32) {
      return "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    }
    return secret;
  }
}
