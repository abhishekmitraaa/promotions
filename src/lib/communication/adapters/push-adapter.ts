/**
 * Push Notification Channel Provider Adapter (Future Expansion Architecture)
 *
 * Implements the ChannelProviderAdapter SPI for Mobile/Web Push Notifications (FCM, APNs).
 * Designed for immediate pluggability when Push providers are activated.
 */

import { ChannelProviderAdapter, ChannelReachabilityCheck } from "./channel-adapter";
import {
  ChannelType,
  UnifiedMessageRequest,
  UnifiedSendResult,
  UnifiedProviderHealthResult,
  UnifiedNormalizedEvent,
} from "../types";

export class PushAdapter implements ChannelProviderAdapter {
  readonly channel: ChannelType = "PUSH";

  async send(request: UnifiedMessageRequest): Promise<UnifiedSendResult> {
    const destination = request.recipient.deviceToken || request.recipient.destination;
    if (!destination) {
      return {
        success: false,
        channel: "PUSH",
        deliveryId: "",
        status: "FAILED",
        error: {
          code: "MISSING_DESTINATION",
          message: "Push notification dispatch requires a device registration token",
          retryable: false,
          failureCategory: "INVALID_DESTINATION",
        },
      };
    }

    return {
      success: false,
      channel: "PUSH",
      deliveryId: `push_stub_${Date.now()}`,
      status: "FAILED",
      error: {
        code: "PUSH_PROVIDER_NOT_CONFIGURED",
        message: "Push notification provider integration is ready for activation via ChannelProviderAdapter SPI",
        retryable: false,
        failureCategory: "PROVIDER_ERROR",
      },
    };
  }

  async checkHealth(_clientId: string): Promise<UnifiedProviderHealthResult> {
    return {
      providerType: "FCM_APNS_GATEWAY",
      channel: "PUSH",
      status: "DEGRADED",
      latencyMs: 0,
      checkedAt: new Date(),
      message: "Push notification adapter registered in standby mode",
      capabilities: {
        supportsTemplates: true,
        supportsMedia: true,
        supportsTwoWay: false,
        supportsDeliveryReceipts: true,
        supportsReadReceipts: true,
        maxThroughputPerSecond: 500,
      },
    };
  }

  normalizeWebhookEvent(rawPayload: Record<string, unknown>): UnifiedNormalizedEvent[] {
    const event = String(rawPayload.event || rawPayload.messageType || "").toLowerCase();
    let eventType: UnifiedNormalizedEvent["eventType"] = "FAILED";

    if (event.includes("delivered") || event.includes("receipt")) eventType = "DELIVERED";
    else if (event.includes("open") || event.includes("click")) eventType = "READ_OR_OPENED";
    else if (event.includes("unregister") || event.includes("not_found")) eventType = "OPT_OUT";

    return [
      {
        id: String(rawPayload.messageId || `push_ev_${Date.now()}`),
        channel: "PUSH",
        eventType,
        providerEventId: String(rawPayload.messageId || `push_${Date.now()}`),
        providerMessageId: (rawPayload.messageId as string) || undefined,
        recipient: String(rawPayload.registrationToken || rawPayload.token || ""),
        timestamp: new Date(),
        payload: rawPayload,
      },
    ];
  }

  async checkReachability(destination: string): Promise<ChannelReachabilityCheck> {
    // FCM/APNs tokens are typically 32-256 base64/hex characters
    if (typeof destination !== "string" || destination.trim().length < 20) {
      return {
        valid: false,
        reason: "Invalid push notification device registration token format",
      };
    }
    return {
      valid: true,
      normalizedDestination: destination.trim(),
    };
  }
}
