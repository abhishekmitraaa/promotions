/**
 * Unified Lifecycle State Machines
 *
 * Implements monotonic progression rules and validation for:
 * 1. Delivery State Machine (QUEUED -> PROCESSING -> SENT -> DELIVERED -> READ_OR_OPENED)
 *    Ensures out-of-order webhook events (e.g. DELIVERED arriving before SENT)
 *    never regress authoritative delivery state.
 * 2. Campaign State Machine (DRAFT -> SCHEDULED/RUNNING -> COMPLETED/FAILED/CANCELLED)
 * 3. Channel status mappers (WhatsApp & Email status normalization)
 */

import {
  UnifiedDeliveryStatus,
  UnifiedCampaignStatus,
} from "./types";

// =============================================================================
// 1. Delivery Monotonic State Precedence
// =============================================================================

const DELIVERY_PRECEDENCE: Record<UnifiedDeliveryStatus, number> = {
  QUEUED: 0,
  PROCESSING: 1,
  SENT: 2,
  DELIVERED: 3,
  READ_OR_OPENED: 4,
  BOUNCED: 99,     // Terminal negative state
  COMPLAINED: 99,  // Terminal negative state
  FAILED: 99,      // Terminal negative state
};

const TERMINAL_DELIVERY_STATUSES: ReadonlySet<UnifiedDeliveryStatus> = new Set([
  "READ_OR_OPENED",
  "BOUNCED",
  "COMPLAINED",
  "FAILED",
]);

/**
 * Returns true if the delivery status is terminal and cannot transition further.
 */
export function isTerminalDeliveryStatus(status: UnifiedDeliveryStatus): boolean {
  return TERMINAL_DELIVERY_STATUSES.has(status);
}

/**
 * Validates whether a delivery status can transition to target status.
 * Enforces monotonic progression so states never regress.
 */
export function canTransitionDelivery(
  current: UnifiedDeliveryStatus,
  target: UnifiedDeliveryStatus
): boolean {
  if (current === target) return true;

  // Once terminal failed/bounced/complained, cannot transition to non-terminal
  if ((current === "BOUNCED" || current === "COMPLAINED" || current === "FAILED") &&
      target !== "BOUNCED" && target !== "COMPLAINED" && target !== "FAILED") {
    return false;
  }

  // Once READ_OR_OPENED, cannot regress to lower states
  if (current === "READ_OR_OPENED") {
    // Only complaint or bounce can record on top if needed, otherwise no regression
    return target === "COMPLAINED" || target === "BOUNCED";
  }

  // Terminal failures can always be accepted from non-terminal states
  if (target === "FAILED" || target === "BOUNCED" || target === "COMPLAINED") {
    return true;
  }

  const currentRank = DELIVERY_PRECEDENCE[current] ?? 0;
  const targetRank = DELIVERY_PRECEDENCE[target] ?? 0;

  return targetRank >= currentRank;
}

/**
 * Resolves the next delivery status given current state and an incoming state,
 * preventing regression if events arrive out of chronological order.
 */
export function resolveNextDeliveryStatus(
  current: UnifiedDeliveryStatus,
  incoming: UnifiedDeliveryStatus
): UnifiedDeliveryStatus {
  if (canTransitionDelivery(current, incoming)) {
    return incoming;
  }
  return current;
}

/**
 * Evaluates whether a delivery status transition is allowed and determines the resulting status.
 */
export function evaluateDeliveryStatusTransition(
  current: UnifiedDeliveryStatus,
  target: UnifiedDeliveryStatus
): { allowed: boolean; newStatus: UnifiedDeliveryStatus } {
  const allowed = canTransitionDelivery(current, target);
  return {
    allowed,
    newStatus: allowed ? target : current,
  };
}

// =============================================================================
// 2. Campaign Lifecycle State Machine
// =============================================================================

const VALID_CAMPAIGN_TRANSITIONS: Record<UnifiedCampaignStatus, ReadonlySet<UnifiedCampaignStatus>> = {
  DRAFT: new Set(["SCHEDULED", "RUNNING", "CANCELLED"]),
  SCHEDULED: new Set(["RUNNING", "CANCELLED"]),
  RUNNING: new Set(["PAUSED", "COMPLETED", "FAILED", "CANCELLED"]),
  PAUSED: new Set(["RUNNING", "CANCELLED"]),
  COMPLETED: new Set([]), // Terminal
  FAILED: new Set(["RUNNING", "CANCELLED"]), // Can retry or cancel
  CANCELLED: new Set([]), // Terminal
};

/**
 * Validates whether a campaign can transition from current to target status.
 */
export function canTransitionCampaign(
  current: UnifiedCampaignStatus,
  target: UnifiedCampaignStatus
): boolean {
  if (current === target) return true;
  const allowed = VALID_CAMPAIGN_TRANSITIONS[current];
  return allowed ? allowed.has(target) : false;
}

export const canTransitionCampaignStatus = canTransitionCampaign;


/**
 * Returns true if the campaign status is terminal.
 */
export function isTerminalCampaignStatus(status: UnifiedCampaignStatus): boolean {
  return status === "COMPLETED" || status === "CANCELLED";
}

// =============================================================================
// 3. Status Normalizers (Channel to Unified)
// =============================================================================

/**
 * Normalizes WhatsApp message status string into UnifiedDeliveryStatus.
 */
export function mapWhatsAppStatus(status: string): UnifiedDeliveryStatus {
  switch (status.toUpperCase()) {
    case "QUEUED":
    case "PENDING":
      return "QUEUED";
    case "SENDING":
    case "PROCESSING":
      return "PROCESSING";
    case "SENT":
      return "SENT";
    case "DELIVERED":
      return "DELIVERED";
    case "READ":
    case "OPENED":
      return "READ_OR_OPENED";
    case "FAILED":
      return "FAILED";
    default:
      return "FAILED";
  }
}

/**
 * Normalizes Email delivery status string into UnifiedDeliveryStatus.
 */
export function mapEmailStatus(status: string): UnifiedDeliveryStatus {
  switch (status.toUpperCase()) {
    case "QUEUED":
      return "QUEUED";
    case "PROCESSING":
      return "PROCESSING";
    case "SENT":
      return "SENT";
    case "DELIVERED":
      return "DELIVERED";
    case "OPENED":
    case "CLICKED":
      return "READ_OR_OPENED";
    case "BOUNCED":
      return "BOUNCED";
    case "COMPLAINED":
      return "COMPLAINED";
    case "FAILED":
      return "FAILED";
    default:
      return "FAILED";
  }
}

export const normalizeWhatsAppDeliveryStatus = mapWhatsAppStatus;
export const normalizeEmailDeliveryStatus = mapEmailStatus;

/**
 * Normalizes provider event string to standard UnifiedNormalizedEvent eventType.
 */
export function normalizeChannelEventType(
  channel: string,
  rawEvent: string
): "SENT" | "DELIVERED" | "READ_OR_OPENED" | "CLICKED" | "BOUNCED" | "COMPLAINT" | "OPT_OUT" | "FAILED" {
  const evt = rawEvent.toLowerCase();
  if (channel === "WHATSAPP") {
    if (evt === "read") return "READ_OR_OPENED";
    if (evt === "delivered") return "DELIVERED";
    if (evt === "sent") return "SENT";
    if (evt === "failed") return "FAILED";
  }
  if (channel === "EMAIL") {
    if (evt === "open" || evt === "opened") return "READ_OR_OPENED";
    if (evt === "click" || evt === "clicked") return "CLICKED";
    if (evt === "spam" || evt === "complaint" || evt === "complained") return "COMPLAINT";
    if (evt === "bounce" || evt === "bounced") return "BOUNCED";
    if (evt === "delivered") return "DELIVERED";
    if (evt === "sent") return "SENT";
    if (evt === "failed") return "FAILED";
    if (evt === "unsubscribe" || evt === "opt_out") return "OPT_OUT";
  }
  return "FAILED";
}

