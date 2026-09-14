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
];

function maskValue(key: string, value: unknown): unknown {
  if (typeof value === "string") {
    const lowerKey = key.toLowerCase();
    if (SENSITIVE_KEYS.some((k) => lowerKey.includes(k))) {
      if (value.length <= 8) return "[REDACTED]";
      return `${value.substring(0, 4)}...[REDACTED]`;
    }
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
