/**
 * EmailDeliveryExecutor
 *
 * Neutral, BullMQ-free execution service for single email delivery (transactional or promotional).
 * - Accepts plain typed inputs
 * - Enforces monotonic status transitions
 * - Verifies suppression list and sender identity
 * - Resolves tenant provider binding
 * - Uses clean JobError taxonomy (RetryableError / PermanentError)
 */

import { prisma } from "../../prisma";
import {
  EmailDeliveryStatus,
  EmailProviderType,
  EmailFailureCategory,
  EmailDelivery,
} from "@prisma/client";
import { providerRegistry } from "../../email/registry";
import { EmailProvider } from "../../email/types";
import {
  RetryableError,
  PermanentError,
  classifyJobError,
} from "../../errors/job-errors";
import { logger } from "../../logger";

export interface ExecuteEmailDeliveryOptions {
  deliveryId: string;
  clientId?: string;
  claimToken?: string;
  providerOverride?: EmailProvider;
  maxAttempts?: number;
}

export interface ExecuteEmailDeliveryResult {
  success: boolean;
  deliveryId: string;
  status: EmailDeliveryStatus;
  skipped?: boolean;
  reason?: string;
  providerMessageId?: string;
  errorCode?: string;
  errorMessage?: string;
}

export class EmailDeliveryExecutor {
  static async execute(options: ExecuteEmailDeliveryOptions): Promise<ExecuteEmailDeliveryResult> {
    const { deliveryId, claimToken, maxAttempts = 5 } = options;

    logger.info(`[EmailDeliveryExecutor] Executing delivery ${deliveryId} (claimToken: ${claimToken || "none"})`);

    // 1. Load Authoritative Delivery Record
    let delivery: EmailDelivery | null = null;
    try {
      delivery = await prisma.emailDelivery.findUnique({
        where: { id: deliveryId },
      });
    } catch (err) {
      throw new RetryableError(
        `Database query failed for delivery '${deliveryId}': ${err instanceof Error ? err.message : String(err)}`
      );
    }

    if (!delivery) {
      throw new PermanentError(`Authoritative EmailDelivery '${deliveryId}' not found.`);
    }

    // 2. Terminal State Guard: If already SENT, DELIVERED, or terminal, skip!
    if (
      delivery.status === EmailDeliveryStatus.SENT ||
      delivery.status === EmailDeliveryStatus.DELIVERED ||
      delivery.status === EmailDeliveryStatus.BOUNCED ||
      delivery.status === EmailDeliveryStatus.COMPLAINED
    ) {
      logger.info(`[EmailDeliveryExecutor] Delivery ${deliveryId} is already in terminal state ${delivery.status}. Skipping.`);
      return {
        success: true,
        deliveryId,
        status: delivery.status,
        skipped: true,
        reason: "ALREADY_TERMINAL",
      };
    }

    // 3. Authoritative Atomic Claim Mechanism
    if (claimToken) {
      // Caller has pre-claimed the row. Verify ownership.
      if (delivery.status !== EmailDeliveryStatus.PROCESSING || delivery.lockedBy !== claimToken) {
        logger.warn(
          `[EmailDeliveryExecutor] Delivery ${deliveryId} claimToken mismatch or lock lost. Current status: ${delivery.status}, lockedBy: ${delivery.lockedBy}. Skipping.`
        );
        return {
          success: true,
          deliveryId,
          status: delivery.status,
          skipped: true,
          reason: "CLAIM_TOKEN_MISMATCH",
        };
      }
    } else {
      // Caller has NOT pre-claimed. Atomically claim via conditional update.
      const workerClaimToken = `executor-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const staleCutoff = new Date(Date.now() - 10 * 60 * 1000);

      const claimResult = await prisma.emailDelivery.updateMany({
        where: {
          id: delivery.id,
          OR: [
            { status: EmailDeliveryStatus.QUEUED },
            { status: EmailDeliveryStatus.FAILED, attemptCount: { lt: maxAttempts } },
            // Stale lock recovery: in PROCESSING but abandoned (>10m)
            {
              status: EmailDeliveryStatus.PROCESSING,
              OR: [
                { lockedAt: { lt: staleCutoff } },
                { lockedAt: null, lastAttemptAt: { lt: staleCutoff } },
              ],
            },
          ],
        },
        data: {
          status: EmailDeliveryStatus.PROCESSING,
          attemptCount: { increment: 1 },
          lastAttemptAt: new Date(),
          lockedAt: new Date(),
          lockedBy: workerClaimToken,
        },
      });

      if (claimResult.count === 0) {
        // We are a losing claimant. Check fresh state.
        const fresh = await prisma.emailDelivery.findUnique({
          where: { id: delivery.id },
        });

        if (fresh?.status === EmailDeliveryStatus.SENT || fresh?.status === EmailDeliveryStatus.DELIVERED) {
          return {
            success: true,
            deliveryId,
            status: fresh.status,
            skipped: true,
            reason: "ALREADY_TERMINAL",
          };
        }

        if (fresh?.status === EmailDeliveryStatus.PROCESSING) {
          logger.info(
            `[EmailDeliveryExecutor] Delivery ${deliveryId} actively held by claimant '${fresh.lockedBy}'. Skipping without external send.`
          );
          return {
            success: true,
            deliveryId,
            status: fresh.status,
            skipped: true,
            reason: "CONTENTION_LOCK_HELD",
          };
        }

        return {
          success: false,
          deliveryId,
          status: fresh?.status || delivery.status,
          skipped: true,
          reason: "CLAIM_CONTENTION",
        };
      }
    }

    const currentAttempt = (delivery.attemptCount || 0) + 1;

    // 4. Verify Suppression List
    const isSuppressed = await prisma.emailSuppression.findFirst({
      where: {
        clientId: delivery.clientId,
        email: delivery.to,
      },
    });

    if (isSuppressed) {
      await prisma.emailDelivery.updateMany({
        where: { id: delivery.id, status: EmailDeliveryStatus.PROCESSING },
        data: {
          status: EmailDeliveryStatus.FAILED,
          errorCode: "RECIPIENT_SUPPRESSED",
          errorMessage: `Recipient '${delivery.to}' is on tenant suppression list (${isSuppressed.reason}).`,
          failureCategory: EmailFailureCategory.INVALID_RECIPIENT,
          diagnosticDetails: "Recipient is suppressed. Sending blocked.",
          failedAt: new Date(),
          lockedAt: null,
          lockedBy: null,
        },
      });

      throw new PermanentError(`Recipient '${delivery.to}' is suppressed.`);
    }

    // 5. Resolve Provider
    let provider: EmailProvider;
    let providerType: EmailProviderType = EmailProviderType.GMAIL;
    let providerSenderEmail: string | undefined;

    if (options.providerOverride) {
      provider = options.providerOverride;
      providerType = provider.providerType;
    } else {
      try {
        const resolved = await providerRegistry.resolveForTenant(
          delivery.clientId,
          delivery.providerConfigId || undefined
        );
        provider = resolved.provider;
        providerType = resolved.providerType;
        providerSenderEmail = resolved.senderEmail;

        if (!delivery.providerConfigId && resolved.configId) {
          await prisma.emailDelivery.updateMany({
            where: { id: delivery.id },
            data: { providerConfigId: resolved.configId },
          });
        }
      } catch (resolveErr) {
        const msg = resolveErr instanceof Error ? resolveErr.message : "Provider resolution failed";
        await prisma.emailDelivery.updateMany({
          where: { id: delivery.id, status: EmailDeliveryStatus.PROCESSING },
          data: {
            status: EmailDeliveryStatus.FAILED,
            errorCode: "PROVIDER_RESOLUTION_FAILED",
            errorMessage: msg,
            failedAt: new Date(),
            lockedAt: null,
            lockedBy: null,
          },
        });
        throw new PermanentError(msg);
      }
    }

    // 6. Execute Send via Resolved Provider
    const outgoingHtml = delivery.htmlContent || undefined;
    const outgoingText = delivery.textContent || undefined;

    if (!outgoingHtml && !outgoingText) {
      const emptyErr = new PermanentError(
        `EmailDelivery '${delivery.id}' has neither htmlContent nor textContent.`
      );
      await prisma.emailDelivery.updateMany({
        where: { id: delivery.id, status: EmailDeliveryStatus.PROCESSING },
        data: {
          status: EmailDeliveryStatus.FAILED,
          errorCode: "EMPTY_CONTENT",
          errorMessage: emptyErr.message,
          failedAt: new Date(),
          lockedAt: null,
          lockedBy: null,
        },
      });
      throw emptyErr;
    }

    const fromAddress = providerSenderEmail || delivery.from;

    try {
      const sendResult = await provider.send({
        clientId: delivery.clientId,
        from: fromAddress,
        to: delivery.to,
        subject: delivery.subject,
        html: outgoingHtml,
        text: outgoingText,
        replyTo: delivery.replyTo || undefined,
        type: delivery.category,
        idempotencyKey: delivery.idempotencyKey || `delivery-${delivery.id}`,
      });

      if (!sendResult.success) {
        throw new Error(sendResult.error?.message || "Provider returned failure");
      }

      // 7. Update to SENT
      await prisma.emailDelivery.updateMany({
        where: { id: delivery.id, status: EmailDeliveryStatus.PROCESSING },
        data: {
          status: EmailDeliveryStatus.SENT,
          sentAt: new Date(),
          providerType,
          providerMessageId: sendResult.providerMessageId || null,
          smtpCode: sendResult.error?.statusCode ? String(sendResult.error.statusCode) : null,
          lockedAt: null,
          lockedBy: null,
        },
      });

      logger.info(
        `[EmailDeliveryExecutor] Delivery ${delivery.id} SENT successfully via ${providerType}`
      );

      return {
        success: true,
        deliveryId: delivery.id,
        status: EmailDeliveryStatus.SENT,
        providerMessageId: sendResult.providerMessageId,
      };
    } catch (sendErr) {
      const classification = classifyJobError(sendErr);

      if (classification.isRetryable && currentAttempt < maxAttempts) {
        const backoffMs = Math.min(300000, 1000 * Math.pow(2, currentAttempt));
        const nextAttemptAt = new Date(Date.now() + backoffMs);

        await prisma.emailDelivery.updateMany({
          where: { id: delivery.id },
          data: {
            status: EmailDeliveryStatus.QUEUED,
            nextAttemptAt,
            errorCode: classification.code,
            errorMessage: classification.message,
            lockedAt: null,
            lockedBy: null,
          },
        });

        logger.warn(
          `[EmailDeliveryExecutor] Delivery ${delivery.id} failed transiently (attempt ${currentAttempt}/${maxAttempts}). Scheduled retry at ${nextAttemptAt.toISOString()}`
        );

        throw new RetryableError(
          `Transient error sending delivery ${delivery.id}: ${classification.message}`,
          classification.code,
          backoffMs
        );
      } else {
        // Permanent failure
        await prisma.emailDelivery.updateMany({
          where: { id: delivery.id },
          data: {
            status: EmailDeliveryStatus.FAILED,
            failedAt: new Date(),
            errorCode: classification.code,
            errorMessage: classification.message,
            lockedAt: null,
            lockedBy: null,
          },
        });

        logger.error(
          `[EmailDeliveryExecutor] Delivery ${delivery.id} permanently failed: ${classification.message}`
        );

        throw new PermanentError(
          `Permanent error sending delivery ${delivery.id}: ${classification.message}`,
          classification.code
        );
      }
    }
  }
}
