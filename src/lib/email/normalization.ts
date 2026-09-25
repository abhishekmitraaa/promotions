/**
 * Email Address Normalization & Validation Utility
 *
 * Normalizes email addresses consistently:
 * - Trims leading and trailing whitespace
 * - Converts entire address to lowercase
 * - Defends strictly against CRLF injection (\r, \n)
 * - Defends strictly against control characters and null bytes (\0)
 * - Enforces RFC 5321 254 character maximum length
 * - Validates RFC 5322 compliant structure
 */

export function normalizeEmail(email: string): string {
  if (!email || typeof email !== "string") {
    throw new Error("Email must be a non-empty string");
  }

  // CRLF Injection Defense
  if (/[\r\n]/.test(email)) {
    throw new Error("Email address contains forbidden CRLF injection characters");
  }

  // Control Character and Null Byte Defense
  if (/[\0\x01-\x1F\x7F]/.test(email)) {
    throw new Error("Email address contains forbidden control characters or null bytes");
  }

  const trimmed = email.trim();

  // RFC 5321 Length Enforcement
  if (trimmed.length > 254) {
    throw new Error("Email address exceeds RFC 5321 254 character limit");
  }

  if (!isValidEmail(trimmed)) {
    throw new Error(`Invalid email address format: '${email}'`);
  }

  return trimmed.toLowerCase();
}

/**
 * Validates email format according to standard email RFC conventions.
 */
export function isValidEmail(email: string): boolean {
  if (!email || typeof email !== "string") return false;
  const trimmed = email.trim();
  if (trimmed.length === 0 || trimmed.length > 254) return false;

  // RFC 5322 compliant regex for practical modern email validation with TLD requirement
  const emailRegex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;
  return emailRegex.test(trimmed);
}

/**
 * Masks an email for privacy in public tokens or confirmations.
 * Example: "jane.doe@example.com" -> "j***e@example.com"
 */
export function maskEmail(email: string): string {
  try {
    const [local, domain] = email.split("@");
    if (!local || !domain) return "***@***";
    if (local.length <= 2) {
      return `${local[0]}*@${domain}`;
    }
    return `${local[0]}***${local[local.length - 1]}@${domain}`;
  } catch {
    return "***@***";
  }
}

export { sanitizeHeader } from "./sanitization";
