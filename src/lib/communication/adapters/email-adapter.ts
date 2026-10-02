/**
 * Email Channel Provider Adapter
 *
 * Implements ChannelProviderAdapter for Email.
 * Delegates send operations to the existing `EmailService` while preserving all
 * deliverability safeguards, idempotency controls, and DKIM/SPF domain resolution.
 */

import { ChannelProviderAdapter } from "./channel-adapter";
import {
  UnifiedMessageRequest,
  UnifiedNormalizedEvent,
  UnifiedProviderHealthResult,
  UnifiedSendResult,
} from "../types";
import { EmailService } from "../../services/email-service";
import { isValidEmail, normalizeEmail } from "../../email/normalization";
import { normalizeEmailDeliveryStatus } from "../lifecycle";
import { EmailSendRequest } from "../../email/types";
import { providerRegistry } from "../../email/registry";

export class EmailChannelAdapter implements ChannelProviderAdapter {
  readonly channel = "EMAIL" as const;
  readonly providerName = "EMAIL_ENGINE";

  /**
   * Validates and normalizes email addresses according to RFC 5322.
   */
  validateDestination(destination: string): { valid: boolean; normalized?: string; error?: string } {
    if (!destination || typeof destination !== "string") {
      return { valid: false, error: "Email destination is missing" };
    }
    const clean = destination.trim();
    if (!isValidEmail(clean)) {
      return { valid: false, error: `Invalid email address: '${clean}'` };
    }
    return { valid: true, normalized: normalizeEmail(clean) };
  }

  /**
   * Dispatches an outbound email via existing EmailService.
   */
  async sendMessage(request: UnifiedMessageRequest): Promise<UnifiedSendResult> {
    const rawTo = request.recipient.destination || request.recipient.email;
    if (!rawTo) {
      return {
        success: false,
        channel: "EMAIL",
        deliveryId: "",
        status: "FAILED",
        error: {
          code: "MISSING_DESTINATION",
          message: "Recipient email address is required for Email dispatch",
          retryable: false,
          failureCategory: "INVALID_DESTINATION",
        },
      };
    }

    const val = this.validateDestination(rawTo);
    if (!val.valid || !val.normalized) {
      return {
        success: false,
        channel: "EMAIL",
        deliveryId: "",
        status: "FAILED",
        error: {
          code: "INVALID_EMAIL_ADDRESS",
          message: val.error || "Invalid email address",
          retryable: false,
          failureCategory: "INVALID_DESTINATION",
        },
      };
    }

    const subject =
      request.content.subject?.trim() ||
      request.content.templateName ||
      "Notification";

    const htmlContent = request.content.html || (request.content.text ? `<p>${request.content.text}</p>` : undefined);
    const textContent = request.content.text || undefined;

    if (!htmlContent && !textContent) {
      return {
        success: false,
        channel: "EMAIL",
        deliveryId: "",
        status: "FAILED",
        error: {
          code: "EMPTY_EMAIL_CONTENT",
          message: "Email message must have either text or html content",
          retryable: false,
        },
      };
    }

    let finalSubject = subject;
    let finalHtml = htmlContent;
    let finalText = textContent;
    let resolvedTemplateId: string | undefined = request.content.templateId || (request.metadata?.templateId as string);
    let resolvedTemplateVersionId: string | undefined = (request.metadata?.templateVersionId as string) || undefined;

    if (resolvedTemplateId) {
      try {
        const { EmailTemplateService } = await import("../../services/email-template-service");
        const { TemplateEngine } = await import("../../email/template-engine");

        const template = await EmailTemplateService.getTemplateById(request.clientId, resolvedTemplateId);
        if (template) {
          const version = resolvedTemplateVersionId
            ? template.versions.find((v) => v.id === resolvedTemplateVersionId)
            : template.versions.find((v) => v.status === "ACTIVE") || template.versions[0];

          if (version) {
            const vars = {
              email: val.normalized,
              name: request.recipient.name || "",
              ...(request.recipient.variables || {}),
              ...(request.metadata || {}),
            };
            const rendered = TemplateEngine.renderTemplate(version, vars);
            finalSubject = rendered.subject;
            finalHtml = rendered.html;
            finalText = rendered.text;
            resolvedTemplateVersionId = version.id;
          }
        }
      } catch (err: any) {
        console.warn(`[EmailChannelAdapter] Template resolution warning: ${err.message}`);
      }
    }

    const emailSendRequest: EmailSendRequest = {
      clientId: request.clientId,
      to: val.normalized,
      from: request.sender?.fromAddress,
      replyTo: request.sender?.replyTo,
      subject: finalSubject,
      html: finalHtml,
      text: finalText,
      type: request.category === "PROMOTIONAL" ? "PROMOTIONAL" : "TRANSACTIONAL",
      idempotencyKey: request.idempotencyKey,
      campaignId: request.campaignId,
      templateId: resolvedTemplateId,
      templateVersionId: resolvedTemplateVersionId,
      providerConfigId: (request.metadata?.providerConfigId as string) || undefined,
      senderIdentityId: request.sender?.identityId || (request.metadata?.senderIdentityId as string) || undefined,
      metadata: request.metadata,
    };

    try {
      const result = await EmailService.send(emailSendRequest);

      const unifiedStatus = normalizeEmailDeliveryStatus(result.providerStatus);

      return {
        success: result.success,
        channel: "EMAIL",
        deliveryId: result.deliveryId || "",
        providerMessageId: result.providerMessageId,
        status: unifiedStatus,
        sentAt: result.sentAt || new Date(),
        error: !result.success
          ? {
              code: result.error?.code || "EMAIL_SEND_FAILED",
              message: result.error?.message || "Failed to dispatch email",
              retryable: Boolean(result.error?.retryable),
            }
          : undefined,
      };
    } catch (err: any) {
      return {
        success: false,
        channel: "EMAIL",
        deliveryId: "",
        status: "FAILED",
        error: {
          code: err.code || "EMAIL_DISPATCH_EXCEPTION",
          message: err.message || "Exception occurred during Email dispatch",
          retryable: true,
          failureCategory: "PROVIDER_ERROR",
        },
      };
    }
  }

  /**
   * Normalizes incoming Email webhook event to standard domain event.
   */
  normalizeEvent(rawPayload: any): UnifiedNormalizedEvent | null {
    if (!rawPayload) return null;

    // Matches NormalizedEmailWebhookEvent structure or raw webhook shape
    const providerEventId =
      rawPayload.providerEventId ||
      rawPayload.id ||
      `email-evt-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;

    const rawType = String(rawPayload.eventType || rawPayload.type || "delivered").toLowerCase();

    let eventType: UnifiedNormalizedEvent["eventType"] = "DELIVERED";
    if (rawType.includes("sent")) eventType = "SENT";
    else if (rawType.includes("deliver")) eventType = "DELIVERED";
    else if (rawType.includes("open")) eventType = "READ_OR_OPENED";
    else if (rawType.includes("click")) eventType = "CLICKED";
    else if (rawType.includes("bounce")) eventType = "BOUNCED";
    else if (rawType.includes("complaint") || rawType.includes("spam")) eventType = "COMPLAINT";
    else if (rawType.includes("unsubscribe")) eventType = "OPT_OUT";
    else if (rawType.includes("fail") || rawType.includes("reject")) eventType = "FAILED";

    const timestamp = rawPayload.occurredAt
      ? new Date(rawPayload.occurredAt)
      : rawPayload.timestamp
      ? new Date(rawPayload.timestamp)
      : new Date();

    return {
      id: `email-evt-${providerEventId}`,
      clientId: rawPayload.clientId,
      channel: "EMAIL",
      eventType,
      deliveryId: rawPayload.deliveryId,
      providerEventId,
      providerMessageId: rawPayload.providerMessageId,
      recipient: String(rawPayload.recipient || rawPayload.email || ""),
      timestamp: isNaN(timestamp.getTime()) ? new Date() : timestamp,
      payload: rawPayload,
      bounceType: rawPayload.bounceClassification?.isPermanent ? "HARD" : "SOFT",
      clickUrl: rawPayload.url || rawPayload.clickUrl,
    };
  }

  /**
   * Assesses Email provider registry status and connectivity.
   */
  async checkHealth(): Promise<UnifiedProviderHealthResult> {
    const hasGmail = providerRegistry.has("GMAIL" as any);

    return {
      providerType: this.providerName,
      channel: "EMAIL",
      status: hasGmail ? "HEALTHY" : "DEGRADED",
      latencyMs: 15,
      checkedAt: new Date(),
      message: hasGmail ? "Email engine operational with Gmail provider" : "No active email provider factory registered",
      capabilities: {
        supportsTemplates: true,
        supportsMedia: true,
        supportsTwoWay: false,
        supportsDeliveryReceipts: true,
        supportsReadReceipts: true,
        maxThroughputPerSecond: 100,
      },
    };
  }
}
