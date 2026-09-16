import { validateWebhookUrlSync } from "./ssrf";

export const ALLOWED_WEBHOOK_EVENTS = [
  "*",
  "message.sent",
  "message.delivered",
  "message.read",
  "message.failed",
  "message.received",
  "otp.requested",
  "otp.verified",
  "test.event",
] as const;

export type WebhookEventName = (typeof ALLOWED_WEBHOOK_EVENTS)[number];

export interface ValidationResult<T> {
  valid: boolean;
  value?: T;
  reason?: string;
}

/**
 * Validate webhook subscription event list against defined catalog.
 */
export function validateSubscribedEvents(
  events: unknown
): ValidationResult<string[]> {
  if (!Array.isArray(events)) {
    return {
      valid: false,
      reason: "subscribedEvents must be an array of event name strings",
    };
  }

  if (events.length === 0) {
    return {
      valid: false,
      reason: "subscribedEvents array cannot be empty. Provide '*' or specific event names.",
    };
  }

  const normalizedSet = new Set<string>();

  for (let i = 0; i < events.length; i++) {
    const item = events[i];
    if (typeof item !== "string" || item.trim().length === 0) {
      return {
        valid: false,
        reason: `Event at index ${i} must be a non-empty string`,
      };
    }

    const trimmed = item.trim();
    if (!ALLOWED_WEBHOOK_EVENTS.includes(trimmed as WebhookEventName)) {
      return {
        valid: false,
        reason: `Unknown event name '${trimmed}'. Allowed events: ${ALLOWED_WEBHOOK_EVENTS.join(", ")}`,
      };
    }

    normalizedSet.add(trimmed);
  }

  const normalized = Array.from(normalizedSet);
  if (normalized.includes("*")) {
    return { valid: true, value: ["*"] };
  }

  return { valid: true, value: normalized };
}

/**
 * Validate and normalize webhook URL for admin registration.
 */
export function validateAdminWebhookUrl(url: unknown): ValidationResult<string> {
  if (typeof url !== "string" || url.trim().length === 0) {
    return { valid: false, reason: "Webhook URL must be a non-empty string" };
  }

  const trimmed = url.trim();

  // Length limit
  if (trimmed.length > 2048) {
    return { valid: false, reason: "Webhook URL exceeds maximum length of 2048 characters" };
  }

  // Dangerous control characters / CRLF injection check
  if (/[\x00-\x1F\x7F]/.test(trimmed)) {
    return { valid: false, reason: "Webhook URL contains forbidden control characters" };
  }

  // Parse URL
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { valid: false, reason: "Webhook URL has invalid syntax" };
  }

  // Enforce HTTP / HTTPS
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      valid: false,
      reason: "Webhook URL must use HTTP or HTTPS protocol",
    };
  }

  // SSRF Protection check
  const ssrfCheck = validateWebhookUrlSync(trimmed);
  if (!ssrfCheck.valid) {
    return {
      valid: false,
      reason: ssrfCheck.reason || "Disallowed destination host or IP address (SSRF protection)",
    };
  }

  return { valid: true, value: trimmed };
}
