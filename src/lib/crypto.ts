import crypto from "crypto";
import { env } from "./env";

/**
 * Generate a new random API key.
 * Format: `whub_<24 random hex chars>`
 * Returns the raw key (shown to user once), prefix (`whub_...`), and peppered hash.
 */
export function generateApiKey(): {
  rawKey: string;
  keyPrefix: string;
  keyHash: string;
} {
  const randomBytes = crypto.randomBytes(18).toString("hex");
  const rawKey = `whub_${randomBytes}`;
  const keyPrefix = rawKey.substring(0, 10);
  const keyHash = hashApiKey(rawKey);

  return {
    rawKey,
    keyPrefix,
    keyHash,
  };
}

/**
 * Hash an API key using HMAC SHA-256 with the configured API_KEY_PEPPER.
 */
export function hashApiKey(rawKey: string): string {
  const pepper = env.API_KEY_PEPPER || "default_pepper";
  return crypto.createHmac("sha256", pepper).update(rawKey).digest("hex");
}

/**
 * Generate a numeric OTP of specified length (default from env: 6 digits).
 */
export function generateSecureOtp(length: number = env.OTP_CODE_LENGTH): string {
  const min = Math.pow(10, length - 1);
  const max = Math.pow(10, length) - 1;
  const randomNumber = crypto.randomInt(min, max + 1);
  return randomNumber.toString().padStart(length, "0");
}

/**
 * Hash an OTP code bound to destination and purpose.
 */
export function hashOtp(code: string, destination: string, purpose: string): string {
  const pepper = env.API_KEY_PEPPER || "otp_pepper";
  const payload = `${destination}:${purpose}:${code}`;
  return crypto.createHmac("sha256", pepper).update(payload).digest("hex");
}

/**
 * Sign a string payload using HMAC SHA-256.
 */
export function signHmacSha256(payload: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

/**
 * Perform a timing-safe HMAC SHA-256 signature verification.
 */
export function verifyHmacSha256(
  payload: string,
  secret: string,
  expectedSignature: string
): boolean {
  if (!payload || !secret || !expectedSignature) return false;

  // Clean prefix if signature is in 'sha256=...' format
  const normalizedExpected = expectedSignature.startsWith("sha256=")
    ? expectedSignature.substring(7)
    : expectedSignature;

  const computedSignature = signHmacSha256(payload, secret);

  const bufComputed = Buffer.from(computedSignature, "utf8");
  const bufExpected = Buffer.from(normalizedExpected, "utf8");

  if (bufComputed.length !== bufExpected.length) return false;

  return crypto.timingSafeEqual(bufComputed, bufExpected);
}

/**
 * Normalize phone numbers to clean E.164 numeric format (digits only).
 * Example: "+91 98765-43210" -> "919876543210"
 */
export function normalizePhoneNumber(phone: string): string {
  if (!phone) return "";
  let digits = phone.replace(/\D/g, "");
  // If user entered e.g. 0091..., trim leading zeros
  digits = digits.replace(/^0+/, "");
  return digits;
}
