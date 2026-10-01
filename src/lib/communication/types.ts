/**
 * Unified Multi-Channel Communication Platform Domain Types & Contracts
 *
 * Defines the shared conceptual domain models across all messaging channels:
 * - WhatsApp (Meta Cloud API / Business Solution Provider)
 * - Email (SMTP, Gmail API, Resend, SendGrid)
 * - Future SMS (Twilio, AWS SNS, MessageBird)
 * - Future Push Notifications (Firebase Cloud Messaging, Apple Push Notification service)
 *
 * Architectural Boundary Rules:
 * 1. ZERO Premature Database Schema Merging: Existing concrete tables (e.g., Message,
 *    EmailDelivery, EmailContact) remain authoritative for their respective channels.
 * 2. Shared Abstraction Layer: Unified contracts govern channel routing, lifecycle transitions,
 *    suppression verification, consent enforcement, and cross-channel analytics.
 * 3. 100% Backward Compatibility: Existing WhatsApp and Email APIs, workers, and services
 *    continue executing without breaking changes.
 */

// =============================================================================
// 1. Channel & Category Enums
// =============================================================================

export type ChannelType = "WHATSAPP" | "EMAIL" | "SMS" | "PUSH";

export const CHANNELS: readonly ChannelType[] = [
  "WHATSAPP",
  "EMAIL",
  "SMS",
  "PUSH",
] as const;

export type UnifiedMessageCategory =
  | "TRANSACTIONAL"
  | "PROMOTIONAL"
  | "UTILITY"
  | "AUTHENTICATION";

export const MESSAGE_CATEGORIES: readonly UnifiedMessageCategory[] = [
  "TRANSACTIONAL",
  "PROMOTIONAL",
  "UTILITY",
  "AUTHENTICATION",
] as const;

// =============================================================================
// 2. Shared Delivery & Event Status Enums (Monotonic Lifecycle)
// =============================================================================

export type UnifiedDeliveryStatus =
  | "QUEUED"
  | "PROCESSING"
  | "SENT"
  | "DELIVERED"
  | "READ_OR_OPENED"
  | "FAILED"
  | "BOUNCED"
  | "COMPLAINED";

export type UnifiedEventType =
  | "QUEUED"
  | "SENT"
  | "DELIVERED"
  | "READ_OR_OPENED"
  | "CLICKED"
  | "FAILED"
  | "BOUNCED"
  | "COMPLAINT"
  | "OPT_OUT";

export type UnifiedCampaignStatus =
  | "DRAFT"
  | "SCHEDULED"
  | "RUNNING"
  | "PAUSED"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

export type UnifiedFailureCategory =
  | "AUTHENTICATION_FAILED"
  | "SPAM_BLOCK"
  | "INVALID_DESTINATION"
  | "MAILBOX_OR_INBOX_FULL"
  | "NETWORK_OR_DNS_FAILURE"
  | "RATE_LIMITED"
  | "PROVIDER_ERROR"
  | "UNREGISTERED_DEVICE"
  | "OPTED_OUT_OR_SUPPRESSED"
  | "UNKNOWN";

export type UnifiedSuppressionReason =
  | "HARD_BOUNCE"
  | "COMPLAINT"
  | "UNSUBSCRIBED"
  | "USER_BLOCKED"
  | "INVALID_DESTINATION"
  | "MANUAL"
  | "DEVICE_UNREGISTERED";

export type ConsentStatus =
  | "OPTED_IN"
  | "OPTED_OUT"
  | "EXPLICIT_PROMOTIONAL"
  | "TRANSACTIONAL_ONLY"
  | "PENDING";

// =============================================================================
// 3. Shared Conceptual Entity Contracts
// =============================================================================

/**
 * Shared Contact Concept
 * Represents an omnichannel identity resolving channel-specific reachability destinations.
 */
export interface UnifiedContact {
  id: string;
  clientId: string; // Tenant boundary
  identifiers: {
    phoneNumber?: string; // WhatsApp & SMS (E.164 normalized)
    email?: string;       // Email (RFC 5322 normalized)
    deviceTokens?: string[]; // Push notification tokens (FCM/APNs)
  };
  channelReachability: Record<
    ChannelType,
    {
      reachable: boolean;
      destination?: string;
      verified: boolean;
      suppressed: boolean;
      suppressionReason?: UnifiedSuppressionReason;
      consentStatus: ConsentStatus;
    }
  >;
  attributes: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Shared Message Envelope Concept
 * Channel-agnostic dispatch request envelope.
 */
export interface UnifiedMessageRequest {
  clientId: string; // Mandatory tenant isolation
  channel: ChannelType;
  category: UnifiedMessageCategory;
  recipient: {
    contactId?: string;
    destination?: string; // E.164 phone, email address, or device token
    phone?: string;
    email?: string;
    deviceToken?: string;
    name?: string;
    variables?: Record<string, unknown>;
  };
  content: {
    text?: string;
    subject?: string; // Email / Push title
    html?: string;    // Email body
    templateId?: string;
    templateName?: string;
    templateParameters?: unknown[];
    mediaUrls?: string[];
    actionButtons?: Array<{
      id: string;
      title: string;
      type: "URL" | "QUICK_REPLY" | "PHONE_NUMBER";
      value: string;
    }>;
  };
  sender?: {
    identityId?: string;
    fromAddress?: string;
    replyTo?: string;
  };
  idempotencyKey?: string;
  campaignId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Result returned by a channel adapter dispatch.
 */
export interface UnifiedSendResult {
  success: boolean;
  channel: ChannelType;
  deliveryId: string;
  providerMessageId?: string;
  status: UnifiedDeliveryStatus;
  sentAt?: Date;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
    failureCategory?: UnifiedFailureCategory;
  };
}

/**
 * Shared Delivery Attempt Concept
 */
export interface UnifiedDeliveryRecord {
  id: string;
  clientId: string;
  channel: ChannelType;
  category: UnifiedMessageCategory;
  status: UnifiedDeliveryStatus;
  providerType: string;
  providerMessageId?: string | null;
  from: string;
  to: string;
  campaignId?: string | null;
  attemptCount: number;
  sentAt?: Date | null;
  deliveredAt?: Date | null;
  readOrOpenedAt?: Date | null;
  failedAt?: Date | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  failureCategory?: UnifiedFailureCategory | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Shared Event Concept
 * Authoritative normalized incoming event from webhook or telemetry.
 */
export interface UnifiedNormalizedEvent {
  id: string;
  clientId?: string;
  channel: ChannelType;
  eventType: UnifiedEventType;
  deliveryId?: string;
  providerEventId: string;
  providerMessageId?: string;
  recipient: string;
  timestamp: Date;
  payload: Record<string, unknown>;
  bounceType?: "HARD" | "SOFT";
  clickUrl?: string;
}

/**
 * Shared Template Concept
 * Cross-channel template interface with channel-specific rendering variants.
 */
export interface UnifiedTemplate {
  id: string;
  clientId: string;
  name: string;
  category: UnifiedMessageCategory;
  supportedChannels: ChannelType[];
  variableSchema?: Record<string, { type: "string" | "number" | "boolean"; required: boolean; defaultValue?: unknown }>;
  channelVariants: {
    whatsapp?: {
      metaTemplateName: string;
      language: string;
      components: unknown[];
    };
    email?: {
      version: number;
      subject: string;
      htmlContent: string;
      textContent?: string;
    };
    sms?: {
      bodyTemplate: string;
      maxSegments?: number;
    };
    push?: {
      titleTemplate: string;
      bodyTemplate: string;
      dataPayload?: Record<string, unknown>;
      imageUrl?: string;
    };
  };
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Shared Campaign Concept
 */
export interface UnifiedCampaign {
  id: string;
  clientId: string;
  name: string;
  description?: string | null;
  channel: ChannelType | "OMNICHANNEL";
  status: UnifiedCampaignStatus;
  category: UnifiedMessageCategory;
  scheduledAt?: Date | null;
  startedAt?: Date | null;
  completedAt?: Date | null;
  targetAudience: {
    type: "LIST" | "SEGMENT" | "CRITERIA";
    targetId?: string;
    criteria?: unknown;
  };
  metrics: {
    totalRecipients: number;
    sent: number;
    delivered: number;
    readOrOpened: number;
    clicked: number;
    bounced: number;
    complaints: number;
    unsubscribedOrOptOut: number;
  };
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Shared Suppression Concept
 */
export interface UnifiedSuppression {
  id: string;
  clientId: string;
  channel: ChannelType | "ALL";
  destination: string; // phone number, email address, or device token
  normalizedDestination: string;
  reason: UnifiedSuppressionReason;
  source?: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
}

/**
 * Shared Consent Concept
 */
export interface UnifiedConsent {
  id: string;
  clientId: string;
  contactId: string;
  channel: ChannelType;
  category: UnifiedMessageCategory;
  status: ConsentStatus;
  consentTimestamp: Date;
  consentSource: string;
  proof?: string;
  unsubscribedAt?: Date | null;
  unsubscribeReason?: string | null;
}

/**
 * Shared Provider Health Result Concept
 */
export interface UnifiedProviderHealthResult {
  providerType: string;
  channel: ChannelType;
  status: "HEALTHY" | "DEGRADED" | "UNHEALTHY";
  latencyMs: number;
  checkedAt: Date;
  message?: string;
  capabilities: {
    supportsTemplates: boolean;
    supportsMedia: boolean;
    supportsTwoWay: boolean;
    supportsDeliveryReceipts: boolean;
    supportsReadReceipts: boolean;
    maxThroughputPerSecond?: number;
  };
}

/**
 * Shared Analytics Contracts
 */
export interface UnifiedRateMetrics {
  sent: number;
  delivered: number;
  readOrOpened: number;
  clicked: number;
  failed: number;
  bounced: number;
  complaints: number;
  optOuts: number;

  deliveryRate: number;      // delivered / sent
  readOrOpenRate: number;    // readOrOpened / delivered
  clickThroughRate: number;  // clicked / delivered
  clickToOpenRate: number;   // clicked / readOrOpened
  bounceRate: number;        // bounced / sent
  complaintRate: number;     // complaints / delivered
  optOutRate: number;        // optOuts / delivered
}

export interface UnifiedAnalyticsSummary extends UnifiedRateMetrics {
  byChannel: Record<ChannelType, UnifiedRateMetrics>;
  timeframe: {
    startDate: Date;
    endDate: Date;
  };
}
