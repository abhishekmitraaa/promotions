/**
 * Webhook Event Normalizer
 *
 * Normalizes provider-specific webhook payloads into unified NormalizedEmailWebhookEvent objects:
 * - Distinguishes between HARD_BOUNCE (permanent, triggers suppression) and SOFT_BOUNCE (transient, no suppression).
 * - Extracts complaint reasons and feedback types.
 * - Extracts providerMessageId or custom deliveryId for delivery correlation.
 * - Normalizes recipient email addresses.
 */

import { EmailEventType, EmailProviderType } from "@prisma/client";
import { NormalizedEmailWebhookEvent, BounceClassification } from "./types";
import { normalizeEmail } from "../normalization";

/**
 * Classifies bounce type based on diagnostic codes or provider classifications.
 * RFC 3463 / 5321 enhanced status codes:
 * - 5.X.X: Permanent Failure -> HARD_BOUNCE
 * - 4.X.X: Persistent Transient Failure -> SOFT_BOUNCE
 */
export function classifyBounce(
  providerType: string,
  statusCode?: string,
  bounceSubType?: string,
  diagnosticCode?: string
): { type: BounceClassification; reason: string } {
  const code = (statusCode || "").trim();
  const subType = (bounceSubType || "").toUpperCase();
  const diag = (diagnosticCode || "").toLowerCase();

  // AWS SES / SendGrid explicit bounce type
  if (subType === "PERMANENT" || subType === "UNDETERMINED_HARD") {
    return { type: "HARD_BOUNCE", reason: diagnosticCode || "Permanent hard bounce" };
  }
  if (subType === "TRANSIENT" || subType === "MAILBOX_FULL" || subType === "MESSAGE_TOO_LARGE") {
    return { type: "SOFT_BOUNCE", reason: diagnosticCode || "Transient soft bounce" };
  }

  // Check SMTP status code
  if (code.startsWith("5.") || code.startsWith("55")) {
    return { type: "HARD_BOUNCE", reason: diagnosticCode || `Permanent bounce (${code})` };
  }
  if (code.startsWith("4.") || code.startsWith("45") || code.startsWith("42")) {
    return { type: "SOFT_BOUNCE", reason: diagnosticCode || `Transient bounce (${code})` };
  }

  // Diagnostic string inspection
  if (
    diag.includes("user unknown") ||
    diag.includes("mailbox unavailable") ||
    diag.includes("no such user") ||
    diag.includes("invalid recipient") ||
    diag.includes("does not exist")
  ) {
    return { type: "HARD_BOUNCE", reason: diagnosticCode || "Recipient unknown" };
  }

  if (diag.includes("mailbox full") || diag.includes("quota exceeded") || diag.includes("try again later")) {
    return { type: "SOFT_BOUNCE", reason: diagnosticCode || "Mailbox temporarily unavailable" };
  }

  // Default to soft bounce to prevent accidental permanent suppression without a confirmed hard bounce
  return { type: "SOFT_BOUNCE", reason: diagnosticCode || "Unclassified bounce" };
}

/**
 * Normalizes generic webhook payload.
 * Expected schema:
 * {
 *   eventId: string;
 *   eventType: "SENT" | "DELIVERED" | "OPENED" | "CLICKED" | "BOUNCED" | "COMPLAINT" | "UNSUBSCRIBED" | "FAILED";
 *   recipient: string;
 *   providerMessageId?: string;
 *   deliveryId?: string;
 *   timestamp?: string | number;
 *   bounce?: { type?: string; code?: string; description?: string };
 *   complaint?: { feedbackType?: string };
 *   metadata?: Record<string, unknown>;
 * }
 */
export function normalizeGenericEvent(
  payload: Record<string, unknown>,
  providerType: EmailProviderType = EmailProviderType.MOCK
): NormalizedEmailWebhookEvent[] {
  const eventId = String(payload.eventId || payload.id || `evt-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`);
  const rawEventType = String(payload.eventType || payload.type || "").toUpperCase();

  let eventType: EmailEventType;
  switch (rawEventType) {
    case "SENT":
      eventType = EmailEventType.SENT;
      break;
    case "DELIVERED":
      eventType = EmailEventType.DELIVERED;
      break;
    case "OPEN":
    case "OPENED":
      eventType = EmailEventType.OPENED;
      break;
    case "CLICK":
    case "CLICKED":
      eventType = EmailEventType.CLICKED;
      break;
    case "BOUNCE":
    case "BOUNCED":
      eventType = EmailEventType.BOUNCED;
      break;
    case "COMPLAINT":
    case "SPAM":
      eventType = EmailEventType.COMPLAINT;
      break;
    case "UNSUBSCRIBE":
    case "UNSUBSCRIBED":
      eventType = EmailEventType.UNSUBSCRIBED;
      break;
    case "FAILED":
    case "DROPPED":
      eventType = EmailEventType.FAILED;
      break;
    default:
      throw new Error(`Unknown or unsupported email event type: '${rawEventType}'`);
  }

  const rawRecipient = String(payload.recipient || payload.email || payload.to || "");
  const recipient = normalizeEmail(rawRecipient);

  const providerMessageId = payload.providerMessageId ? String(payload.providerMessageId) : undefined;
  const deliveryId = payload.deliveryId ? String(payload.deliveryId) : undefined;

  let occurredAt = new Date();
  if (payload.timestamp) {
    occurredAt = typeof payload.timestamp === "number" ? new Date(payload.timestamp * (payload.timestamp < 10000000000 ? 1000 : 1)) : new Date(String(payload.timestamp));
  }

  let bounceType: BounceClassification | undefined;
  let bounceReason: string | undefined;

  if (eventType === EmailEventType.BOUNCED) {
    const bounceObj = (payload.bounce as Record<string, unknown>) || {};
    const classification = classifyBounce(
      providerType,
      bounceObj.code ? String(bounceObj.code) : undefined,
      bounceObj.type ? String(bounceObj.type) : undefined,
      bounceObj.description ? String(bounceObj.description) : undefined
    );
    bounceType = classification.type;
    bounceReason = classification.reason;
  }

  let complaintFeedback: string | undefined;
  if (eventType === EmailEventType.COMPLAINT) {
    const complaintObj = (payload.complaint as Record<string, unknown>) || {};
    complaintFeedback = complaintObj.feedbackType ? String(complaintObj.feedbackType) : "abuse";
  }

  return [
    {
      providerType,
      providerEventId: eventId,
      providerMessageId,
      deliveryId,
      eventType,
      recipient,
      occurredAt,
      bounceType,
      bounceReason,
      complaintFeedback,
      rawPayload: payload,
      metadata: (payload.metadata as Record<string, unknown>) || undefined,
    },
  ];
}

/**
 * Normalizes AWS SES events (can be direct or wrapped inside SNS Notification).
 */
export function normalizeSesEvent(rawPayload: Record<string, unknown>): NormalizedEmailWebhookEvent[] {
  let sesMessage = rawPayload;

  // Unpack SNS message if present
  if (rawPayload.Type === "Notification" && typeof rawPayload.Message === "string") {
    try {
      sesMessage = JSON.parse(rawPayload.Message);
    } catch {
      // Keep raw
    }
  }

  const eventTypeRaw = String(sesMessage.eventType || sesMessage.notificationType || "").toUpperCase();
  const mail = (sesMessage.mail as Record<string, unknown>) || {};
  const providerMessageId = mail.messageId ? String(mail.messageId) : undefined;
  const recipients = Array.isArray(mail.destination) ? mail.destination.map((e) => String(e)) : [];
  const primaryRecipient = recipients[0] ? normalizeEmail(recipients[0]) : "unknown@recipient.com";

  let eventType: EmailEventType;
  let bounceType: BounceClassification | undefined;
  let bounceReason: string | undefined;
  let complaintFeedback: string | undefined;

  switch (eventTypeRaw) {
    case "SEND":
      eventType = EmailEventType.SENT;
      break;
    case "DELIVERY":
      eventType = EmailEventType.DELIVERED;
      break;
    case "OPEN":
      eventType = EmailEventType.OPENED;
      break;
    case "CLICK":
      eventType = EmailEventType.CLICKED;
      break;
    case "BOUNCE": {
      eventType = EmailEventType.BOUNCED;
      const bounce = (sesMessage.bounce as Record<string, unknown>) || {};
      const bType = bounce.bounceType ? String(bounce.bounceType) : undefined;
      const bSubType = bounce.bounceSubType ? String(bounce.bounceSubType) : undefined;
      const bouncedRecipients = Array.isArray(bounce.bouncedRecipients) ? (bounce.bouncedRecipients[0] as Record<string, unknown>) : undefined;
      const diag = bouncedRecipients?.diagnosticCode ? String(bouncedRecipients.diagnosticCode) : undefined;
      const classification = classifyBounce("SES", bSubType, bType, diag);
      bounceType = classification.type;
      bounceReason = classification.reason;
      break;
    }
    case "COMPLAINT": {
      eventType = EmailEventType.COMPLAINT;
      const complaint = (sesMessage.complaint as Record<string, unknown>) || {};
      complaintFeedback = complaint.complaintFeedbackType ? String(complaint.complaintFeedbackType) : "abuse";
      break;
    }
    default:
      eventType = EmailEventType.SENT;
  }

  const eventId = String(
    sesMessage.eventId ||
    rawPayload.MessageId ||
    `ses-${providerMessageId || Date.now()}-${eventType}`
  );

  return [
    {
      providerType: EmailProviderType.SES,
      providerEventId: eventId,
      providerMessageId,
      eventType,
      recipient: primaryRecipient,
      occurredAt: mail.timestamp ? new Date(String(mail.timestamp)) : new Date(),
      bounceType,
      bounceReason,
      complaintFeedback,
      rawPayload,
    },
  ];
}

/**
 * Strict payload validator for normalized email webhook events.
 * Enforces schema correctness, enum validity, RFC 5322 email syntax, and timestamp rationality.
 */
export function validateNormalizedEvent(
  event: NormalizedEmailWebhookEvent
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!event || typeof event !== "object") {
    return { valid: false, errors: ["Event payload must be a non-null object"] };
  }

  // 1. providerType validation
  const validProviderTypes = Object.values(EmailProviderType);
  if (!event.providerType || !validProviderTypes.includes(event.providerType)) {
    errors.push(`Invalid providerType: '${String(event.providerType)}'. Expected one of ${validProviderTypes.join(", ")}`);
  }

  // 2. providerEventId validation
  if (!event.providerEventId || typeof event.providerEventId !== "string" || event.providerEventId.trim().length === 0) {
    errors.push("providerEventId is required and must be a non-empty string");
  }

  // 3. eventType validation
  const validEventTypes = Object.values(EmailEventType);
  if (!event.eventType || !validEventTypes.includes(event.eventType)) {
    errors.push(`Invalid eventType: '${String(event.eventType)}'. Expected one of ${validEventTypes.join(", ")}`);
  }

  // 4. recipient validation
  if (!event.recipient || typeof event.recipient !== "string") {
    errors.push("recipient is required and must be a string");
  } else {
    const trimmed = event.recipient.trim();
    // RFC 5322 simplified email regex
    const emailRegex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;
    if (trimmed.length === 0 || !emailRegex.test(trimmed)) {
      errors.push(`Invalid recipient email format: '${event.recipient}'`);
    }
  }

  // 5. occurredAt validation
  if (event.occurredAt) {
    if (!(event.occurredAt instanceof Date) || isNaN(event.occurredAt.getTime())) {
      errors.push("occurredAt must be a valid Date object");
    } else {
      const nowMs = Date.now();
      const maxFutureSkewMs = 24 * 60 * 60 * 1000; // 24 hours
      if (event.occurredAt.getTime() > nowMs + maxFutureSkewMs) {
        errors.push(`occurredAt cannot be in the future (> 24h skew): ${event.occurredAt.toISOString()}`);
      }
    }
  }

  // 6. bounceType validation
  if (event.eventType === EmailEventType.BOUNCED) {
    if (event.bounceType && event.bounceType !== "HARD_BOUNCE" && event.bounceType !== "SOFT_BOUNCE") {
      errors.push(`Invalid bounceType: '${String(event.bounceType)}'. Expected 'HARD_BOUNCE' or 'SOFT_BOUNCE'`);
    }
  }

  // 7. Optional identifier validations
  if (event.deliveryId !== undefined && typeof event.deliveryId !== "string") {
    errors.push("deliveryId must be a string if provided");
  }
  if (event.providerMessageId !== undefined && typeof event.providerMessageId !== "string") {
    errors.push("providerMessageId must be a string if provided");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
