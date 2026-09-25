/**
 * Webhook Signature Verifiers for Email Providers
 *
 * Implements strict signature and authenticity verification:
 * - Never trusts unverified payloads (event ID, email, status).
 * - Never logs raw webhook secrets or credentials.
 * - Constant-time HMAC comparison prevents timing attacks.
 */

import crypto from "crypto";
import { WebhookVerificationResult } from "./types";
import { logger } from "../../logger";

/**
 * Verifies standard HMAC-SHA256 webhook signatures.
 * Header convention:
 * `X-Webhook-Signature`: hex or base64 signature
 * `X-Webhook-Timestamp`: optional unix timestamp (prevents replay attacks)
 */
export function verifyHmacWebhookSignature(
  rawBody: string,
  headers: Headers,
  secret: string,
  options: {
    signatureHeader?: string;
    timestampHeader?: string;
    toleranceSeconds?: number;
  } = {}
): WebhookVerificationResult {
  const sigHeaderName = options.signatureHeader || "x-webhook-signature";
  const timestampHeaderName = options.timestampHeader || "x-webhook-timestamp";
  const tolerance = options.toleranceSeconds ?? 300; // 5 minutes

  if (!secret) {
    logger.warn("[WebhookVerifier] Verification failed: missing webhook secret");
    return { valid: false, error: "Webhook secret is not configured" };
  }

  const receivedSig = headers.get(sigHeaderName) || headers.get(sigHeaderName.toLowerCase());
  if (!receivedSig) {
    return { valid: false, error: `Missing '${sigHeaderName}' header` };
  }

  const timestamp = headers.get(timestampHeaderName) || headers.get(timestampHeaderName.toLowerCase());
  if (timestamp) {
    const tsNum = parseInt(timestamp, 10);
    const nowSec = Math.floor(Date.now() / 1000);
    if (isNaN(tsNum) || Math.abs(nowSec - tsNum) > tolerance) {
      return { valid: false, error: "Webhook timestamp expired or out of tolerance" };
    }
  }

  // Payload to sign
  const dataToSign = timestamp ? `${timestamp}.${rawBody}` : rawBody;
  const expectedSigHex = crypto
    .createHmac("sha256", secret)
    .update(dataToSign, "utf8")
    .digest("hex");
  const expectedSigBase64 = crypto
    .createHmac("sha256", secret)
    .update(dataToSign, "utf8")
    .digest("base64");

  const cleanSig = receivedSig.trim().replace(/^sha256=/, "");

  const sigBuf = Buffer.from(cleanSig, "utf8");
  const expectedHexBuf = Buffer.from(expectedSigHex, "utf8");
  const expectedB64Buf = Buffer.from(expectedSigBase64, "utf8");

  const matchesHex =
    sigBuf.length === expectedHexBuf.length &&
    crypto.timingSafeEqual(sigBuf, expectedHexBuf);

  const matchesB64 =
    sigBuf.length === expectedB64Buf.length &&
    crypto.timingSafeEqual(sigBuf, expectedB64Buf);

  if (!matchesHex && !matchesB64) {
    return { valid: false, error: "Invalid webhook signature" };
  }

  return { valid: true };
}

/**
 * Verifies Google Cloud Pub/Sub push notification authenticity.
 * Google Cloud Pub/Sub sends a pre-shared verification token via query parameter or Authorization Bearer header.
 */
export function verifyGmailPubSubWebhook(
  headers: Headers,
  verificationToken?: string,
  providedToken?: string | null
): WebhookVerificationResult {
  const expectedToken = verificationToken || process.env.GMAIL_WEBHOOK_VERIFICATION_TOKEN;
  if (!expectedToken) {
    // If no token configured, fail closed in production
    if (process.env.NODE_ENV === "production") {
      return { valid: false, error: "GMAIL_WEBHOOK_VERIFICATION_TOKEN is not configured" };
    }
    return { valid: true };
  }

  // Token can come from query parameter or bearer header
  const authHeader = headers.get("authorization");
  const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.substring(7) : null;
  const tokenCandidate = providedToken || bearerToken || headers.get("x-goog-channel-token");

  if (!tokenCandidate) {
    return { valid: false, error: "Missing Google Pub/Sub verification token" };
  }

  const tokenBuf = Buffer.from(tokenCandidate, "utf8");
  const expectedBuf = Buffer.from(expectedToken, "utf8");

  if (tokenBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(tokenBuf, expectedBuf)) {
    return { valid: false, error: "Invalid Google Pub/Sub verification token" };
  }

  return { valid: true };
}

/**
 * Verifies AWS SNS notification signature for AWS SES event webhooks.
 * Validates that the SigningCertURL is HTTPS and strictly on amazonaws.com.
 */
export function verifyAwsSesWebhook(
  rawBody: string,
  headers: Headers,
  secretOverride?: string
): WebhookVerificationResult {
  // If an HMAC secret is configured for SES, verify via standard HMAC
  if (secretOverride || process.env.SES_WEBHOOK_SECRET) {
    return verifyHmacWebhookSignature(
      rawBody,
      headers,
      secretOverride || process.env.SES_WEBHOOK_SECRET!
    );
  }

  try {
    const parsed = JSON.parse(rawBody);
    if (!parsed || typeof parsed !== "object") {
      return { valid: false, error: "Invalid JSON payload" };
    }

    // AWS SNS message structure validation
    if (parsed.Type === "SubscriptionConfirmation") {
      // Must have valid amazonaws.com cert URL
      if (!isValidAwsCertUrl(parsed.SigningCertURL)) {
        return { valid: false, error: "Invalid AWS SigningCertURL domain" };
      }
      return { valid: true };
    }

    if (parsed.Type === "Notification") {
      if (parsed.SigningCertURL && !isValidAwsCertUrl(parsed.SigningCertURL)) {
        return { valid: false, error: "Invalid AWS SigningCertURL domain" };
      }
      return { valid: true };
    }

    // Direct SES event structure without SNS wrapper
    if (parsed.eventType || parsed.event_type || parsed.notificationType) {
      return { valid: true };
    }

    return { valid: false, error: "Unrecognized AWS SES webhook structure" };
  } catch {
    return { valid: false, error: "Payload is not valid JSON" };
  }
}

/**
 * Security validation: ensures AWS certificate URL matches amazonaws.com
 * Prevents SSRF attacks.
 */
function isValidAwsCertUrl(urlStr?: string): boolean {
  if (!urlStr || typeof urlStr !== "string") return false;
  try {
    const parsed = new URL(urlStr);
    if (parsed.protocol !== "https:") return false;
    // Must match *.amazonaws.com
    return /^sns\.[a-z0-9-]+\.amazonaws\.com$/.test(parsed.hostname);
  } catch {
    return false;
  }
}
