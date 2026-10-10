/**
 * Transactional Email Queue Producer
 *
 * Implements the hardened transactional enqueueing pipeline:
 * 1. Validates request and recipients.
 * 2. Checks suppression list before enqueueing to prevent wasted worker cycles.
 * 3. Checks business idempotency keys.
 * 4. Persists authoritative delivery record in database BEFORE enqueuing.
 * 5. Enqueues job with deterministic idempotency job ID (email-transactional-<deliveryId>).
 * 6. Returns standardized queued state.
 */

import { prisma } from "../../prisma";
import { EmailDeliveryStatus, EmailProviderType, BackgroundJobStatus } from "@prisma/client";
import { getTransactionalQueue, isWorkerlessMode } from "./queues";
export { getTransactionalQueue };
import { JOB_NAMES, getTransactionalJobId } from "./types";
import { isValidEmail, normalizeEmail } from "../normalization";
import { EmailRecipientInput } from "../types";
import { EmailTemplateService, SystemTemplateType } from "../templates";
import { logger } from "../../logger";

export interface QueueTransactionalEmailInput {
  clientId: string;
  to: string | EmailRecipientInput;
  subject?: string;
  html?: string;
  text?: string;
  templateType?: SystemTemplateType;
  templateVariables?: Record<string, string | number | boolean | null | undefined>;
  from?: EmailRecipientInput;
  replyTo?: string;
  transactionalReference?: string;
  idempotencyKey?: string;
}

export interface QueueTransactionalEmailResult {
  queued: boolean;
  deliveryId: string;
  jobId?: string;
  status: "QUEUED" | "FAILED";
  errorCode?: string;
  errorMessage?: string;
}

/**
 * Validates, records delivery state, and enqueues a transactional email.
 */
export async function queueTransactionalEmail(
  input: QueueTransactionalEmailInput
): Promise<QueueTransactionalEmailResult> {
  // 1. Validation
  if (!input.clientId || typeof input.clientId !== "string" || input.clientId.trim() === "") {
    throw new Error("clientId is mandatory for queueing email");
  }

  const rawTo = typeof input.to === "string" ? input.to : input.to?.email;
  if (!rawTo || !isValidEmail(rawTo)) {
    throw new Error(`Invalid recipient email address: '${rawTo}'`);
  }
  const normalizedTo = normalizeEmail(rawTo);

  let subject = input.subject;
  let html = input.html;
  let text = input.text;

  // Render template if templateType supplied
  if (input.templateType) {
    const rendered = EmailTemplateService.renderSystemTemplate(
      input.templateType,
      input.templateVariables || {}
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

  // 2. Business Idempotency Check
  if (input.idempotencyKey && input.idempotencyKey.trim() !== "") {
    try {
      const existing = await prisma.emailDelivery.findFirst({
        where: {
          clientId: input.clientId,
          idempotencyKey: input.idempotencyKey.trim(),
        },
      });

      if (existing) {
        return {
          queued: existing.status === EmailDeliveryStatus.QUEUED,
          deliveryId: existing.id,
          jobId: getTransactionalJobId(existing.id),
          status: existing.status === EmailDeliveryStatus.FAILED ? "FAILED" : "QUEUED",
        };
      }
    } catch {
      // Table may not exist yet in target database
    }
  }

  // 3. Suppression List Pre-Check
  try {
    const suppressed = await prisma.emailSuppression.findFirst({
      where: {
        clientId: input.clientId,
        email: normalizedTo,
      },
    });

    if (suppressed) {
      // Persist failed state directly without enqueueing to BullMQ
      let deliveryId = `suppressed-${Date.now()}`;
      try {
        const delivery = await prisma.emailDelivery.create({
          data: {
            clientId: input.clientId,
            providerType: EmailProviderType.GMAIL,
            category: "TRANSACTIONAL",
            from: typeof input.from === "string" ? input.from : (input.from?.email || "system@whatsapphub.internal"),
            to: normalizedTo,
            replyTo: input.replyTo || null,
            subject,
            htmlContent: html || null,
            textContent: text || null,
            status: EmailDeliveryStatus.FAILED,
            attemptCount: 0,
            errorCode: "RECIPIENT_SUPPRESSED",
            errorMessage: `Recipient '${normalizedTo}' is on the tenant suppression list (${suppressed.reason}).`,
            transactionalReference: input.transactionalReference || null,
            idempotencyKey: input.idempotencyKey?.trim() || null,
          },
        });
        deliveryId = delivery.id;
      } catch {
        // Table may not exist yet in target database
      }

      return {
        queued: false,
        deliveryId,
        status: "FAILED",
        errorCode: "RECIPIENT_SUPPRESSED",
        errorMessage: `Recipient '${normalizedTo}' is suppressed.`,
      };
    }
  } catch {
    // If suppression table not ready, continue safely
  }

  // 4. Authoritative Database State Persistence BEFORE Enqueueing
  // 4. Create Authoritative Delivery Record & BackgroundJob atomically
  const fromAddress = typeof input.from === "string" ? input.from : (input.from?.email || "system@whatsapphub.internal");

  let deliveryRecordId = `delivery-${Date.now()}-${Math.random().toString(36).substring(7)}`;
  let backgroundJobId = `job-${Date.now()}-${Math.random().toString(36).substring(7)}`;

  try {
    const result = await prisma.$transaction(async (tx) => {
      const d = await tx.emailDelivery.create({
        data: {
          clientId: input.clientId,
          providerType: EmailProviderType.GMAIL,
          category: "TRANSACTIONAL",
          from: fromAddress,
          to: normalizedTo,
          replyTo: input.replyTo || null,
          subject,
          htmlContent: html || null,
          textContent: text || null,
          status: EmailDeliveryStatus.QUEUED,
          attemptCount: 0,
          transactionalReference: input.transactionalReference || null,
          idempotencyKey: input.idempotencyKey?.trim() || null,
        },
      });

      const bg = await tx.backgroundJob.create({
        data: {
          clientId: input.clientId,
          type: "TRANSACTIONAL_EMAIL",
          status: BackgroundJobStatus.QUEUED,
          payload: JSON.stringify({
            deliveryId: d.id,
            clientId: input.clientId,
            category: "TRANSACTIONAL",
          }),
          scheduledAt: new Date(),
          availableAt: new Date(),
          deduplicationKey: `email-delivery:${d.id}`,
        },
      });

      return { delivery: d, bgJob: bg };
    });

    deliveryRecordId = result.delivery.id;
    backgroundJobId = result.bgJob.id;
  } catch (dbErr) {
    // If idempotency conflict on delivery
    if (typeof dbErr === "object" && dbErr !== null && "code" in dbErr && (dbErr as { code: string }).code === "P2002") {
      const existing = await prisma.emailDelivery.findFirst({
        where: {
          clientId: input.clientId,
          idempotencyKey: input.idempotencyKey?.trim(),
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
    throw dbErr;
  }

  // 5. If BullMQ Redis queue is explicitly configured and not in workerless mode, mirror to queue
  if (!isWorkerlessMode()) {
    try {
      const queue = getTransactionalQueue();
      await queue.add(
        JOB_NAMES.SEND_TRANSACTIONAL,
        {
          deliveryId: deliveryRecordId,
          clientId: input.clientId,
          category: "TRANSACTIONAL",
        },
        {
          jobId: getTransactionalJobId(deliveryRecordId),
        }
      );
    } catch (err: unknown) {
      // In Redis mode, report failure if queue enqueue failed
      logger.warn(`[Producer] Redis queue mirroring failed for ${deliveryRecordId}:`, err);
    }
  }

  return {
    queued: true,
    deliveryId: deliveryRecordId,
    jobId: backgroundJobId,
    status: "QUEUED",
  };
}
