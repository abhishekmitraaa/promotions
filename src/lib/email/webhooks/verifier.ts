/**
 * Webhook Signature Verifiers for Email Providers
 *
 * Implements strict signature and authenticity verification:
 * - Never trusts unverified payloads (event ID, email, status).
 * - Never logs raw webhook secrets or credentials.
 * - Constant-time HMAC comparison prevents timing attacks.
 */

import crypto from "crypto";
import dns from "dns/promises";
import net from "net";
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
 * `X-Webhook-Timestamp`: unix timestamp (prevents replay attacks)
 */
export function verifyHmacWebhookSignature(
  rawBody: string,
  headers: Headers,
  secret: string,
  options: {
    signatureHeader?: string;
    timestampHeader?: string;
    toleranceSeconds?: number;
    requireTimestamp?: boolean;
  } = {}
): WebhookVerificationResult {
  const sigHeaderName = options.signatureHeader || "x-webhook-signature";
  const timestampHeaderName = options.timestampHeader || "x-webhook-timestamp";
  const tolerance = options.toleranceSeconds ?? 300; // 5 minutes
  const requireTimestamp = options.requireTimestamp ?? true;

  if (!secret) {
    logger.warn("[WebhookVerifier] Verification failed: missing webhook secret");
    return { valid: false, error: "Webhook secret is not configured" };
  }

  const receivedSig = headers.get(sigHeaderName) || headers.get(sigHeaderName.toLowerCase());
  if (!receivedSig) {
    return { valid: false, error: `Missing '${sigHeaderName}' header` };
  }

  const timestamp = headers.get(timestampHeaderName) || headers.get(timestampHeaderName.toLowerCase());
  if (!timestamp) {
    if (requireTimestamp) {
      return { valid: false, error: `Missing required '${timestampHeaderName}' header` };
    }
  } else {
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
export function isValidAwsCertUrl(urlStr?: string): boolean {
  if (!urlStr || typeof urlStr !== "string") return false;
  try {
    const parsed = new URL(urlStr);
    if (parsed.protocol !== "https:") return false;

    // Strict authority checks: no port override, no userinfo credentials
    if (parsed.port !== "" && parsed.port !== "443") return false;
    if (parsed.username !== "" || parsed.password !== "") return false;

    // No search query params or hash fragments
    if (parsed.search !== "" || parsed.hash !== "") return false;

    // Must match sns.<region>.amazonaws.com (standard AWS region format)
    const isDomainValid = /^sns\.[a-z0-9-]+\.amazonaws\.com$/i.test(parsed.hostname);
    if (!isDomainValid) return false;

    // Path must end with .pem and must not contain directory traversal or null bytes
    if (urlStr.includes("..") || urlStr.includes("%2e") || urlStr.includes("%2E") || urlStr.includes("\0")) return false;
    const pathname = parsed.pathname;
    if (!pathname.endsWith(".pem")) return false;
    if (pathname.includes("..") || pathname.includes("\0")) return false;

    return true;
  } catch {
    return false;
  }
}

/**
 * IP classification utility for strict SSRF protection.
 * Returns true if an IP address belongs to private, loopback, link-local,
 * cloud metadata (169.254.169.254), or reserved non-routable ranges.
 */
export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const parts = ip.split(".").map(Number);
    if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
      return true; // Malformed IPv4 treated as unsafe
    }
    // 0.0.0.0/8
    if (parts[0] === 0) return true;
    // 10.0.0.0/8 (RFC 1918)
    if (parts[0] === 10) return true;
    // 100.64.0.0/10 (Carrier-grade NAT)
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
    // 127.0.0.0/8 (Loopback)
    if (parts[0] === 127) return true;
    // 169.254.0.0/16 (Link-local, AWS/GCP/Azure instance metadata 169.254.169.254)
    if (parts[0] === 169 && parts[1] === 254) return true;
    // 172.16.0.0/12 (RFC 1918)
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    // 192.0.0.0/24 (IETF Protocol Assignments)
    if (parts[0] === 192 && parts[1] === 0 && parts[2] === 0) return true;
    // 192.0.2.0/24 (TEST-NET-1)
    if (parts[0] === 192 && parts[1] === 0 && parts[2] === 2) return true;
    // 192.168.0.0/16 (RFC 1918)
    if (parts[0] === 192 && parts[1] === 168) return true;
    // 198.18.0.0/15 (Network benchmark tests)
    if (parts[0] === 198 && parts[1] >= 18 && parts[1] <= 19) return true;
    // 198.51.100.0/24 (TEST-NET-2)
    if (parts[0] === 198 && parts[1] === 51 && parts[2] === 100) return true;
    // 203.0.113.0/24 (TEST-NET-3)
    if (parts[0] === 203 && parts[1] === 0 && parts[2] === 113) return true;
    // 224.0.0.0/4 (Multicast) & 240.0.0.0/4 (Reserved)
    if (parts[0] >= 224) return true;
    return false;
  }
  if (net.isIPv6(ip)) {
    const normalized = ip.toLowerCase();
    // ::1 (Loopback)
    if (normalized === "::1" || normalized === "0000:0000:0000:0000:0000:0000:0000:0001") return true;
    // :: (Unspecified)
    if (normalized === "::") return true;
    // IPv4-mapped IPv6 ::ffff:x.x.x.x
    if (normalized.startsWith("::ffff:")) {
      const v4Part = normalized.substring(7);
      return isPrivateIp(v4Part);
    }
    // fc00::/7 (Unique local)
    if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
    // fe80::/10 (Link-local)
    if (
      normalized.startsWith("fe8") ||
      normalized.startsWith("fe9") ||
      normalized.startsWith("fea") ||
      normalized.startsWith("feb")
    ) {
      return true;
    }
    return false;
  }
  return true; // Non-standard or unparseable treated as private/unsafe
}

/**
 * Safely fetches an AWS SNS signing certificate with comprehensive SSRF protection.
 * - Enforces HTTPS and strictly valid AWS SNS hostname.
 * - Resolves DNS and verifies all IP addresses are NOT private, loopback, link-local, or cloud metadata.
 * - Prevents HTTP redirects.
 * - Enforces 5s request timeout and 64KB response size limit.
 * - Caches certificate in bounded in-memory cache.
 */
export async function fetchAwsSnsCertificate(certUrl: string): Promise<string> {
  if (!isValidAwsCertUrl(certUrl)) {
    throw new Error("Invalid AWS SigningCertURL domain or path");
  }

  const cached = snsCertCache.get(certUrl);
  if (cached) return cached;

  const parsed = new URL(certUrl);

  // Perform DNS resolution and verify against internal / private IP ranges
  const addresses = await dns.lookup(parsed.hostname, { all: true });
  if (!addresses || addresses.length === 0) {
    throw new Error(`DNS resolution failed for ${parsed.hostname}`);
  }

  for (const { address } of addresses) {
    if (isPrivateIp(address)) {
      throw new Error(`SSRF blocked: Host ${parsed.hostname} resolved to forbidden IP ${address}`);
    }
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);

  try {
    const res = await fetch(certUrl, {
      method: "GET",
      signal: controller.signal,
      redirect: "error", // NEVER follow redirects
      headers: {
        Accept: "text/plain, application/x-pem-file, */*",
      },
    });

    if (!res.ok) {
      throw new Error(`Failed to fetch AWS SNS certificate: HTTP ${res.status}`);
    }

    const text = await res.text();
    if (text.length > 65536) {
      throw new Error("AWS SNS certificate exceeds maximum allowable size (64KB)");
    }

    if (!text.includes("BEGIN CERTIFICATE")) {
      throw new Error("Downloaded file is not a valid X.509 certificate");
    }

    // Bounded cache insertion (keep max 100 entries)
    if (snsCertCache.size >= 100) {
      const oldestKey = snsCertCache.keys().next().value;
      if (oldestKey) snsCertCache.delete(oldestKey);
    }
    snsCertCache.set(certUrl, text);

    return text;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Asynchronously verifies AWS SNS notification signature for AWS SES event webhooks.
 * Supports safe fetching of certificates via SSRF-hardened fetchAwsSnsCertificate.
 */
export async function verifyAwsSesWebhookAsync(
  rawBody: string,
  headers: Headers,
  secretOverride?: string,
  options?: {
    certResolver?: (certUrl: string) => string | Promise<string>;
  }
): Promise<WebhookVerificationResult> {
  // If an HMAC secret is configured for SES, verify via standard HMAC
  if (secretOverride || process.env.SES_WEBHOOK_SECRET) {
    return verifyHmacWebhookSignature(
      rawBody,
      headers,
      secretOverride || process.env.SES_WEBHOOK_SECRET!,
      { requireTimestamp: true }
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

      // Check certificate from cache or resolver or safe fetch
      let certPem = snsCertCache.get(certUrl);
      if (!certPem && options?.certResolver) {
        const resolved = await options.certResolver(certUrl);
        if (typeof resolved === "string") {
          certPem = resolved;
          snsCertCache.set(certUrl, resolved);
        }
      }

      if (!certPem) {
        try {
          certPem = await fetchAwsSnsCertificate(certUrl);
        } catch (fetchErr) {
          const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
          logger.warn(`[WebhookVerifier] Failed to resolve AWS SNS certificate: ${msg}`);
          return {
            valid: false,
            error: `AWS SNS signing certificate resolution failed: ${msg}`,
          };
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

