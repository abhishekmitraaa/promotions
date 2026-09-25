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
 * In-memory cache for AWS SNS signing certificates.
 * Prevents redundant network fetches and allows deterministic injection in tests.
 */
const snsCertCache = new Map<string, string>();

export function setSnsCertCache(url: string, pem: string): void {
  snsCertCache.set(url, pem);
}

export function clearSnsCertCache(): void {
  snsCertCache.clear();
}

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
 * Strictly fails closed in all environments if verification token is missing or incorrect.
 */
export function verifyGmailPubSubWebhook(
  headers: Headers,
  verificationToken?: string,
  providedToken?: string | null
): WebhookVerificationResult {
  const expectedToken = verificationToken || process.env.GMAIL_WEBHOOK_VERIFICATION_TOKEN;
  if (!expectedToken) {
    // Fail closed in ALL environments: never allow unauthenticated push bypass
    return { valid: false, error: "Google Pub/Sub verification token is not configured" };
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
 * Builds the canonical string to sign according to AWS SNS specification.
 */
export function buildSnsCanonicalString(parsed: Record<string, unknown>): string {
  const type = String(parsed.Type || "");
  const lines: string[] = [];

  if (type === "Notification") {
    lines.push("Message", String(parsed.Message ?? ""));
    lines.push("MessageId", String(parsed.MessageId ?? ""));
    if (parsed.Subject !== undefined && parsed.Subject !== null && parsed.Subject !== "") {
      lines.push("Subject", String(parsed.Subject));
    }
    lines.push("Timestamp", String(parsed.Timestamp ?? ""));
    lines.push("TopicArn", String(parsed.TopicArn ?? ""));
    lines.push("Type", type);
  } else if (type === "SubscriptionConfirmation" || type === "UnsubscribeConfirmation") {
    lines.push("Message", String(parsed.Message ?? ""));
    lines.push("MessageId", String(parsed.MessageId ?? ""));
    lines.push("SubscribeURL", String(parsed.SubscribeURL ?? ""));
    lines.push("Timestamp", String(parsed.Timestamp ?? ""));
    lines.push("Token", String(parsed.Token ?? ""));
    lines.push("TopicArn", String(parsed.TopicArn ?? ""));
    lines.push("Type", type);
  }

  return lines.join("\n") + "\n";
}

/**
 * Verifies AWS SNS notification signature for AWS SES event webhooks.
 * Validates that SigningCertURL is HTTPS and strictly on amazonaws.com.
 * Performs real cryptographic signature validation against the public key certificate.
 * Direct unverified SES payloads without signature or HMAC secret are strictly rejected.
 */
export function verifyAwsSesWebhook(
  rawBody: string,
  headers: Headers,
  secretOverride?: string,
  options?: {
    certResolver?: (certUrl: string) => string | Promise<string>;
  }
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

    const type = String(parsed.Type || "");

    // Validate AWS SNS message structure
    if (
      type === "Notification" ||
      type === "SubscriptionConfirmation" ||
      type === "UnsubscribeConfirmation"
    ) {
      const certUrl = parsed.SigningCertURL;
      if (!isValidAwsCertUrl(certUrl)) {
        return { valid: false, error: "Invalid AWS SigningCertURL domain" };
      }

      if (!parsed.Signature || typeof parsed.Signature !== "string") {
        return { valid: false, error: "Missing AWS SNS message signature" };
      }

      const sigVersion = String(parsed.SignatureVersion || "1");
      if (sigVersion !== "1" && sigVersion !== "2") {
        return { valid: false, error: `Unsupported AWS SNS SignatureVersion: ${sigVersion}` };
      }

      // Check certificate from cache or resolver
      let certPem = snsCertCache.get(certUrl);
      if (!certPem && options?.certResolver) {
        const resolved = options.certResolver(certUrl);
        if (typeof resolved === "string") {
          certPem = resolved;
          snsCertCache.set(certUrl, resolved);
        }
      }

      if (!certPem) {
        return {
          valid: false,
          error: "AWS SNS signing certificate not found in cache or unresolvable",
        };
      }

      // Extract public key from certificate
      let publicKey: crypto.KeyObject;
      try {
        publicKey = crypto.createPublicKey(certPem);
      } catch {
        return { valid: false, error: "Malformed AWS SNS signing certificate" };
      }

      // Build canonical string per AWS SNS specification
      const canonicalString = buildSnsCanonicalString(parsed);
      const hashAlgorithm = sigVersion === "2" ? "RSA-SHA256" : "RSA-SHA1";

      const verifier = crypto.createVerify(hashAlgorithm);
      verifier.update(canonicalString, "utf8");

      const isValid = verifier.verify(publicKey, Buffer.from(parsed.Signature, "base64"));
      if (!isValid) {
        return { valid: false, error: "Invalid AWS SNS cryptographic signature" };
      }

      return { valid: true };
    }

    // Direct unverified SES payloads are strictly rejected
    return {
      valid: false,
      error: "AWS SES webhook missing valid cryptographic signature or authentication token",
    };
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
    // Must match sns.<region>.amazonaws.com and end with .pem
    const isDomainValid = /^sns\.[a-z0-9-]+\.amazonaws\.com$/.test(parsed.hostname);
    const isPem = parsed.pathname.endsWith(".pem");
    return isDomainValid && isPem;
  } catch {
    return false;
  }
}
