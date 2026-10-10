/**
 * EmailDispatchService
 *
 * Implements the authoritative email dispatch architecture:
 * 1. sendImmediate(): For urgent, latency-critical transactional messages
 *    (OTP, email verification, password reset, security alerts).
 *    Executes synchronous provider dispatch and returns authoritative result.
 * 2. enqueueBackground(): For promotional, campaign, bulk, and async transactional messages.
 *    Creates an authoritative EmailDelivery record and persists a durable BackgroundJob
 *    in PostgreSQL for the serverless processor.
 *
 * Never uses fake in-memory queues or mock providers in production.
 */

import { prisma } from "../prisma";
import {
  EmailDeliveryStatus,
  EmailProviderType,
  EmailType,
  EmailFailureCategory,
  BackgroundJobStatus,
} from "@prisma/client";
import {
  EmailSendRequest,
  EmailSendResult,
  EmailRecipientInput,
} from "../email/types";
import { EmailService, EmailServiceSendOptions } from "./email-service";
import { isValidEmail, normalizeEmail } from "../email/normalization";
import { EmailTemplateService, SystemTemplateType } from "../email/templates";
import { logger } from "../logger";

export interface ImmediateEmailRequest {
  clientId: string;
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

export interface BackgroundEmailRequest {
  clientId: string;
  to: string | EmailRecipientInput;
  subject?: string;
  templateType?: SystemTemplateType;
  templateVariables?: Record<string, string | number | boolean | null | undefined>;
  html?: string;
  text?: string;
  category?: EmailType;
  from?: EmailRecipientInput;
  replyTo?: string;
  transactionalReference?: string;
  idempotencyKey?: string;
  templateId?: string;
  templateVersionId?: string;
  campaignId?: string;
  campaignRecipientId?: string;
  delayMs?: number;
}

export interface BackgroundEnqueueResult {
  queued: boolean;
  deliveryId: string;
  jobId: string;
  status: "QUEUED" | "FAILED";
  errorCode?: string;
  errorMessage?: string;
}

export class EmailDispatchService {
  /**
   * 1. IMMEDIATE SYNCHRONOUS SEND
   * Authenticates, validates, checks suppression, executes direct provider send,
   * updates delivery state, and returns honest provider result.
   */
  static async sendImmediate(
    request: ImmediateEmailRequest,
    options?: EmailServiceSendOptions
  ): Promise<EmailSendResult> {
    if (!request.clientId || request.clientId.trim() === "") {
      throw new Error("clientId is mandatory for immediate email dispatch");
    }

    let subject = request.subject;
    let html = request.html;
    let text = request.text;

    // Render system template if supplied
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
      throw new Error("Email subject cannot be empty");
    }

    if ((!html || html.trim() === "") && (!text || text.trim() === "")) {
      throw new Error("Email must contain either text or html content");
    }

    const sendRequest: EmailSendRequest = {
      clientId: request.clientId,
      to: request.to,
      subject,
      html,
      text,
      from: request.from,
      replyTo: request.replyTo,
      type: "TRANSACTIONAL",
      transactionalReference: request.transactionalReference,
      idempotencyKey: request.idempotencyKey,
    };

    logger.info(
      `[EmailDispatchService:sendImmediate] Dispatching immediate email for client ${request.clientId}`
    );

    return await EmailService.send(sendRequest, options);
  }

  /**
   * 2. BACKGROUND DURABLE ENQUEUE
   * Validates recipient, checks suppression, creates authoritative EmailDelivery,
   * and creates a durable BackgroundJob row in PostgreSQL.
   */
  static async enqueueBackground(
    request: BackgroundEmailRequest
  ): Promise<BackgroundEnqueueResult> {
    const { clientId } = request;
    if (!clientId || clientId.trim() === "") {
      throw new Error("clientId is mandatory for background email dispatch");
    }

    const rawTo = typeof request.to === "string" ? request.to : request.to?.email;
    if (!rawTo || !isValidEmail(rawTo)) {
      throw new Error(`Invalid recipient email address: '${rawTo}'`);
    }
    const normalizedTo = normalizeEmail(rawTo);

    let subject = request.subject;
    let html = request.html;
    let text = request.text;

    // Render system template if supplied
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
      throw new Error("Email subject cannot be empty");
    }

    if ((!html || html.trim() === "") && (!text || text.trim() === "")) {
      throw new Error("Email must contain either text or html content");
    }

    // Business Idempotency Check
    if (request.idempotencyKey && request.idempotencyKey.trim() !== "") {
      const existing = await prisma.emailDelivery.findFirst({
        where: {
          clientId,
          idempotencyKey: request.idempotencyKey.trim(),
        },
      });

      if (existing) {
        return {
          queued: existing.status === EmailDeliveryStatus.QUEUED,
          deliveryId: existing.id,
          jobId: `existing-job-${existing.id}`,
          status: existing.status === EmailDeliveryStatus.QUEUED ? "QUEUED" : "FAILED",
        };
      }
    }

    // Check Suppression List
    const suppression = await prisma.emailSuppression.findUnique({
      where: {
        clientId_normalizedEmail: {
          clientId,
          normalizedEmail: normalizedTo,
        },
      },
    });

    const category = request.category || "TRANSACTIONAL";
    const fromAddress = typeof request.from === "string"
      ? request.from
      : request.from?.email || "notifications@system.local";

    if (suppression) {
      logger.warn(
        `[EmailDispatchService:enqueueBackground] Recipient ${normalizedTo} is suppressed (${suppression.reason}). Creating rejected delivery.`
      );

      const delivery = await prisma.emailDelivery.create({
        data: {
          clientId,
          providerType: EmailProviderType.GMAIL, // Default fallback
          category,
          from: fromAddress,
          to: normalizedTo,
          replyTo: request.replyTo,
          subject,
          htmlContent: html,
          textContent: text,
          templateId: request.templateId,
          templateVersionId: request.templateVersionId,
          campaignId: request.campaignId,
          campaignRecipientId: request.campaignRecipientId,
          transactionalReference: request.transactionalReference,
          idempotencyKey: request.idempotencyKey,
          status: EmailDeliveryStatus.FAILED,
          failureCategory: EmailFailureCategory.INVALID_RECIPIENT,
          errorCode: "RECIPIENT_SUPPRESSED",
          errorMessage: `Recipient is suppressed due to: ${suppression.reason}`,
          failedAt: new Date(),
        },
      });

      return {
        queued: false,
        deliveryId: delivery.id,
        jobId: `suppressed-${delivery.id}`,
        status: "FAILED",
        errorCode: "RECIPIENT_SUPPRESSED",
        errorMessage: `Recipient is suppressed due to: ${suppression.reason}`,
      };
    }

    const availableAt = request.delayMs && request.delayMs > 0
      ? new Date(Date.now() + request.delayMs)
      : new Date();

    // Persist EmailDelivery and durable BackgroundJob atomically in PostgreSQL
    const { delivery, backgroundJob } = await prisma.$transaction(async (tx) => {
      const d = await tx.emailDelivery.create({
        data: {
          clientId,
          providerType: EmailProviderType.GMAIL,
          category,
          from: fromAddress,
          to: normalizedTo,
          replyTo: request.replyTo,
          subject,
          htmlContent: html,
          textContent: text,
          templateId: request.templateId,
          templateVersionId: request.templateVersionId,
          campaignId: request.campaignId,
          campaignRecipientId: request.campaignRecipientId,
          transactionalReference: request.transactionalReference,
          idempotencyKey: request.idempotencyKey,
          status: EmailDeliveryStatus.QUEUED,
          nextAttemptAt: availableAt,
        },
      });

      const bg = await tx.backgroundJob.create({
        data: {
          clientId,
          type: category === "PROMOTIONAL" ? "PROMOTIONAL_EMAIL" : "TRANSACTIONAL_EMAIL",
          status: BackgroundJobStatus.QUEUED,
          payload: JSON.stringify({
            deliveryId: d.id,
            clientId,
            category,
          }),
          scheduledAt: availableAt,
          availableAt,
          deduplicationKey: `email-delivery:${d.id}`,
        },
      });

      return { delivery: d, backgroundJob: bg };
    });

    logger.info(
      `[EmailDispatchService:enqueueBackground] Enqueued delivery ${delivery.id} with durable BackgroundJob ${backgroundJob.id}`
    );

    return {
      queued: true,
      deliveryId: delivery.id,
      jobId: backgroundJob.id,
      status: "QUEUED",
    };
  }
}
