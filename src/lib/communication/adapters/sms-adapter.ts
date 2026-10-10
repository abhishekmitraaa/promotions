/**
 * SMS Channel Provider Adapter (Future Expansion Architecture)
 *
 * Implements the ChannelProviderAdapter SPI for SMS messaging (e.g. Twilio, AWS SNS, MessageBird).
 * Designed for immediate pluggability when SMS providers are activated.
 */

import { ChannelProviderAdapter, ChannelReachabilityCheck } from "./channel-adapter";
import {
  ChannelType,
  UnifiedMessageRequest,
  UnifiedSendResult,
  UnifiedProviderHealthResult,
  UnifiedNormalizedEvent,
} from "../types";
import { normalizePhoneNumber } from "../../crypto";

export class SmsAdapter implements ChannelProviderAdapter {
  readonly channel: ChannelType = "SMS";

  async send(request: UnifiedMessageRequest): Promise<UnifiedSendResult> {
    const destination = request.recipient.phone || request.recipient.destination;
    if (!destination) {
      return {
        success: false,
        channel: "SMS",
        deliveryId: "",
        status: "FAILED",
        error: {
          code: "MISSING_DESTINATION",
          message: "SMS dispatch requires a recipient phone number",
          retryable: false,
          failureCategory: "INVALID_DESTINATION",
        },
      };
    }

    // In current phase, SMS provider is configured as a planned adapter stub
    return {
      success: false,
      channel: "SMS",
      deliveryId: `sms_stub_${Date.now()}`,
      status: "FAILED",
      error: {
        code: "SMS_PROVIDER_NOT_CONFIGURED",
        message: "SMS provider integration is ready for activation via ChannelProviderAdapter SPI",
        retryable: false,
        failureCategory: "PROVIDER_ERROR",
      },
    };
  }

  async checkHealth(_clientId: string): Promise<UnifiedProviderHealthResult> {
    return {
      providerType: "SMS_GATEWAY",
      channel: "SMS",
      status: "DEGRADED",
      latencyMs: 0,
      checkedAt: new Date(),
      message: "SMS gateway adapter registered in standby mode",
      capabilities: {
        supportsTemplates: false,
        supportsMedia: false,
        supportsTwoWay: true,
        supportsDeliveryReceipts: true,
        supportsReadReceipts: false,
        maxThroughputPerSecond: 100,
      },
    };
  }

  normalizeWebhookEvent(rawPayload: Record<string, unknown>): UnifiedNormalizedEvent[] {
    const status = String(rawPayload.SmsStatus || rawPayload.status || "").toLowerCase();
    let eventType: UnifiedNormalizedEvent["eventType"] = "FAILED";

    if (status === "delivered") eventType = "DELIVERED";
    else if (status === "sent") eventType = "SENT";
    else if (status === "failed" || status === "undelivered") eventType = "FAILED";

    return [
      {
        id: String(rawPayload.MessageSid || rawPayload.id || `sms_ev_${Date.now()}`),
        channel: "SMS",
        eventType,
        providerEventId: String(rawPayload.MessageSid || `sms_${Date.now()}`),
        providerMessageId: (rawPayload.MessageSid as string) || undefined,
        recipient: String(rawPayload.To || rawPayload.recipient || ""),
        timestamp: new Date(),
        payload: rawPayload,
      },
    ];
  }

  async checkReachability(destination: string): Promise<ChannelReachabilityCheck> {
    try {
      const normalized = normalizePhoneNumber(destination);
      const digitsOnly = normalized.replace(/\D/g, "");
      if (digitsOnly.length < 8 || digitsOnly.length > 15) {
        return {
          valid: false,
          reason: "Phone number length must be between 8 and 15 digits (E.164)",
        };
      }
      return {
        valid: true,
        normalizedDestination: normalized,
      };
    } catch {
      return {
        valid: false,
        reason: "Invalid phone number format",
      };
    }
  }
}
