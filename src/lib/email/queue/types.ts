/**
 * Queue Definitions, Job Types, and Idempotency Contracts for Email Queues
 */

export const QUEUE_NAMES = {
  TRANSACTIONAL: "email-transactional",
  CAMPAIGN: "email-campaign",
  EVENTS: "email-events",
} as const;

export type EmailQueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export const JOB_NAMES = {
  SEND_TRANSACTIONAL: "send-transactional",
  SEND_CAMPAIGN_RECIPIENT: "send-campaign-recipient",
  TRIGGER_SCHEDULED_CAMPAIGN: "trigger-scheduled-campaign",
  PROCESS_EMAIL_EVENT: "process-email-event",
} as const;

export type EmailJobName = (typeof JOB_NAMES)[keyof typeof JOB_NAMES];

/**
 * Transactional Job Payload
 * Carries authoritative database ID instead of giant email body blobs.
 */
export interface TransactionalJobData {
  deliveryId: string;
  clientId: string;
  category: "TRANSACTIONAL";
  attempt?: number;
}

/**
 * Campaign Recipient / Trigger Job Payload
 */
export interface CampaignJobData {
  campaignRecipientId?: string;
  campaignId: string;
  clientId: string;
  category: "PROMOTIONAL";
}

/**
 * Email Event Job Payload
 */
export interface EmailEventJobData {
  eventId: string;
  clientId?: string;
  eventType: string;
  providerType: string;
  providerMessageId?: string;
}

/**
 * Generates stable business-level idempotency Job ID for transactional emails.
 * BullMQ uses this queue-scoped ID to prevent duplicate job insertion.
 */
export function getTransactionalJobId(deliveryId: string): string {
  if (!deliveryId || typeof deliveryId !== "string") {
    throw new Error("deliveryId is required to generate transactional job ID");
  }
  return `email-transactional-${deliveryId.trim()}`;
}

/**
 * Generates stable business-level idempotency Job ID for campaign emails.
 */
export function getCampaignJobId(campaignRecipientId: string): string {
  if (!campaignRecipientId || typeof campaignRecipientId !== "string") {
    throw new Error("campaignRecipientId is required to generate campaign job ID");
  }
  return `email-campaign-${campaignRecipientId.trim()}`;
}

/**
 * Generates stable business-level idempotency Job ID for email events.
 */
export function getEventJobId(eventId: string): string {
  if (!eventId || typeof eventId !== "string") {
    throw new Error("eventId is required to generate event job ID");
  }
  return `email-event-${eventId.trim()}`;
}

/**
 * Error thrown for temporary/retryable failures (429, 503, provider timeout, network error).
 * BullMQ will retry this job according to backoff configuration.
 */
export class RetryableEmailError extends Error {
  readonly isRetryable = true;
  readonly code: string;

  constructor(message: string, code: string = "RETRYABLE_ERROR") {
    super(message);
    this.name = "RetryableEmailError";
    this.code = code;
  }
}

/**
 * Error thrown for permanent failures (invalid email, suppression, authorization rejection).
 * BullMQ will NOT retry this job.
 */
export class PermanentEmailError extends Error {
  readonly isRetryable = false;
  readonly code: string;

  constructor(message: string, code: string = "PERMANENT_ERROR") {
    super(message);
    this.name = "PermanentEmailError";
    this.code = code;
  }
}

/**
 * Helper to determine whether an error or status code is transient/retryable.
 */
export function isRetryableError(err: unknown): boolean {
  if (!err) return false;
  if (err instanceof RetryableEmailError) return true;
  if (err instanceof PermanentEmailError) return false;

  const msg = err instanceof Error ? err.message : String(err);
  const errObj = typeof err === "object" && err !== null ? (err as Record<string, unknown>) : null;
  const code = typeof errObj?.code === "string" ? errObj.code : undefined;
  const status = typeof errObj?.status === "number" ? errObj.status : undefined;

  if (status === 429 || status === 503 || status === 504 || status === 502) return true;
  if (code === "RATE_LIMIT_EXCEEDED" || code === "SERVICE_UNAVAILABLE" || code === "ETIMEDOUT" || code === "ECONNRESET") {
    return true;
  }
  if (msg.includes("429") || msg.includes("timeout") || msg.includes("network") || msg.includes("ECONNRESET")) {
    return true;
  }

  return false;
}
