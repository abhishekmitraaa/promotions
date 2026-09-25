/**
 * Provider Webhook Types, Normalization Models, and Signature Contracts
 */

import { EmailEventType, EmailProviderType } from "@prisma/client";

export type BounceClassification = "HARD_BOUNCE" | "SOFT_BOUNCE";

export interface NormalizedEmailWebhookEvent {
  providerType: EmailProviderType;
  clientId?: string;
  providerEventId: string;
  providerMessageId?: string;
  deliveryId?: string;
  eventType: EmailEventType;
  recipient: string;
  occurredAt: Date;
  bounceType?: BounceClassification;
  bounceReason?: string;
  complaintFeedback?: string;
  rawPayload: Record<string, unknown> | string;
  metadata?: Record<string, unknown>;
}

export interface WebhookVerificationResult {
  valid: boolean;
  error?: string;
  provider?: string;
}

export interface ProviderWebhookHandler {
  providerType: EmailProviderType;
  verifySignature(
    rawBody: string,
    headers: Headers,
    secret?: string
  ): Promise<WebhookVerificationResult>;
  normalizePayload(
    rawBody: string,
    headers: Headers
  ): NormalizedEmailWebhookEvent[];
}
