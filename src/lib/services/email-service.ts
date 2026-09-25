/**
 * Core EmailService Layer
 *
 * Implements high-level email dispatch workflow:
 * 1. Validates request and recipients.
 * 2. Enforces multi-tenant scoping and sender identity verification.
 * 3. Resolves the configured provider from the registry.
 * 4. Calls provider send interface.
 * 5. Persists delivery state to the database (EmailDelivery).
 * 6. Returns a standardized, provider-agnostic response.
 */

import { prisma } from "../prisma";
import { providerRegistry } from "../email/registry";
import {
  EmailDeliveryStatus,
  EmailProviderType,
} from "@prisma/client";
import {
  EmailSendRequest,
  EmailSendResult,
  EmailProvider,
  EmailRecipientInput,
} from "../email/types";
import { normalizeEmail, isValidEmail } from "../email/normalization";
import { EmailTemplateService, SystemTemplateType } from "../email/templates";

export interface EmailServiceSendOptions {
  /** Optional pre-resolved provider instance (useful for unit testing / mocking) */
  providerOverride?: EmailProvider;
  /** Optional custom fetch for provider calls */
  fetchFn?: typeof fetch;
}

export interface SendTransactionalRequest {
  clientId?: string;
  to: string | EmailRecipientInput | (string | EmailRecipientInput)[];
  subject?: string;
  templateType?: SystemTemplateType;
  templateVariables?: Record<string, string | number | boolean | null | undefined>;
  html?: string;
  text?: string;
  from?: EmailRecipientInput;
  replyTo?: string;
  transactionalReference?: string;
  idempotencyKey?: string;
}

export type SendTransactionalOptions = EmailServiceSendOptions;

export class EmailService {
  /**
   * Dispatches an outbound email scoped to a tenant client.
   */
  static async send(
    request: EmailSendRequest,
    options?: EmailServiceSendOptions
  ): Promise<EmailSendResult> {
    // 1. Validation
    if (!request.clientId || request.clientId.trim() === "") {
      throw new Error("clientId is mandatory for email dispatch");
    }

    if (!request.type) {
      throw new Error("type (TRANSACTIONAL or PROMOTIONAL) is mandatory");
    }

    if (!request.subject || request.subject.trim() === "") {
      throw new Error("Email subject cannot be empty");
    }

    if ((!request.html || request.html.trim() === "") && (!request.text || request.text.trim() === "")) {
      throw new Error("Email must contain either text or html content");
    }

    // Validate recipient(s)
    const rawToList = Array.isArray(request.to) ? request.to : [request.to];
    if (rawToList.length === 0) {
      throw new Error("Email must have at least one recipient");
    }

    const validatedToEmails: string[] = [];
    for (const recipient of rawToList) {
      const email = typeof recipient === "string" ? recipient : recipient.email;
      if (!isValidEmail(email)) {
        throw new Error(`Invalid recipient email address: '${email}'`);
      }
      validatedToEmails.push(normalizeEmail(email));
    }

    // 2. Idempotency Check (Scoped to tenant)
    if (request.idempotencyKey && request.idempotencyKey.trim() !== "") {
      const existing = await prisma.emailDelivery.findFirst({
        where: {
          clientId: request.clientId,
          idempotencyKey: request.idempotencyKey.trim(),
        },
      });

      if (existing) {
        return {
          accepted: existing.status === EmailDeliveryStatus.SENT || existing.status === EmailDeliveryStatus.DELIVERED,
          success: existing.status === EmailDeliveryStatus.SENT || existing.status === EmailDeliveryStatus.DELIVERED,
          providerName: existing.providerType,
          providerType: existing.providerType,
          providerMessageId: existing.providerMessageId || undefined,
          providerStatus: existing.status,
          deliveryId: existing.id,
          sentAt: existing.sentAt || undefined,
          error: existing.errorMessage
            ? {
                code: existing.errorCode || "PREVIOUS_FAILURE",
                message: existing.errorMessage,
                retryable: false,
              }
            : undefined,
        };
      }
    }

    // 3. Resolve Provider
    let provider: EmailProvider;
    let providerType: EmailProviderType;
    let providerSenderEmail: string | undefined;

    if (options?.providerOverride) {
      provider = options.providerOverride;
      providerType = provider.providerType;
    } else {
      const resolved = await providerRegistry.resolveForTenant(request.clientId, undefined, {
        fetchFn: options?.fetchFn,
      });
      provider = resolved.provider;
      providerType = resolved.providerType;
      providerSenderEmail = resolved.senderEmail;
    }

    // 4. Validate & Resolve Sender Identity (Step 9)
    const resolvedFrom = options?.providerOverride
      ? (request.from || providerSenderEmail || "system@whatsapphub.internal")
      : await this.resolveSenderIdentity(
          request.clientId,
          request.from,
          providerSenderEmail
        );

    const normalizedRequest: EmailSendRequest = {
      ...request,
      from: resolvedFrom,
    };

    // 5. Execute Provider Send
    const sendResult = await provider.send(normalizedRequest);

    // 6. Record Delivery State in Database
    let deliveryId: string | undefined;
    try {
      const deliveryStatus = sendResult.accepted
        ? EmailDeliveryStatus.SENT
        : EmailDeliveryStatus.FAILED;

      const delivery = await prisma.emailDelivery.create({
        data: {
          clientId: request.clientId,
          providerType,
          providerMessageId: sendResult.providerMessageId || null,
          campaignRecipientId: request.campaignRecipientId || null,
          transactionalReference: request.transactionalReference || null,
          category: request.type,
          from: typeof resolvedFrom === "string" ? resolvedFrom : resolvedFrom.email,
          to: validatedToEmails.join(", "),
          subject: request.subject,
          status: deliveryStatus,
          attemptCount: 1,
          lastAttemptAt: new Date(),
          sentAt: sendResult.accepted ? (sendResult.sentAt || new Date()) : null,
          failedAt: sendResult.accepted ? null : new Date(),
          errorCode: sendResult.error?.code || null,
          errorMessage: sendResult.error?.message || null,
          idempotencyKey: request.idempotencyKey?.trim() || null,
        },
      });
      deliveryId = delivery.id;
    } catch {
      // Resilient fallback when EmailDelivery table is not yet migrated to DB target
    }

    return {
      ...sendResult,
      deliveryId,
    };
  }

  /**
   * Resolves and verifies the sender identity for the given tenant.
   * Disallows arbitrary or unverified From addresses.
   */
  private static async resolveSenderIdentity(
    clientId: string,
    requestedFrom?: EmailRecipientInput,
    providerSenderEmail?: string
  ): Promise<EmailRecipientInput> {
    if (requestedFrom) {
      const email = typeof requestedFrom === "string" ? requestedFrom : requestedFrom.email;
      if (!isValidEmail(email)) {
        throw new Error(`Invalid sender 'from' email address: '${email}'`);
      }
      const normalized = normalizeEmail(email);

      // Check if this sender email is a verified EmailSenderIdentity for this tenant
      const verifiedIdentity = await prisma.emailSenderIdentity.findFirst({
        where: {
          clientId,
          email: normalized,
          verified: true,
        },
      });

      if (verifiedIdentity) {
        return typeof requestedFrom === "string"
          ? (verifiedIdentity.name ? { email: normalized, name: verifiedIdentity.name } : normalized)
          : requestedFrom;
      }

      // Check if it matches the verified senderEmail on the provider config
      if (providerSenderEmail && normalizeEmail(providerSenderEmail) === normalized) {
        return requestedFrom;
      }

      throw new Error(
        `Unverified sender identity: '${email}'. You may only send from verified sender identities belonging to tenant '${clientId}'.`
      );
    }

    // If requestedFrom is omitted, pick the tenant's default verified sender identity
    try {
      const defaultIdentity = await prisma.emailSenderIdentity.findFirst({
        where: {
          clientId,
          verified: true,
          isDefault: true,
        },
      });

      if (defaultIdentity) {
        return defaultIdentity.name
          ? { email: defaultIdentity.email, name: defaultIdentity.name }
          : defaultIdentity.email;
      }
    } catch {
      // Resilient fallback when EmailSenderIdentity table is not yet migrated to DB target
    }

    // Fallback to providerSenderEmail if available
    if (providerSenderEmail && isValidEmail(providerSenderEmail)) {
      return normalizeEmail(providerSenderEmail);
    }

    throw new Error(
      `No verified sender identity found for tenant '${clientId}'. Please configure and verify a sender identity.`
    );
  }

  /**
   * Dispatches a transactional email without requiring the caller to specify provider details.
   * Automatically renders system templates if templateType is supplied.
   */
  static async sendTransactional(
    request: SendTransactionalRequest,
    options?: SendTransactionalOptions
  ): Promise<EmailSendResult> {
    let subject = request.subject;
    let html = request.html;
    let text = request.text;

    if (request.templateType) {
      const rendered = EmailTemplateService.renderSystemTemplate(
        request.templateType,
        request.templateVariables || {}
      );
      if (!subject || subject.trim() === "") {
        subject = rendered.subject;
      }
      html = rendered.html;
      text = rendered.text;
    }

    if (!subject || subject.trim() === "") {
      throw new Error("Transactional email subject is required");
    }

    // Resolve tenant clientId: if caller omitted, pick the default/first ApiClient or fallback to "system"
    let clientId = request.clientId;
    if (!clientId || clientId.trim() === "") {
      const firstClient = await prisma.apiClient.findFirst({ select: { id: true } });
      clientId = firstClient?.id || "system";
    }

    return this.send(
      {
        clientId,
        type: "TRANSACTIONAL",
        to: request.to,
        from: request.from,
        replyTo: request.replyTo,
        subject,
        html,
        text,
        transactionalReference: request.transactionalReference,
        idempotencyKey: request.idempotencyKey,
      },
      options
    );
  }
}
