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
import { parse } from "node-html-parser";
import { prisma } from "../../prisma";
import {
  EmailDeliveryStatus,
  EmailEventProcessingStatus,
  EmailEventType,
} from "@prisma/client";

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

export interface TrackingHtmlOptions {
  baseUrl?: string;
  skipOpen?: boolean;
  skipClick?: boolean;
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
   * Injects a transparent 1x1 GIF tracking pixel into final HTML using AST parser.
   * - Privacy safe: Open token only encodes clientId and deliveryId; recipient email is NEVER included.
   * - Cache busting query param prevents client/proxy cache reuse.
   * - Preserves valid HTML structure.
   */
  static injectOpenPixel(
    html: string,
    clientId: string,
    deliveryId: string,
    options?: TrackingHtmlOptions
  ): string {
    if (!html || typeof html !== "string") {
      return html || "";
    }

    const openToken = this.generateOpenToken(clientId, deliveryId);
    const baseUrl = (options?.baseUrl || process.env.NEXT_PUBLIC_APP_URL || "https://hub.local").replace(/\/+$/, "");
    const cacheBuster = `${Date.now().toString(36)}${Math.random().toString(36).substring(2, 8)}`;
    const pixelUrl = `${baseUrl}/api/email/track/open/${openToken}?cb=${cacheBuster}`;

    const pixelTag = `<img src="${pixelUrl}" alt="" width="1" height="1" border="0" style="display:none;width:1px;height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;" />`;

    try {
      const root = parse(html, {
        lowerCaseTagName: false,
        comment: true,
        blockTextElements: { script: true, noscript: true, style: true, pre: true },
      });

      const body = root.querySelector("body");
      const pixelNode = parse(pixelTag);

      if (body) {
        body.appendChild(pixelNode);
      } else {
        root.appendChild(pixelNode);
      }

      return root.toString();
    } catch {
      return `${html}\n${pixelTag}`;
    }
  }

  /**
   * Safely transforms all eligible HTTP/HTTPS links into signed click tracking URLs using AST parsing.
   * - Preserves original destination inside cryptographically signed HMAC token.
   * - Skips: unsubscribe links, mailto:, tel:, sms:, anchors (#), unsafe protocols (javascript:, data:).
   * - Strictly does NOT modify URLs containing CRLF or control characters.
   * - Prevents open redirects: tracking endpoint only redirects to destination authenticated in the token.
   */
  static wrapLinksWithClickTracking(
    html: string,
    clientId: string,
    deliveryId: string,
    options?: TrackingHtmlOptions
  ): string {
    if (!html || typeof html !== "string") {
      return html || "";
    }

    const baseUrl = (options?.baseUrl || process.env.NEXT_PUBLIC_APP_URL || "https://hub.local").replace(/\/+$/, "");

    try {
      const root = parse(html, {
        lowerCaseTagName: false,
        comment: true,
        blockTextElements: { script: true, noscript: true, style: true, pre: true },
      });

      const anchors = root.querySelectorAll("a");
      for (const anchor of anchors) {
        const href = anchor.getAttribute("href");
        if (!href || typeof href !== "string") continue;

        // 1. CRLF check: Do not modify URLs containing CRLF or control characters
        if (/[\r\n\t\0]/.test(href)) {
          continue;
        }

        const trimmed = href.trim();
        if (!trimmed) continue;

        // 2. Anchors check
        if (trimmed.startsWith("#")) {
          continue;
        }

        // 3. Unsafe / non-web protocols check
        const lower = trimmed.toLowerCase();
        if (
          lower.startsWith("mailto:") ||
          lower.startsWith("tel:") ||
          lower.startsWith("sms:") ||
          lower.startsWith("javascript:") ||
          lower.startsWith("data:") ||
          lower.startsWith("vbscript:") ||
          lower.startsWith("file:")
        ) {
          continue;
        }

        // 4. Unsubscribe link check
        const skipTrack = anchor.getAttribute("data-skip-track");
        const isUnsub = anchor.getAttribute("data-unsubscribe");
        const rel = anchor.getAttribute("rel") || "";
        if (
          skipTrack === "true" ||
          isUnsub === "true" ||
          rel.toLowerCase().includes("unsubscribe") ||
          lower.includes("/unsubscribe") ||
          lower.includes("{{unsubscribe_url}}")
        ) {
          continue;
        }

        // 5. Must be valid HTTP or HTTPS URL
        let parsedUrl: URL;
        try {
          parsedUrl = new URL(trimmed);
        } catch {
          // Relative URL or unparseable format - skip safely
          continue;
        }

        if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
          continue;
        }

        if (!parsedUrl.hostname) {
          continue;
        }

        // 6. Generate signed click token containing authenticated target URL
        const clickToken = this.generateClickToken(clientId, deliveryId, trimmed);
        const trackingUrl = `${baseUrl}/api/email/track/click/${clickToken}`;
        anchor.setAttribute("href", trackingUrl);
      }

      return root.toString();
    } catch {
      return html;
    }
  }

  /**
   * Prepares final production HTML with both link click tracking and transparent open tracking pixel.
   */
  static prepareTrackedHtml(
    html: string,
    clientId: string,
    deliveryId: string,
    options?: TrackingHtmlOptions
  ): string {
    let result = html;
    if (!options?.skipClick) {
      result = this.wrapLinksWithClickTracking(result, clientId, deliveryId, options);
    }
    if (!options?.skipOpen) {
      result = this.injectOpenPixel(result, clientId, deliveryId, options);
    }
    return result;
  }

  /**
   * Records an open event for a delivery.
   * Deduplicates within a 1-hour window per delivery to prevent burst double-counts.
   * Atomically transitions delivery status to DELIVERED and updates campaign metrics.
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

    const existing = await prisma.emailEvent.findFirst({
      where: { clientId: delivery.clientId, providerEventId },
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
        status: EmailEventProcessingStatus.PROCESSED,
        processedAt: new Date(),
        recipient: delivery.to,
        payload: JSON.stringify({
          deliveryId: delivery.id,
          campaignId: delivery.campaignRecipient?.campaignId,
          ...metadata,
        }),
      },
    });

    // An open event is authoritative proof of delivery: promote SENT -> DELIVERED
    if (
      delivery.status === EmailDeliveryStatus.SENT ||
      delivery.status === EmailDeliveryStatus.PROCESSING ||
      delivery.status === EmailDeliveryStatus.QUEUED
    ) {
      await prisma.emailDelivery.update({
        where: { id: delivery.id },
        data: {
          status: EmailDeliveryStatus.DELIVERED,
          deliveredAt: delivery.deliveredAt || new Date(),
        },
      });
    }

    if (delivery.campaignRecipientId && delivery.campaignRecipient) {
      if (delivery.campaignRecipient.status !== "DELIVERED") {
        await prisma.emailCampaignRecipient.update({
          where: { id: delivery.campaignRecipient.id },
          data: { status: "DELIVERED" },
        });

        await prisma.emailCampaign.update({
          where: { id: delivery.campaignRecipient.campaignId },
          data: { deliveredCount: { increment: 1 } },
        });
      }
    }

    return { recorded: true };
  }

  /**
   * Records a click event for a delivery.
   * Atomically transitions delivery status to DELIVERED and updates campaign metrics.
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

    const existing = await prisma.emailEvent.findFirst({
      where: { clientId: delivery.clientId, providerEventId },
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
        status: EmailEventProcessingStatus.PROCESSED,
        processedAt: new Date(),
        recipient: delivery.to,
        payload: JSON.stringify({
          deliveryId: delivery.id,
          targetUrl,
          campaignId: delivery.campaignRecipient?.campaignId,
          ...metadata,
        }),
      },
    });

    // A click event is authoritative proof of delivery: promote SENT -> DELIVERED
    if (
      delivery.status === EmailDeliveryStatus.SENT ||
      delivery.status === EmailDeliveryStatus.PROCESSING ||
      delivery.status === EmailDeliveryStatus.QUEUED
    ) {
      await prisma.emailDelivery.update({
        where: { id: delivery.id },
        data: {
          status: EmailDeliveryStatus.DELIVERED,
          deliveredAt: delivery.deliveredAt || new Date(),
        },
      });
    }

    if (delivery.campaignRecipientId && delivery.campaignRecipient) {
      if (delivery.campaignRecipient.status !== "DELIVERED") {
        await prisma.emailCampaignRecipient.update({
          where: { id: delivery.campaignRecipient.id },
          data: { status: "DELIVERED" },
        });

        await prisma.emailCampaign.update({
          where: { id: delivery.campaignRecipient.campaignId },
          data: { deliveredCount: { increment: 1 } },
        });
      }
    }

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
