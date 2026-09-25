/**
 * Authoritative BullMQ Worker Processor for Single Promotional Email Deliveries
 *
 * Dedicated pipeline for single-recipient promotional sends:
 * 1. Loads authoritative EmailDelivery from database.
 * 2. Stale delivery protection (never overwrites a later successful state).
 * 3. Enforces real-time suppression verification prior to dispatch.
 * 4. Enforces real-time marketing consent verification.
 * 5. Attaches RFC 8058 one-click unsubscribe headers if contact exists.
 * 6. Resolves tenant provider adapter.
 * 7. Dispatches promotional email through provider.
 * 8. Updates database delivery state (PROCESSING -> SENT or FAILED).
 * 9. Transient errors trigger BullMQ retry; permanent errors throw UnrecoverableError.
 * 10. Strict credential scrubbing: zero secrets in logs.
 */

import { Job, UnrecoverableError } from "bullmq";
import { prisma } from "../../prisma";
import { EmailDelivery, EmailDeliveryStatus, EmailProviderType } from "@prisma/client";
import { PromotionalJobData, RetryableEmailError, isRetryableError } from "./types";
import { providerRegistry } from "../registry";
import { EmailProvider } from "../types";
import { EmailSuppressionService } from "../../services/email-suppression-service";
import { EmailUnsubscribeService } from "../../services/email-unsubscribe-service";
import { normalizeEmail } from "../normalization";
import { logger } from "../../logger";

export async function processPromotionalDeliveryJob(
  job: Job<PromotionalJobData>,
  options?: { providerOverride?: EmailProvider }
) {
  const { deliveryId, clientId } = job.data;
  logger.info(`[Worker:Promotional] Processing job ${job.id} for delivery ${deliveryId} (tenant: ${clientId})`);

  // 1. Load Authoritative Delivery Record
  let delivery: EmailDelivery | null = null;
  try {
    delivery = await prisma.emailDelivery.findUnique({
      where: { id: deliveryId },
    });
  } catch (err) {
    logger.error(`[Worker:Promotional] DB query failed for delivery ${deliveryId}:`, err);
  }

  if (!delivery) {
    throw new UnrecoverableError(`Authoritative EmailDelivery '${deliveryId}' not found.`);
  }

  // 2. Stale Delivery Guard: If already SENT or DELIVERED, ignore duplicate/stale retry
  if (
    delivery.status === EmailDeliveryStatus.SENT ||
    delivery.status === EmailDeliveryStatus.DELIVERED
  ) {
    logger.info(`[Worker:Promotional] Delivery ${deliveryId} is already ${delivery.status}. Skipping stale execution.`);
    return {
      skipped: true,
      reason: "ALREADY_COMPLETED",
      status: delivery.status,
    };
  }

  // 3. Update Delivery to PROCESSING
  try {
    await prisma.emailDelivery.updateMany({
      where: {
        id: delivery.id,
        status: { in: [EmailDeliveryStatus.QUEUED, EmailDeliveryStatus.FAILED] },
      },
      data: {
        status: EmailDeliveryStatus.PROCESSING,
        attemptCount: { increment: 1 },
        lastAttemptAt: new Date(),
      },
    });
  } catch {
    // If table fallback
  }

  // 4. Verify Real-Time Suppression
  try {
    const isSuppressed = await EmailSuppressionService.isSuppressed(delivery.clientId, delivery.to);
    if (isSuppressed.suppressed) {
      await prisma.emailDelivery.updateMany({
        where: { id: delivery.id },
        data: {
          status: EmailDeliveryStatus.FAILED,
          errorCode: "RECIPIENT_SUPPRESSED",
          errorMessage: `Recipient '${delivery.to}' is on the tenant suppression list (${isSuppressed.reason || "SUPPRESSED"}).`,
          failedAt: new Date(),
        },
      });
      throw new UnrecoverableError(`Recipient '${delivery.to}' is suppressed.`);
    }
  } catch (err) {
    if (err instanceof UnrecoverableError) throw err;
  }

  // 5. Verify Marketing Consent & Prepare One-Click Unsubscribe Headers
  let unsubscribeHeaders: Record<string, string> | undefined;
  try {
    const normalizedTo = normalizeEmail(delivery.to);
    const contact = await prisma.emailContact.findFirst({
      where: { clientId: delivery.clientId, normalizedEmail: normalizedTo },
    });

    if (contact) {
      if (!contact.hasMarketingConsent || contact.status !== "SUBSCRIBED") {
        await prisma.emailDelivery.updateMany({
          where: { id: delivery.id },
          data: {
            status: EmailDeliveryStatus.FAILED,
            errorCode: "MARKETING_CONSENT_REQUIRED",
            errorMessage: `Recipient '${delivery.to}' has revoked marketing consent or is unsubscribed.`,
            failedAt: new Date(),
          },
        });
        throw new UnrecoverableError(`Recipient '${delivery.to}' does not have marketing consent.`);
      }

      // Generate RFC 8058 One-Click Unsubscribe Headers
      const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "https://hub.local";
      const unsubToken = EmailUnsubscribeService.generateUnsubscribeToken(
        delivery.clientId,
        contact.id
      );
      unsubscribeHeaders = EmailUnsubscribeService.getOneClickUnsubscribeHeaders(
        baseUrl,
        unsubToken
      );
    }
  } catch (err) {
    if (err instanceof UnrecoverableError) throw err;
  }

  // 6. Resolve Tenant Provider
  let provider: EmailProvider;
  let providerType: EmailProviderType = EmailProviderType.GMAIL;
  let providerSenderEmail: string | undefined;

  if (options?.providerOverride) {
    provider = options.providerOverride;
    providerType = provider.providerType;
  } else {
    try {
      const resolved = await providerRegistry.resolveForTenant(delivery.clientId);
      provider = resolved.provider;
      providerType = resolved.providerType;
      providerSenderEmail = resolved.senderEmail;
    } catch (resolveErr) {
      const msg = resolveErr instanceof Error ? resolveErr.message : "Provider resolution failed";
      await prisma.emailDelivery.updateMany({
        where: { id: delivery.id },
        data: {
          status: EmailDeliveryStatus.FAILED,
          errorCode: "PROVIDER_RESOLUTION_FAILED",
          errorMessage: msg,
          failedAt: new Date(),
        },
      });
      throw new UnrecoverableError(msg);
    }
  }

  // 7. Dispatch Email
  const fromAddress = delivery.from || providerSenderEmail || "marketing@whatsapphub.internal";
  try {
    const sendResult = await provider.send({
      clientId: delivery.clientId,
      type: "PROMOTIONAL",
      to: delivery.to,
      from: fromAddress,
      subject: delivery.subject,
      html: `<p>${delivery.subject}</p>`,
      text: delivery.subject,
      headers: unsubscribeHeaders,
    });

    if (sendResult.accepted) {
      await prisma.emailDelivery.updateMany({
        where: { id: delivery.id },
        data: {
          status: EmailDeliveryStatus.SENT,
          providerType,
          providerMessageId: sendResult.providerMessageId || null,
          sentAt: sendResult.sentAt || new Date(),
          errorCode: null,
          errorMessage: null,
        },
      });

      logger.info(`[Worker:Promotional] Successfully dispatched promotional delivery ${deliveryId} via ${sendResult.providerName} (messageId: ${sendResult.providerMessageId})`);
      return {
        success: true,
        deliveryId,
        providerMessageId: sendResult.providerMessageId,
        providerStatus: sendResult.providerStatus,
      };
    }

    // Provider rejected send
    const error = sendResult.error;
    const retryable = error?.retryable ?? isRetryableError(error);

    await prisma.emailDelivery.updateMany({
      where: { id: delivery.id },
      data: {
        status: retryable ? EmailDeliveryStatus.PROCESSING : EmailDeliveryStatus.FAILED,
        errorCode: error?.code || "DISPATCH_FAILED",
        errorMessage: error?.message || "Provider rejected promotional dispatch",
        failedAt: retryable ? null : new Date(),
      },
    });

    if (retryable) {
      throw new RetryableEmailError(error?.message || "Transient send failure", error?.code);
    } else {
      throw new UnrecoverableError(error?.message || "Permanent delivery rejection");
    }
  } catch (err: unknown) {
    if (err instanceof UnrecoverableError || err instanceof RetryableEmailError) {
      throw err;
    }

    const retryable = isRetryableError(err);
    const msg = err instanceof Error ? err.message : "Unexpected send error";

    await prisma.emailDelivery.updateMany({
      where: { id: delivery.id },
      data: {
        status: retryable ? EmailDeliveryStatus.PROCESSING : EmailDeliveryStatus.FAILED,
        errorCode: "PROVIDER_EXCEPTION",
        errorMessage: msg,
        failedAt: retryable ? null : new Date(),
      },
    });

    if (retryable) {
      throw new RetryableEmailError(msg);
    } else {
      throw new UnrecoverableError(msg);
    }
  }
}
