/**
 * Email Channel Provider Adapter
 *
 * Implements the ChannelProviderAdapter SPI for Email messaging.
 * Delegates execution to the authoritative EmailDispatchService / EmailService
 * without altering existing EmailDelivery, EmailCampaign, or EmailEvent models.
 */

import { ChannelProviderAdapter, ChannelReachabilityCheck } from "./channel-adapter";
import {
  ChannelType,
  UnifiedMessageRequest,
  UnifiedSendResult,
  UnifiedProviderHealthResult,
  UnifiedNormalizedEvent,
} from "../types";
import { EmailDispatchService } from "../../services/email-dispatch-service";
import { isValidEmail, normalizeEmail } from "../../email/normalization";
import { prisma } from "../../prisma";

export class EmailAdapter implements ChannelProviderAdapter {
  readonly channel: ChannelType = "EMAIL";

  /**
   * Dispatches an email through EmailDispatchService.
   */
  async send(request: UnifiedMessageRequest): Promise<UnifiedSendResult> {
    const destination = request.recipient.email || request.recipient.destination;
    if (!destination) {
      return {
        success: false,
        channel: "EMAIL",
        deliveryId: "",
        status: "FAILED",
        error: {
          code: "MISSING_DESTINATION",
          message: "Email dispatch requires a recipient email address",
          retryable: false,
          failureCategory: "INVALID_DESTINATION",
        },
      };
    }

    try {
      const result = await EmailDispatchService.sendImmediate({
        clientId: request.clientId,
        to: destination,
        subject: request.content.subject || "Notification",
        html: request.content.html,
        text: request.content.text,
        from: request.sender?.fromAddress ? { email: request.sender.fromAddress } : undefined,
        replyTo: request.sender?.replyTo,
        idempotencyKey: request.idempotencyKey,
      });

      const isSuccess = result.success;
      const unifiedStatus = isSuccess ? "SENT" : "FAILED";

      return {
        success: isSuccess,
        channel: "EMAIL",
        deliveryId: result.deliveryId || "",
        providerMessageId: result.providerMessageId,
        status: unifiedStatus,
        sentAt: result.sentAt,
        error: result.error
          ? {
              code: result.error.code,
              message: result.error.message,
              retryable: result.error.retryable,
              failureCategory: "PROVIDER_ERROR",
            }
          : undefined,
      };
    } catch (err: unknown) {
      const error = err as Error & { code?: string };
      return {
        success: false,
        channel: "EMAIL",
        deliveryId: "",
        status: "FAILED",
        error: {
          code: error.code || "EMAIL_DISPATCH_EXCEPTION",
          message: error.message || "Failed to dispatch email",
          retryable: false,
          failureCategory: "PROVIDER_ERROR",
        },
      };
    }
  }

  /**
   * Health check for active email provider configuration.
   */
  async checkHealth(clientId: string): Promise<UnifiedProviderHealthResult> {
    const startTime = Date.now();
    try {
      const config = await prisma.emailProviderConfig.findFirst({
        where: { clientId, status: "ACTIVE" },
      });

      const identity = await prisma.emailSenderIdentity.findFirst({
        where: { clientId },
      });

      const isConfigured = Boolean(config || identity);
      const latencyMs = Date.now() - startTime;

      return {
        providerType: config?.providerType || "GMAIL",
        channel: "EMAIL",
        status: isConfigured ? "HEALTHY" : "DEGRADED",
        latencyMs,
        checkedAt: new Date(),
        message: isConfigured
          ? `Active identity configured (${identity?.email || config?.senderEmail || "default"})`
          : "No active email sender configuration found for client",
        capabilities: {
          supportsTemplates: true,
          supportsMedia: true,
          supportsTwoWay: false,
          supportsDeliveryReceipts: true,
          supportsReadReceipts: true,
          maxThroughputPerSecond: 50,
        },
      };
    } catch (err: unknown) {
      const error = err as Error;
      return {
        providerType: "GMAIL",
        channel: "EMAIL",
        status: "UNHEALTHY",
        latencyMs: Date.now() - startTime,
        checkedAt: new Date(),
        message: error.message,
        capabilities: {
          supportsTemplates: true,
          supportsMedia: true,
          supportsTwoWay: false,
          supportsDeliveryReceipts: true,
          supportsReadReceipts: true,
        },
      };
    }
  }

  /**
   * Normalizes incoming raw email webhook event (e.g. bounce, delivery, open, click).
   */
  normalizeWebhookEvent(rawPayload: Record<string, unknown>): UnifiedNormalizedEvent[] {
    const events: UnifiedNormalizedEvent[] = [];
    const eventTypeRaw = String(rawPayload.type || rawPayload.event || "").toLowerCase();

    let eventType: UnifiedNormalizedEvent["eventType"] = "FAILED";
    if (eventTypeRaw.includes("deliver")) eventType = "DELIVERED";
    else if (eventTypeRaw.includes("open")) eventType = "READ_OR_OPENED";
    else if (eventTypeRaw.includes("click")) eventType = "CLICKED";
    else if (eventTypeRaw.includes("bounce")) eventType = "BOUNCED";
    else if (eventTypeRaw.includes("complaint") || eventTypeRaw.includes("spam")) eventType = "COMPLAINT";
    else if (eventTypeRaw.includes("unsubscribe")) eventType = "OPT_OUT";
    else if (eventTypeRaw.includes("sent")) eventType = "SENT";

    events.push({
      id: String(rawPayload.id || `email_ev_${Date.now()}`),
      channel: "EMAIL",
      eventType,
      deliveryId: (rawPayload.deliveryId as string) || undefined,
      providerEventId: String(rawPayload.eventId || rawPayload.id || `ev_${Date.now()}`),
      providerMessageId: (rawPayload.messageId as string) || (rawPayload.providerMessageId as string),
      recipient: String(rawPayload.recipient || rawPayload.email || ""),
      timestamp: rawPayload.timestamp ? new Date(rawPayload.timestamp as string | number) : new Date(),
      payload: rawPayload,
      bounceType: eventTypeRaw.includes("hard") ? "HARD" : eventTypeRaw.includes("soft") ? "SOFT" : undefined,
      clickUrl: (rawPayload.url as string) || (rawPayload.clickUrl as string) || undefined,
    });

    return events;
  }

  /**
   * Alias for send() for backward/forward compatibility.
   */
  async sendMessage(request: UnifiedMessageRequest): Promise<UnifiedSendResult> {
    return this.send(request);
  }

  /**
   * Checks email destination reachability (RFC 5322 syntax validation and normalization).
   */
  async checkReachability(destination: string): Promise<ChannelReachabilityCheck> {
    return this.validateDestination(destination);
  }

  /**
   * Synchronous destination syntax validation.
   */
  validateDestination(destination: string): ChannelReachabilityCheck {
    if (!isValidEmail(destination)) {
      return {
        valid: false,
        reason: "Invalid email address format (RFC 5322 check failed)",
      };
    }
    return {
      valid: true,
      normalizedDestination: normalizeEmail(destination),
    };
  }
}

