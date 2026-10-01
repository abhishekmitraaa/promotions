/**
 * Shared Lifecycle Abstractions
 *
 * Implements monotonic delivery state transitions and campaign lifecycle state machines
 * across all communication channels (WhatsApp, Email, SMS, Push).
 *
 * Enforces:
 * 1. Monotonic status progression (e.g., READ cannot regress to SENT; terminal states cannot revert).
 * 2. Out-of-order event resilience (common in webhooks from Meta, Resend, SendGrid, Twilio).
 * 3. Channel-specific status normalization to unified lifecycle states.
 */

import {
  ChannelType,
  UnifiedCampaignStatus,
  UnifiedDeliveryStatus,
  UnifiedEventType,
} from "./types";

// =============================================================================
// 1. Monotonic Delivery State Machine
// =============================================================================

/**
 * Rank assigned to progressive delivery states.
 * Higher rank always supersedes lower rank unless the target is a terminal failure.
 */
export const DELIVERY_STATUS_RANK: Record<UnifiedDeliveryStatus, number> = {
  QUEUED: 0,
  PROCESSING: 10,
  SENT: 20,
  DELIVERED: 30,
  READ_OR_OPENED: 40,
  // Terminal failure states have distinct representation
  FAILED: 90,
  BOUNCED: 95,
  COMPLAINED: 100,
};

export const TERMINAL_DELIVERY_STATUSES: readonly UnifiedDeliveryStatus[] = [
  "FAILED",
  "BOUNCED",
  "COMPLAINED",
] as const;

export function isTerminalDeliveryStatus(status: UnifiedDeliveryStatus): boolean {
  return (
    status === "FAILED" ||
    status === "BOUNCED" ||
    status === "COMPLAINED"
  );
}

export interface TransitionEvaluation {
  allowed: boolean;
  newStatus: UnifiedDeliveryStatus;
  isTerminal: boolean;
  reason?: string;
}

/**
 * Evaluates whether a delivery status transition is valid according to monotonic rules.
 * If out-of-order event arrives (e.g. SENT arrives after DELIVERED), it gracefully preserves
 * the higher-rank status without corrupting the record.
 */
export function evaluateDeliveryStatusTransition(
  currentStatus: UnifiedDeliveryStatus,
  incomingStatus: UnifiedDeliveryStatus
): TransitionEvaluation {
  // If already identical, no-op allowed
  if (currentStatus === incomingStatus) {
    return {
      allowed: true,
      newStatus: currentStatus,
      isTerminal: isTerminalDeliveryStatus(currentStatus),
    };
  }

  // Terminal failure states cannot be overridden by non-terminal progressive events
  if (isTerminalDeliveryStatus(currentStatus)) {
    // If incoming is COMPLAINED and current is BOUNCED/FAILED, complaint supersedes
    if (incomingStatus === "COMPLAINED") {
      return {
        allowed: true,
        newStatus: "COMPLAINED",
        isTerminal: true,
      };
    }
    return {
      allowed: false,
      newStatus: currentStatus,
      isTerminal: true,
      reason: `Cannot transition from terminal state ${currentStatus} to ${incomingStatus}`,
    };
  }

  // If incoming is terminal, it always overrides progressive states
  if (isTerminalDeliveryStatus(incomingStatus)) {
    return {
      allowed: true,
      newStatus: incomingStatus,
      isTerminal: true,
    };
  }

  // Progressive states: strictly monotonic (cannot regress)
  const currentRank = DELIVERY_STATUS_RANK[currentStatus];
  const incomingRank = DELIVERY_STATUS_RANK[incomingStatus];

  if (incomingRank > currentRank) {
    return {
      allowed: true,
      newStatus: incomingStatus,
      isTerminal: false,
    };
  }

  // Out-of-order progression (e.g., received SENT after DELIVERED)
  return {
    allowed: false,
    newStatus: currentStatus,
    isTerminal: false,
    reason: `Ignored out-of-order transition from higher rank ${currentStatus} (rank ${currentRank}) to lower rank ${incomingStatus} (rank ${incomingRank})`,
  };
}

// =============================================================================
// 2. Campaign Lifecycle State Machine
// =============================================================================

export const VALID_CAMPAIGN_TRANSITIONS: Record<
  UnifiedCampaignStatus,
  readonly UnifiedCampaignStatus[]
> = {
  DRAFT: ["SCHEDULED", "RUNNING", "CANCELLED"],
  SCHEDULED: ["RUNNING", "CANCELLED", "PAUSED"],
  RUNNING: ["PAUSED", "COMPLETED", "FAILED", "CANCELLED"],
  PAUSED: ["RUNNING", "CANCELLED"],
  COMPLETED: [], // Terminal
  FAILED: ["RUNNING"], // Can retry failed campaigns
  CANCELLED: [], // Terminal
};

export function canTransitionCampaignStatus(
  current: UnifiedCampaignStatus,
  next: UnifiedCampaignStatus
): boolean {
  if (current === next) return true;
  const allowed = VALID_CAMPAIGN_TRANSITIONS[current] || [];
  return allowed.includes(next);
}

export function isTerminalCampaignStatus(status: UnifiedCampaignStatus): boolean {
  return status === "COMPLETED" || status === "CANCELLED";
}

// =============================================================================
// 3. Channel Normalizers (Anti-Corruption Layer)
// =============================================================================

/**
 * Normalizes WhatsApp webhook delivery status to UnifiedDeliveryStatus.
 * WhatsApp Meta Cloud API statuses: sent, delivered, read, failed.
 */
export function normalizeWhatsAppDeliveryStatus(rawStatus: string): UnifiedDeliveryStatus {
  const normalized = rawStatus.toLowerCase().trim();
  switch (normalized) {
    case "sent":
      return "SENT";
    case "delivered":
      return "DELIVERED";
    case "read":
      return "READ_OR_OPENED";
    case "failed":
      return "FAILED";
    case "queued":
    case "accepted":
      return "QUEUED";
    case "processing":
    case "sending":
      return "PROCESSING";
    default:
      return "PROCESSING";
  }
}

/**
 * Normalizes Email delivery status (from Resend, SendGrid, SMTP worker, or DB) to UnifiedDeliveryStatus.
 */
export function normalizeEmailDeliveryStatus(rawStatus: string): UnifiedDeliveryStatus {
  const normalized = rawStatus.toLowerCase().trim();
  switch (normalized) {
    case "queued":
      return "QUEUED";
    case "processing":
    case "sending":
      return "PROCESSING";
    case "sent":
      return "SENT";
    case "delivered":
      return "DELIVERED";
    case "opened":
    case "clicked":
      return "READ_OR_OPENED";
    case "bounced":
      return "BOUNCED";
    case "complained":
    case "spam":
      return "COMPLAINED";
    case "failed":
    case "rejected":
      return "FAILED";
    default:
      return "PROCESSING";
  }
}

/**
 * Normalizes channel-specific event types to UnifiedEventType.
 */
export function normalizeChannelEventType(
  channel: ChannelType,
  rawEventType: string
): UnifiedEventType {
  const clean = rawEventType.toLowerCase().trim();

  switch (channel) {
    case "WHATSAPP":
      switch (clean) {
        case "sent":
          return "SENT";
        case "delivered":
          return "DELIVERED";
        case "read":
          return "READ_OR_OPENED";
        case "failed":
          return "FAILED";
        case "opt_out":
        case "stop":
          return "OPT_OUT";
        default:
          return "DELIVERED";
      }

    case "EMAIL":
      switch (clean) {
        case "queued":
          return "QUEUED";
        case "sent":
          return "SENT";
        case "delivered":
          return "DELIVERED";
        case "open":
        case "opened":
          return "READ_OR_OPENED";
        case "click":
        case "clicked":
          return "CLICKED";
        case "bounce":
        case "bounced":
          return "BOUNCED";
        case "complaint":
        case "complained":
        case "spam":
          return "COMPLAINT";
        case "unsubscribe":
        case "unsubscribed":
          return "OPT_OUT";
        case "failed":
        case "rejected":
          return "FAILED";
        default:
          return "DELIVERED";
      }

    case "SMS":
      switch (clean) {
        case "sent":
          return "SENT";
        case "delivered":
          return "DELIVERED";
        case "failed":
        case "undelivered":
          return "FAILED";
        case "opt_out":
        case "stop":
          return "OPT_OUT";
        default:
          return "DELIVERED";
      }

    case "PUSH":
      switch (clean) {
        case "sent":
          return "SENT";
        case "delivered":
        case "received":
          return "DELIVERED";
        case "opened":
        case "interacted":
          return "READ_OR_OPENED";
        case "failed":
        case "unregistered":
          return "FAILED";
        default:
          return "DELIVERED";
      }

    default:
      return "DELIVERED";
  }
}
