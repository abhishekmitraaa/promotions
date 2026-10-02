/**
 * SMS Channel Provider Adapter (Future-Ready Architecture)
 *
 * Implements the ChannelProviderAdapter contract for SMS messaging (Twilio / AWS SNS / MessageBird).
 *
 * Production Safety Invariant:
 * - SMS gateway provider is not yet configured.
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
import { normalizePhoneNumber } from "../../crypto";

export class SmsChannelAdapter implements ChannelProviderAdapter {
  readonly channel = "SMS" as const;
  readonly providerName = "SMS_GATEWAY";

  /**
   * Validates E.164 phone numbers for SMS transmission.
   */
  validateDestination(destination: string): { valid: boolean; normalized?: string; error?: string } {
    try {
      const normalized = normalizePhoneNumber(destination);
      if (!normalized || normalized.length < 8) {
        return { valid: false, error: "Phone number too short for SMS" };
      }
      return { valid: true, normalized };
    } catch {
      return { valid: false, error: "Invalid phone number format" };
    }
  }

  /**
   * Dispatches SMS message.
   * Fails explicitly with PROVIDER_UNAVAILABLE until upstream gateway credentials are configured.
   */
  async sendMessage(request: UnifiedMessageRequest): Promise<UnifiedSendResult> {
    const rawTo = request.recipient.destination || request.recipient.phone;
    if (!rawTo) {
      return {
        success: false,
        channel: "SMS",
        deliveryId: "",
        status: "FAILED",
        error: {
          code: "MISSING_DESTINATION",
          message: "Recipient phone number is required for SMS dispatch",
          retryable: false,
          failureCategory: "INVALID_DESTINATION",
        },
      };
    }

    const val = this.validateDestination(rawTo);
    if (!val.valid || !val.normalized) {
      return {
        success: false,
        channel: "SMS",
        deliveryId: "",
        status: "FAILED",
        error: {
          code: "INVALID_PHONE_NUMBER",
          message: val.error || "Invalid phone number",
          retryable: false,
          failureCategory: "INVALID_DESTINATION",
        },
      };
    }

    const textContent = request.content.text?.trim();
    if (!textContent) {
      return {
        success: false,
        channel: "SMS",
        deliveryId: "",
        status: "FAILED",
        error: {
          code: "EMPTY_SMS_BODY",
          message: "SMS text body cannot be empty",
          retryable: false,
        },
      };
    }

    // Invariant: Fail explicitly. Never fabricate fake success or fake providerMessageId!
    return {
      success: false,
      channel: "SMS",
      deliveryId: "",
      status: "FAILED",
      error: {
        code: "PROVIDER_UNAVAILABLE",
        message: "SMS channel is not configured with an active upstream provider gateway. Live SMS transmission is unavailable.",
        retryable: false,
        failureCategory: "PROVIDER_ERROR",
      },
    };
  }

  /**
   * Normalizes incoming SMS delivery receipt webhook if gateway is active.
   */
  normalizeEvent(rawPayload: any): UnifiedNormalizedEvent | null {
    if (!rawPayload) return null;

    const providerMessageId = rawPayload.MessageSid || rawPayload.id || rawPayload.providerMessageId;
    if (!providerMessageId) return null;

    const rawStatus = String(rawPayload.MessageStatus || rawPayload.status || "delivered").toLowerCase();

    let eventType: UnifiedNormalizedEvent["eventType"] = "DELIVERED";
    if (rawStatus === "sent") eventType = "SENT";
    else if (rawStatus === "delivered") eventType = "DELIVERED";
    else if (rawStatus === "failed" || rawStatus === "undelivered") eventType = "FAILED";

    return {
      id: `sms-evt-${providerMessageId}-${Date.now()}`,
      clientId: rawPayload.clientId,
      channel: "SMS",
      eventType,
      providerEventId: rawPayload.SmsSid || `sms-ev-${Date.now()}`,
      providerMessageId,
      recipient: String(rawPayload.To || rawPayload.to || ""),
      timestamp: new Date(),
      payload: rawPayload,
    };
  }

  /**
   * Assesses SMS provider health.
   * Reports DEGRADED because upstream gateway is not yet bound.
   */
  async checkHealth(): Promise<UnifiedProviderHealthResult> {
    return {
      providerType: this.providerName,
      channel: "SMS",
      status: "DEGRADED",
      latencyMs: -1,
      checkedAt: new Date(),
      message: "SMS gateway provider is not configured. Live SMS transmission is unavailable.",
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
