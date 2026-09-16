import { env } from "./env";

const SENSITIVE_KEYS = [
  "token",
  "access_token",
  "authorization",
  "secret",
  "app_secret",
  "code",
  "otp",
  "password",
  "key",
  "api_key",
  "verify_token",
  "pepper",
  "signing_secret",
  "encryption_key",
];

const PHONE_KEYS = ["phone", "to", "from", "destination", "recipient"];

/**
 * Mask sensitive phone number digits (e.g. +1234567890 -> +123***7890).
 */
export function maskPhoneNumber(phone: string): string {
  if (!phone || phone.length < 7) return "[REDACTED_PHONE]";
  const start = phone.substring(0, 4);
  const end = phone.substring(phone.length - 4);
  return `${start}****${end}`;
}

/**
 * Mask sensitive strings, tokens, passwords, and phone numbers.
 */
function maskValue(key: string, value: unknown): unknown {
  if (typeof value === "string") {
    const lowerKey = key.toLowerCase();

    // Sensitive secrets
    if (SENSITIVE_KEYS.some((k) => lowerKey.includes(k))) {
      if (value.length <= 8) return "[REDACTED]";
      return `${value.substring(0, 4)}...[REDACTED]`;
    }

    // Phone numbers
    if (PHONE_KEYS.some((k) => lowerKey.includes(k))) {
      return maskPhoneNumber(value);
    }

    // Inline Bearer token redaction
    let masked = value.replace(/(Bearer\s+)[a-zA-Z0-9_\-\.]{15,}/gi, "$1[REDACTED]");

    // Inline phone pattern redaction in strings (e.g. "recipient '+1234567890'")
    masked = masked.replace(/(\+?\d{1,3})(\d{4,8})(\d{3,4})/g, (match, p1, p2, p3) => {
      return `${p1}****${p3}`;
    });

    return masked;
  }

  if (typeof value === "object" && value !== null) {
    if (Array.isArray(value)) {
      return value.map((item) => maskValue(key, item));
    }
    const sanitizedObj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      sanitizedObj[k] = maskValue(k, v);
    }
    return sanitizedObj;
  }

  return value;
}

export const logger = {
  debug: (...args: unknown[]) => {
    if (env.LOG_LEVEL === "debug") {
      console.log("[DEBUG]", ...args.map((a) => maskValue("arg", a)));
    }
  },
  info: (...args: unknown[]) => {
    if (["debug", "info"].includes(env.LOG_LEVEL)) {
      console.log("[INFO]", ...args.map((a) => maskValue("arg", a)));
    }
  },
  warn: (...args: unknown[]) => {
    if (["debug", "info", "warn"].includes(env.LOG_LEVEL)) {
      console.warn("[WARN]", ...args.map((a) => maskValue("arg", a)));
    }
  },
  error: (...args: unknown[]) => {
    console.error("[ERROR]", ...args.map((a) => maskValue("arg", a)));
  },
};
