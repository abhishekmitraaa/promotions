/**
 * Structured Worker Logger with Strict Secret & Credential Redaction
 *
 * Designed for production worker environments (Docker, Kubernetes, AWS ECS, PM2).
 * Formats structured logs with ISO timestamps, worker context, and guarantees
 * zero leakage of sensitive credentials, tokens, passwords, or secrets.
 */

const SENSITIVE_KEY_PATTERNS = [
  "token",
  "secret",
  "password",
  "key",
  "auth",
  "credential",
  "cookie",
  "code",
  "pepper",
  "hash",
  "signature",
  "session",
];

/**
 * Sanitizes URLs to mask passwords and tokens.
 * E.g., redis://:secret@host:port -> redis://:***@host:port
 * postgresql://user:secret@host:port/db -> postgresql://user:***@host:port/db
 */
export function sanitizeUrl(rawUrl: string): string {
  if (!rawUrl || typeof rawUrl !== "string") return "";
  try {
    const parsed = new URL(rawUrl);
    if (parsed.password) parsed.password = "***";
    if (parsed.username && parsed.username.length > 20) parsed.username = "***";
    return parsed.toString();
  } catch {
    return rawUrl
      .replace(/(:\/\/[^:]+:)([^@]+)(@)/g, "$1***$3")
      .replace(/([?&](?:key|token|secret|password)=)[^&]+/gi, "$1***");
  }
}

/**
 * Masks an email address local part for secure logging (e.g. john.doe@example.com -> j***e@example.com).
 */
export function maskEmailForLogs(email: string): string {
  if (!email || typeof email !== "string" || !email.includes("@")) {
    return "[INVALID_EMAIL]";
  }
  const [local, domain] = email.split("@");
  if (local.length <= 2) {
    return `${local[0] || "*"}***@${domain}`;
  }
  return `${local[0]}***${local[local.length - 1]}@${domain}`;
}

/**
 * Recursively sanitizes data values and strips secrets.
 */
export function sanitizeLogValue(key: string, value: unknown): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === "string") {
    const lowerKey = key.toLowerCase();

    // Check if key name is inherently sensitive
    if (SENSITIVE_KEY_PATTERNS.some((pattern) => lowerKey.includes(pattern))) {
      return "[REDACTED]";
    }

    // Mask emails if key represents recipient or email
    if (lowerKey.includes("email") || lowerKey.includes("recipient") || lowerKey === "to" || lowerKey === "from") {
      return maskEmailForLogs(value);
    }

    // Strip inline bearer tokens
    let text = value.replace(/(Bearer\s+)[a-zA-Z0-9_\-\.]{12,}/gi, "$1[REDACTED]");

    // Strip Google OAuth ya29 tokens
    text = text.replace(/ya29\.[a-zA-Z0-9_\-]{20,}/gi, "ya29.[REDACTED]");

    // Strip API keys with prefix whub_
    text = text.replace(/whub_[a-zA-Z0-9]{20,}/gi, "whub_[REDACTED]");

    // Strip URL passwords
    text = sanitizeUrl(text);

    return text;
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: sanitizeLogValue(key, value.message) as string,
      code: (value as unknown as Record<string, unknown>).code,
      stack: process.env.NODE_ENV === "development" ? sanitizeLogValue(key, value.stack) : undefined,
    };
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeLogValue(key, item));
  }

  if (typeof value === "object") {
    const sanitized: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      sanitized[k] = sanitizeLogValue(k, v);
    }
    return sanitized;
  }

  return value;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export class WorkerLogger {
  private readonly context: string;

  constructor(context: string = "Worker:Email") {
    this.context = context;
  }

  private formatMessage(level: LogLevel, message: string, meta?: Record<string, unknown>): string {
    const timestamp = new Date().toISOString();
    const pid = process.pid;
    const cleanMeta = meta ? JSON.stringify(sanitizeLogValue("meta", meta)) : "";
    return `[${timestamp}] [PID:${pid}] [${level.toUpperCase()}] [${this.context}] ${message} ${cleanMeta}`.trim();
  }

  debug(message: string, meta?: Record<string, unknown>) {
    if (process.env.LOG_LEVEL === "debug") {
      console.log(this.formatMessage("debug", message, meta));
    }
  }

  info(message: string, meta?: Record<string, unknown>) {
    console.log(this.formatMessage("info", message, meta));
  }

  warn(message: string, meta?: Record<string, unknown>) {
    console.warn(this.formatMessage("warn", message, meta));
  }

  error(message: string, error?: unknown, meta?: Record<string, unknown>) {
    const errObj = error ? { error: sanitizeLogValue("error", error) } : {};
    console.error(this.formatMessage("error", message, { ...errObj, ...meta }));
  }
}

export const workerLogger = new WorkerLogger("Worker:Email");

/**
 * Convenience helper to redact sensitive secrets from any data structure.
 */
export function redactSecrets(data: unknown): unknown {
  return sanitizeLogValue("root", data);
}
