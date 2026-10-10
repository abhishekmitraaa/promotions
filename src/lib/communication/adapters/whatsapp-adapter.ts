/**
 * WhatsApp Channel Provider Adapter
 *
 * Implements the ChannelProviderAdapter SPI for WhatsApp messaging.
 * Delegates execution to the authoritative MessageService without introducing
 * breaking changes to existing WhatsApp tables, schemas, or webhook handlers.
 */

import { ChannelProviderAdapter, ChannelReachabilityCheck } from "./channel-adapter";
import {
  ChannelType,
  UnifiedMessageRequest,
  UnifiedSendResult,
  UnifiedProviderHealthResult,
  UnifiedNormalizedEvent,
} from "../types";
import { MessageService } from "../../services/message-service";
import { mapWhatsAppStatus } from "../lifecycle";
import { normalizePhoneNumber } from "../../crypto";
import { isMetaConfigured } from "../../env";
import { prisma } from "../../prisma";

export class WhatsAppAdapter implements ChannelProviderAdapter {
  readonly channel: ChannelType = "WHATSAPP";

  /**
   * Dispatches a WhatsApp message through MessageService.
   */
  async send(request: UnifiedMessageRequest): Promise<UnifiedSendResult> {
    const destination = request.recipient.phone || request.recipient.destination;
    if (!destination) {
      return {
        success: false,
        channel: "WHATSAPP",
        deliveryId: "",
        status: "FAILED",
        error: {
          code: "MISSING_DESTINATION",
          message: "WhatsApp dispatch requires a recipient phone number or destination",
          retryable: false,
          failureCategory: "INVALID_DESTINATION",
        },
      };
    }

    try {
      const isTemplate = Boolean(request.content.templateName);
      const result = await MessageService.send(
        {
          to: destination,
          type: isTemplate ? "template" : "text",
          body: request.content.text,
          templateName: request.content.templateName,
          templateParameters: Array.isArray(request.content.templateParameters)
            ? (request.content.templateParameters as string[])
            : undefined,
          metadata: request.metadata,
        },
        {
          clientId: request.clientId,
          idempotencyKey: request.idempotencyKey,
        }
      );

      const unifiedStatus = mapWhatsAppStatus(result.status);
      const isSuccess = unifiedStatus !== "FAILED";

      return {
        success: isSuccess,
        channel: "WHATSAPP",
        deliveryId: result.id,
        providerMessageId: result.providerMessageId || undefined,
        status: unifiedStatus,
        sentAt: result.sentAt || (isSuccess ? new Date() : undefined),
        error: result.error
          ? {
              code: result.errorCode || result.error.code || "WHATSAPP_ERROR",
              message: result.errorMessage || result.error.message || "WhatsApp dispatch error",
              retryable: false,
              failureCategory: "PROVIDER_ERROR",
            }
          : undefined,
      };
    } catch (err: unknown) {
      const error = err as Error & { code?: string; status?: number };
      return {
        success: false,
        channel: "WHATSAPP",
        deliveryId: "",
        status: "FAILED",
        error: {
          code: error.code || "WHATSAPP_DISPATCH_EXCEPTION",
          message: error.message || "Failed to dispatch WhatsApp message",
          retryable: typeof error.status === "number" && error.status >= 500,
          failureCategory: "PROVIDER_ERROR",
        },
      };
    }
  }

  /**
   * Health check for WhatsApp client/tenant configuration.
   */
  async checkHealth(clientId: string): Promise<UnifiedProviderHealthResult> {
    const startTime = Date.now();
    try {
      const client = await prisma.apiClient.findUnique({
        where: { id: clientId },
      });

      const isConfigured = isMetaConfigured();
      const latencyMs = Date.now() - startTime;

      return {
        providerType: "META_CLOUD_API",
        channel: "WHATSAPP",
        status: isConfigured && client?.active ? "HEALTHY" : isConfigured ? "DEGRADED" : "UNHEALTHY",
        latencyMs,
        checkedAt: new Date(),
        message: isConfigured
          ? "WhatsApp Meta Cloud API configured"
          : "Meta Cloud API credentials missing",
        capabilities: {
          supportsTemplates: true,
          supportsMedia: true,
          supportsTwoWay: true,
          supportsDeliveryReceipts: true,
          supportsReadReceipts: true,
          maxThroughputPerSecond: 80,
        },
      };
    } catch (err: unknown) {
      const error = err as Error;
      return {
        providerType: "META_CLOUD_API",
        channel: "WHATSAPP",
        status: "UNHEALTHY",
        latencyMs: Date.now() - startTime,
        checkedAt: new Date(),
        message: error.message,
        capabilities: {
          supportsTemplates: true,
          supportsMedia: true,
          supportsTwoWay: true,
          supportsDeliveryReceipts: true,
          supportsReadReceipts: true,
        },
      };
    }
  }

  /**
   * Normalizes incoming raw WhatsApp webhook payloads into UnifiedNormalizedEvents.
   */
  normalizeWebhookEvent(rawPayload: Record<string, unknown>): UnifiedNormalizedEvent[] {
    const events: UnifiedNormalizedEvent[] = [];
    const entry = Array.isArray(rawPayload.entry) ? (rawPayload.entry as Record<string, unknown>[]) : [];

    for (const item of entry) {
      const changes = Array.isArray(item.changes) ? (item.changes as Record<string, unknown>[]) : [];
      for (const change of changes) {
        const value = (change.value as Record<string, unknown>) || {};
        const statuses = Array.isArray(value.statuses) ? (value.statuses as Record<string, unknown>[]) : [];
        for (const statusObj of statuses) {
          const providerStatus = String(statusObj.status || "").toLowerCase();
          let eventType: UnifiedNormalizedEvent["eventType"] = "FAILED";

          if (providerStatus === "sent") eventType = "SENT";
          else if (providerStatus === "delivered") eventType = "DELIVERED";
          else if (providerStatus === "read") eventType = "READ_OR_OPENED";
          else if (providerStatus === "failed") eventType = "FAILED";

          const statusId = typeof statusObj.id === "string" ? statusObj.id : undefined;
          const timestampNum =
            typeof statusObj.timestamp === "number" || typeof statusObj.timestamp === "string"
              ? Number(statusObj.timestamp)
              : undefined;
          const recipientId = typeof statusObj.recipient_id === "string" ? statusObj.recipient_id : "";

          events.push({
            id: statusId ? `wa_${statusId}_${timestampNum || Date.now()}` : `wa_${Date.now()}`,
            channel: "WHATSAPP",
            eventType,
            providerEventId: statusId || `wa_event_${Date.now()}`,
            providerMessageId: statusId,
            recipient: recipientId,
            timestamp: timestampNum ? new Date(timestampNum * 1000) : new Date(),
            payload: statusObj,
          });
        }
      }
    }

    return events;
  }

  /**
   * Alias for send() for backward/forward compatibility.
   */
  async sendMessage(request: UnifiedMessageRequest): Promise<UnifiedSendResult> {
    return this.send(request);
  }

  /**
   * Checks WhatsApp destination phone number reachability (E.164 validity).
   */
  async checkReachability(destination: string): Promise<ChannelReachabilityCheck> {
    return this.validateDestination(destination);
  }

  /**
   * Synchronous destination syntax validation.
   */
  validateDestination(destination: string): ChannelReachabilityCheck {
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
