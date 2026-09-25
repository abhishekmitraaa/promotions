/**
 * Foundational Email Domain Types & Interfaces
 *
 * Establishes core data contracts for the email platform foundation.
 * Provider implementations and background queue processors are added in subsequent phases.
 */

import {
  EmailProviderType,
  EmailProviderStatus,
  EmailType,
  EmailContactStatus,
  EmailSubscriptionStatus,
  EmailTemplateType,
  EmailCampaignStatus,
  EmailDeliveryStatus,
  EmailEventType,
  EmailSuppressionReason,
} from "@prisma/client";

// Re-export Prisma enums for domain consumers
export {
  EmailProviderType,
  EmailProviderStatus,
  EmailType,
  EmailContactStatus,
  EmailSubscriptionStatus,
  EmailTemplateType,
  EmailCampaignStatus,
  EmailDeliveryStatus,
  EmailEventType,
  EmailSuppressionReason,
};

// Enum validation type guards
export function isValidTemplateType(val: unknown): val is EmailTemplateType {
  return typeof val === "string" && Object.values(EmailTemplateType).includes(val as EmailTemplateType);
}

export function isValidCampaignStatus(val: unknown): val is EmailCampaignStatus {
  return typeof val === "string" && Object.values(EmailCampaignStatus).includes(val as EmailCampaignStatus);
}

export function isValidSuppressionReason(val: unknown): val is EmailSuppressionReason {
  return typeof val === "string" && Object.values(EmailSuppressionReason).includes(val as EmailSuppressionReason);
}

export function isValidEmailType(val: unknown): val is EmailType {
  return typeof val === "string" && Object.values(EmailType).includes(val as EmailType);
}

export function isValidContactStatus(val: unknown): val is EmailContactStatus {
  return typeof val === "string" && Object.values(EmailContactStatus).includes(val as EmailContactStatus);
}

export function isValidSubscriptionStatus(val: unknown): val is EmailSubscriptionStatus {
  return typeof val === "string" && Object.values(EmailSubscriptionStatus).includes(val as EmailSubscriptionStatus);
}

export function isValidDeliveryStatus(val: unknown): val is EmailDeliveryStatus {
  return typeof val === "string" && Object.values(EmailDeliveryStatus).includes(val as EmailDeliveryStatus);
}

export function isValidEventType(val: unknown): val is EmailEventType {
  return typeof val === "string" && Object.values(EmailEventType).includes(val as EmailEventType);
}

export function isValidProviderType(val: unknown): val is EmailProviderType {
  return typeof val === "string" && Object.values(EmailProviderType).includes(val as EmailProviderType);
}

/**
 * Normalized email address representation.
 */
export interface EmailAddress {
  email: string;
  name?: string;
}

export type EmailRecipientInput = string | EmailAddress;
export type EmailRecipient = EmailRecipientInput;

/**
 * Template variable dictionary.
 */
export type EmailTemplateData = Record<string, string | number | boolean | null | undefined>;

/**
 * Email attachment contract.
 */
export interface EmailAttachment {
  filename: string;
  content: Buffer | string;
  contentType: string;
  disposition?: "attachment" | "inline";
  contentId?: string;
}

/**
 * Campaign recipient snapshot representation.
 */
export interface CampaignRecipient {
  email: string;
  contactId?: string;
  name?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Standardized request contract for sending an email.
 */
export interface EmailSendRequest {
  /**
   * Mandatory tenant/client scoping.
   */
  clientId: string;

  /**
   * Email classification: TRANSACTIONAL vs PROMOTIONAL.
   */
  type: EmailType;

  /**
   * Recipient(s).
   */
  to: EmailRecipientInput | EmailRecipientInput[];

  /**
   * Sender identity.
   */
  from?: EmailRecipientInput;

  /**
   * Reply-To address.
   */
  replyTo?: EmailRecipientInput;

  /**
   * Carbon Copy recipient(s).
   */
  cc?: EmailRecipientInput | EmailRecipientInput[];

  /**
   * Blind Carbon Copy recipient(s).
   */
  bcc?: EmailRecipientInput | EmailRecipientInput[];

  /**
   * Email subject.
   */
  subject: string;

  /**
   * HTML body.
   */
  html?: string;

  /**
   * Plain text fallback.
   */
  text?: string;

  /**
   * Template reference.
   */
  templateId?: string;
  templateVersionId?: string;
  templateData?: EmailTemplateData;

  /**
   * Custom RFC 2822 headers (e.g. List-Unsubscribe).
   */
  headers?: Record<string, string>;

  /**
   * Attachments.
   */
  attachments?: EmailAttachment[];

  /**
   * Idempotency key for deduplication.
   */
  idempotencyKey?: string;

  /**
   * Association with a campaign recipient (if dispatched from a campaign).
   */
  campaignRecipientId?: string;

  /**
   * Reference to an external or transactional entity (e.g. OTP verification ID).
   */
  transactionalReference?: string;

  /**
   * Arbitrary metadata.
   */
  metadata?: Record<string, unknown>;
}

/**
 * Detailed error contract when sending fails.
 */
export interface EmailSendError {
  code: string;
  message: string;
  retryable: boolean;
  statusCode?: number;
}

/**
 * Result returned by an email delivery attempt.
 */
export interface EmailSendResult {
  accepted: boolean;
  success: boolean;
  providerName: string;
  providerType: EmailProviderType;
  providerMessageId?: string;
  providerStatus: string;
  deliveryId?: string;
  sentAt?: Date;
  error?: EmailSendError;
}

/**
 * Provider interface contract that future provider implementations must fulfill.
 */
export interface EmailProvider {
  readonly id: string;
  readonly name: string;
  readonly providerType: EmailProviderType;

  /**
   * Dispatches an email request through this provider.
   */
  send(request: EmailSendRequest): Promise<EmailSendResult>;

  /**
   * Optional health or credential verification.
   */
  verifyCredentials?(): Promise<{ valid: boolean; error?: string }>;
}
