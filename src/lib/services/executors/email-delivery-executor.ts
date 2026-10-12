/**
 * EmailDeliveryExecutor
 *
 * Neutral, BullMQ-free execution service for single email delivery (transactional or promotional).
 * - Accepts plain typed inputs
 * - Enforces monotonic status transitions
 * - Verifies suppression list and sender identity
 * - Resolves tenant provider binding
 * - Uses clean JobError taxonomy (RetryableError / PermanentError)
 * - Every post-claim write is bound to the claim token, and the row carries an in-flight
 *   send marker while the provider call is outstanding (see claim-lock.ts)
 */

import { prisma } from "../../prisma";
import {
  EmailContactStatus,
  EmailDeliveryStatus,
  EmailProviderType,
  EmailFailureCategory,
  EmailDelivery,
  EmailType,
} from "@prisma/client";
import { providerRegistry } from "../../email/registry";
import { EmailProvider, EmailSendResult } from "../../email/types";
import { normalizeEmail } from "../../email/normalization";
import { EmailTrackingService } from "../../email/tracking/email-tracking-service";
import { EmailUnsubscribeService } from "../email-unsubscribe-service";
import { getPublicAppUrl } from "../../env";
import {
  RetryableError,
  PermanentError,
  classifyJobError,
  providerFailureError,
} from "../../errors/job-errors";
import { logger } from "../../logger";
import {
  newClaimToken,
  notSendInFlight,
  sendInFlightToken,
  staleLockCutoff,
} from "./claim-lock";

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

const TERMINAL_STATUSES: EmailDeliveryStatus[] = [
  EmailDeliveryStatus.SENT,
  EmailDeliveryStatus.DELIVERED,
  EmailDeliveryStatus.BOUNCED,
  EmailDeliveryStatus.COMPLAINED,
  EmailDeliveryStatus.FAILED,
];

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

    // 2. Terminal State Guard (FAILED is terminal: retryable failures are re-queued as QUEUED)
    if (TERMINAL_STATUSES.includes(delivery.status)) {
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
    let lockToken: string;
    let currentAttempt: number;

    if (claimToken) {
      // Caller has pre-claimed the row (and already incremented attemptCount). Verify ownership.
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
      lockToken = claimToken;
      currentAttempt = delivery.attemptCount || 1;
    } else {
      // Caller has NOT pre-claimed. Atomically claim via conditional update.
      lockToken = newClaimToken("executor");
      const staleCutoff = staleLockCutoff();

      const claimResult = await prisma.emailDelivery.updateMany({
        where: {
          id: delivery.id,
          OR: [
            { status: EmailDeliveryStatus.QUEUED },
            // Stale lock recovery: in PROCESSING but abandoned, and never reached the provider send
            {
              status: EmailDeliveryStatus.PROCESSING,
              AND: [
                notSendInFlight,
                {
                  OR: [
                    { lockedAt: { lt: staleCutoff } },
                    { lockedAt: null, lastAttemptAt: { lt: staleCutoff } },
                  ],
                },
              ],
            },
          ],
        },
        data: {
          status: EmailDeliveryStatus.PROCESSING,
          attemptCount: { increment: 1 },
          lastAttemptAt: new Date(),
          lockedAt: new Date(),
          lockedBy: lockToken,
        },
      });

      if (claimResult.count === 0) {
        // We are a losing claimant. Check fresh state.
        const fresh = await prisma.emailDelivery.findUnique({
          where: { id: delivery.id },
        });

        if (fresh && TERMINAL_STATUSES.includes(fresh.status)) {
          return {
            success: true,
            deliveryId,
            status: fresh.status,
            skipped: true,
            reason: "ALREADY_TERMINAL",
          };
        }

        if (fresh?.status === EmailDeliveryStatus.PROCESSING) {
          // Includes stale rows with an in-flight send marker: reconciliation resolves those.
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
      currentAttempt = (delivery.attemptCount || 0) + 1;
    }

    const ownedByUs = { id: delivery.id, status: EmailDeliveryStatus.PROCESSING, lockedBy: lockToken };

    // 4. Verify Suppression List
    const isSuppressed = await prisma.emailSuppression.findFirst({
      where: {
        clientId: delivery.clientId,
        email: delivery.to,
      },
    });

    if (isSuppressed) {
      await prisma.emailDelivery.updateMany({
        where: ownedByUs,
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

    // 4b. Promotional email: marketing consent + RFC 8058 one-click unsubscribe headers
    let unsubscribeHeaders: Record<string, string> | undefined;
    if (delivery.category === EmailType.PROMOTIONAL) {
      const contact = await prisma.emailContact.findFirst({
        where: { clientId: delivery.clientId, normalizedEmail: normalizeEmail(delivery.to) },
      });
      if (contact) {
        if (!contact.hasMarketingConsent || contact.status !== EmailContactStatus.SUBSCRIBED) {
          await prisma.emailDelivery.updateMany({
            where: ownedByUs,
            data: {
              status: EmailDeliveryStatus.FAILED,
              errorCode: "MARKETING_CONSENT_REQUIRED",
              errorMessage: `Contact '${delivery.to}' has not provided marketing consent. Promotional dispatch rejected.`,
              failedAt: new Date(),
              lockedAt: null,
              lockedBy: null,
            },
          });
          throw new PermanentError(
            `Contact '${delivery.to}' does not have marketing consent for promotional email.`,
            "MARKETING_CONSENT_REQUIRED"
          );
        }
        unsubscribeHeaders = EmailUnsubscribeService.getOneClickUnsubscribeHeaders(
          getPublicAppUrl(),
          EmailUnsubscribeService.generateUnsubscribeToken(delivery.clientId, contact.id)
        );
      }
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
            where: ownedByUs,
            data: { providerConfigId: resolved.configId },
          });
        }
      } catch (resolveErr) {
        const msg = resolveErr instanceof Error ? resolveErr.message : "Provider resolution failed";
        await prisma.emailDelivery.updateMany({
          where: ownedByUs,
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

    // 6. Validate content (promotional HTML gets the signed open pixel and wrapped links)
    const outgoingHtml = delivery.htmlContent
      ? delivery.category === EmailType.PROMOTIONAL
        ? EmailTrackingService.prepareTrackedHtml(delivery.htmlContent, delivery.clientId, delivery.id, {
            baseUrl: getPublicAppUrl(),
          })
        : delivery.htmlContent
      : undefined;
    const outgoingText = delivery.textContent || undefined;

    if (!outgoingHtml && !outgoingText) {
      const emptyErr = new PermanentError(
        `EmailDelivery '${delivery.id}' has neither htmlContent nor textContent.`
      );
      await prisma.emailDelivery.updateMany({
        where: ownedByUs,
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

    // 7. Mark the send as in flight. From here on, a crash leaves a marker that prevents an
    //    automatic re-send (the provider may already have accepted the message).
    const inFlightToken = sendInFlightToken(lockToken);
    const marked = await prisma.emailDelivery.updateMany({
      where: ownedByUs,
      data: { lockedBy: inFlightToken, lockedAt: new Date() },
    });
    if (marked.count === 0) {
      logger.warn(`[EmailDeliveryExecutor] Delivery ${delivery.id} lock lost before send. Skipping without external send.`);
      return {
        success: true,
        deliveryId,
        status: delivery.status,
        skipped: true,
        reason: "CLAIM_LOST",
      };
    }
    const ownedInFlight = { id: delivery.id, status: EmailDeliveryStatus.PROCESSING, lockedBy: inFlightToken };

    // 8. Execute Send via Resolved Provider
    let sendResult: EmailSendResult;
    try {
      sendResult = await provider.send({
        clientId: delivery.clientId,
        from: fromAddress,
        to: delivery.to,
        subject: delivery.subject,
        html: outgoingHtml,
        text: outgoingText,
        replyTo: delivery.replyTo || undefined,
        type: delivery.category,
        headers: unsubscribeHeaders,
        idempotencyKey: delivery.idempotencyKey || `delivery-${delivery.id}`,
      });

      if (!sendResult.success) {
        throw providerFailureError(sendResult.error);
      }
    } catch (sendErr) {
      const classification = classifyJobError(sendErr);

      if (classification.isRetryable && currentAttempt < maxAttempts) {
        const backoffMs = Math.min(300000, 1000 * Math.pow(2, currentAttempt));
        const nextAttemptAt = new Date(Date.now() + backoffMs);

        await prisma.emailDelivery.updateMany({
          where: ownedInFlight,
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
      }

      // Permanent failure
      await prisma.emailDelivery.updateMany({
        where: ownedInFlight,
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

    // 9. Record SENT. The provider has accepted the message, so a failure here must never lead
    //    to a re-send: the in-flight marker stays and reconciliation flags the row instead.
    try {
      const recorded = await prisma.emailDelivery.updateMany({
        where: ownedInFlight,
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
      if (recorded.count === 0) {
        logger.warn(
          `[EmailDeliveryExecutor] Delivery ${delivery.id} was sent (providerMessageId: ${sendResult.providerMessageId}) but its lock changed owner; SENT not recorded.`
        );
      }
    } catch (recordErr) {
      logger.error(
        `[EmailDeliveryExecutor] Delivery ${delivery.id} was sent (providerMessageId: ${sendResult.providerMessageId}) but recording SENT failed. Leaving in-flight marker to prevent a duplicate send.`,
        recordErr
      );
      throw new PermanentError(
        `Delivery ${delivery.id} sent but status could not be recorded: ${recordErr instanceof Error ? recordErr.message : String(recordErr)}`,
        "SENT_NOT_RECORDED"
      );
    }

    logger.info(
      `[EmailDeliveryExecutor] Delivery ${delivery.id} SENT successfully via ${providerType}`
    );

    return {
      success: true,
      deliveryId: delivery.id,
      status: EmailDeliveryStatus.SENT,
      providerMessageId: sendResult.providerMessageId,
    };
  }
}
