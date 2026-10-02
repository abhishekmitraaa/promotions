/**
 * Push Notification Channel Provider Adapter (Future-Ready Architecture)
 *
 * Implements ChannelProviderAdapter for mobile/web push notifications (FCM / APNs).
 *
 * Production Safety Invariant:
 * - Push notification gateway provider is not yet configured.
 * - This adapter MUST NOT return fake successes, fake SENT status, or fabricate providerMessageId.
 * - All send attempts fail explicitly with PROVIDER_UNAVAILABLE.
 * - Health status reports DEGRADED until live gateway credentials and transports are wired.
 */

import { ChannelProviderAdapter } from "./channel-adapter";
import {
  UnifiedMessageRequest,
  UnifiedNormalizedEvent,
  UnifiedProviderHealthResult,
  UnifiedSendResult,
} from "../types";

export class PushChannelAdapter implements ChannelProviderAdapter {
  readonly channel = "PUSH" as const;
  readonly providerName = "PUSH_GATEWAY";

  /**
   * Validates device registration token length and format.
   */
  validateDestination(destination: string): { valid: boolean; normalized?: string; error?: string } {
    if (!destination || typeof destination !== "string" || destination.trim().length < 20) {
      return { valid: false, error: "Invalid device token for push notification" };
    }
    return { valid: true, normalized: destination.trim() };
  }

  /**
   * Dispatches Push Notification.
   * Fails explicitly with PROVIDER_UNAVAILABLE until upstream gateway credentials are configured.
   */
  async sendMessage(request: UnifiedMessageRequest): Promise<UnifiedSendResult> {
    const rawTo = request.recipient.destination || request.recipient.deviceToken;
    if (!rawTo) {
      return {
        success: false,
        channel: "PUSH",
        deliveryId: "",
        status: "FAILED",
        error: {
          code: "MISSING_DEVICE_TOKEN",
          message: "Device token is required for Push Notification dispatch",
          retryable: false,
          failureCategory: "INVALID_DESTINATION",
        },
      };
    }

    const val = this.validateDestination(rawTo);
    if (!val.valid || !val.normalized) {
      return {
        success: false,
        channel: "PUSH",
        deliveryId: "",
        status: "FAILED",
        error: {
          code: "INVALID_DEVICE_TOKEN",
          message: val.error || "Invalid device token",
          retryable: false,
          failureCategory: "INVALID_DESTINATION",
        },
      };
    }

    const title = request.content.subject || "Notification";
    const body = request.content.text || "";

    if (!title && !body) {
      return {
        success: false,
        channel: "PUSH",
        deliveryId: "",
        status: "FAILED",
        error: {
          code: "EMPTY_PUSH_PAYLOAD",
          message: "Push notification requires at least a title or body",
          retryable: false,
        },
      };
    }

    // Invariant: Fail explicitly. Never fabricate fake success or fake providerMessageId!
    return {
      success: false,
      channel: "PUSH",
      deliveryId: "",
      status: "FAILED",
      error: {
        code: "PROVIDER_UNAVAILABLE",
        message: "Push notification provider is not configured. Live push dispatch is unavailable.",
        retryable: false,
        failureCategory: "PROVIDER_ERROR",
      },
    };
  }

  /**
   * Normalizes incoming Push interaction or delivery receipt webhook.
   */
  normalizeEvent(rawPayload: any): UnifiedNormalizedEvent | null {
    if (!rawPayload) return null;

    const providerMessageId = rawPayload.messageId || rawPayload.id || `push-${Date.now()}`;
    const rawType = String(rawPayload.eventType || rawPayload.action || "delivered").toLowerCase();

    let eventType: UnifiedNormalizedEvent["eventType"] = "DELIVERED";
    if (rawType.includes("open") || rawType.includes("click")) eventType = "READ_OR_OPENED";
    else if (rawType.includes("fail") || rawType.includes("unregistered")) eventType = "FAILED";

    return {
      id: `push-evt-${providerMessageId}-${Date.now()}`,
      clientId: rawPayload.clientId,
      channel: "PUSH",
      eventType,
      providerEventId: rawPayload.eventId || `push-ev-${Date.now()}`,
      providerMessageId,
      recipient: String(rawPayload.deviceToken || rawPayload.token || ""),
      timestamp: new Date(),
      payload: rawPayload,
    };
  }

  /**
   * Assesses Push gateway health.
   * Reports DEGRADED because upstream gateway is not yet bound.
   */
  async checkHealth(): Promise<UnifiedProviderHealthResult> {
    return {
      providerType: this.providerName,
      channel: "PUSH",
      status: "DEGRADED",
      latencyMs: -1,
      checkedAt: new Date(),
      message: "Push notification gateway provider is not configured. Live push dispatch is unavailable.",
      capabilities: {
        supportsTemplates: false,
        supportsMedia: false,
        supportsTwoWay: false,
        supportsDeliveryReceipts: false,
        supportsReadReceipts: false,
        maxThroughputPerSecond: 0,
      },
    };
  }
}
