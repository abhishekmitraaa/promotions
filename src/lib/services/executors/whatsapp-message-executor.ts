/**
 * WhatsAppMessageExecutor
 *
 * Retries an outbound WhatsApp message whose first (synchronous) attempt hit a transient
 * Meta failure. Runs from a WHATSAPP_MESSAGE BackgroundJob.
 * - Atomic claim on the Message row (status stays QUEUED; lockedBy marks ownership)
 * - In-flight marker before the Meta call, so a crash mid-send is never re-sent (see claim-lock.ts)
 * - Transient failure -> RetryableError (job is re-queued with backoff) until the attempt limit
 * - Permanent failure or exhausted attempts -> FAILED + message.failed webhook
 */

import { prisma } from "../../prisma";
import { MessageDirection, MessageStatus } from "@prisma/client";
import { sendWhatsAppMessage } from "../../whatsapp/client";
import { WhatsAppApiError } from "../../whatsapp/errors";
import { dispatchOutgoingWebhooks } from "../../webhooks/dispatcher";
import { RetryableError, PermanentError } from "../../errors/job-errors";
import { logger } from "../../logger";
import { buildMetaPayload, WHATSAPP_MAX_SEND_ATTEMPTS } from "../message-service";
import { newClaimToken, notSendInFlight, sendInFlightToken, staleLockCutoff } from "./claim-lock";

export interface ExecuteWhatsAppMessageOptions {
  messageId: string;
  maxAttempts?: number;
}

export interface ExecuteWhatsAppMessageResult {
  success: boolean;
  messageId: string;
  status: MessageStatus;
  skipped?: boolean;
  reason?: string;
  providerMessageId?: string | null;
}

export class WhatsAppMessageExecutor {
  static async execute(options: ExecuteWhatsAppMessageOptions): Promise<ExecuteWhatsAppMessageResult> {
    const { messageId, maxAttempts = WHATSAPP_MAX_SEND_ATTEMPTS } = options;

    const message = await prisma.message.findUnique({ where: { id: messageId } });
    if (!message) {
      throw new PermanentError(`WhatsApp message '${messageId}' not found.`);
    }
    if (message.direction !== MessageDirection.OUTBOUND) {
      throw new PermanentError(`Message '${messageId}' is not an outbound message.`);
    }

    // Only QUEUED messages are retryable; anything else already reached a final or sent state
    if (message.status !== MessageStatus.QUEUED) {
      return { success: true, messageId, status: message.status, skipped: true, reason: "ALREADY_TERMINAL" };
    }

    // 1. Atomic claim (free row, or an abandoned lock that never reached the provider call)
    const lockToken = newClaimToken("wa-retry");
    const claim = await prisma.message.updateMany({
      where: {
        id: message.id,
        status: MessageStatus.QUEUED,
        OR: [{ lockedBy: null }, { AND: [notSendInFlight, { lockedAt: { lt: staleLockCutoff() } }] }],
      },
      data: { lockedBy: lockToken, lockedAt: new Date(), attemptCount: { increment: 1 } },
    });
    if (claim.count === 0) {
      const fresh = await prisma.message.findUnique({ where: { id: message.id } });
      if (fresh && fresh.status !== MessageStatus.QUEUED) {
        return { success: true, messageId, status: fresh.status, skipped: true, reason: "ALREADY_TERMINAL" };
      }
      // Held by another attempt (including a stale in-flight send, which reconciliation resolves)
      return { success: true, messageId, status: MessageStatus.QUEUED, skipped: true, reason: "CONTENTION_LOCK_HELD" };
    }
    const currentAttempt = (message.attemptCount || 0) + 1;

    // 2. Mark the send as in flight
    const inFlightToken = sendInFlightToken(lockToken);
    const marked = await prisma.message.updateMany({
      where: { id: message.id, status: MessageStatus.QUEUED, lockedBy: lockToken },
      data: { lockedBy: inFlightToken, lockedAt: new Date() },
    });
    if (marked.count === 0) {
      return { success: true, messageId, status: MessageStatus.QUEUED, skipped: true, reason: "CLAIM_LOST" };
    }
    const ownedInFlight = { id: message.id, status: MessageStatus.QUEUED, lockedBy: inFlightToken };

    // 3. Send
    let providerMessageId: string | null;
    try {
      const metaResult = await sendWhatsAppMessage(buildMetaPayload(message));
      providerMessageId = metaResult.messages?.[0]?.id || null;
    } catch (err) {
      const errorCode = err instanceof WhatsAppApiError ? String(err.errorCode || err.statusCode) : "SEND_FAILED";
      const errorMessage = err instanceof Error ? err.message : "Failed to send message via Meta WhatsApp API";
      const transient = err instanceof WhatsAppApiError && err.isTransient;

      if (transient && currentAttempt < maxAttempts) {
        await prisma.message.updateMany({
          where: ownedInFlight,
          data: { errorCode, errorMessage, lockedAt: null, lockedBy: null },
        });
        logger.warn(
          `[WhatsAppMessageExecutor] Message ${message.id} failed transiently (attempt ${currentAttempt}/${maxAttempts}): ${errorMessage}`
        );
        throw new RetryableError(`Transient error sending WhatsApp message ${message.id}: ${errorMessage}`, errorCode);
      }

      const failed = await prisma.message.updateMany({
        where: ownedInFlight,
        data: { status: MessageStatus.FAILED, errorCode, errorMessage, failedAt: new Date(), lockedAt: null, lockedBy: null },
      });
      if (failed.count === 1) {
        await dispatchOutgoingWebhooks(
          "message.failed",
          { messageId: message.id, to: message.to, status: "FAILED", errorCode, errorMessage },
          message.clientId
        );
      }
      logger.error(`[WhatsAppMessageExecutor] Message ${message.id} permanently failed: ${errorMessage}`);
      throw new PermanentError(`Permanent error sending WhatsApp message ${message.id}: ${errorMessage}`, errorCode);
    }

    // 4. Record SENT. Meta accepted the message: a failure here must never lead to a re-send,
    //    so the in-flight marker stays and reconciliation flags the row instead.
    const sentAt = new Date();
    try {
      await prisma.message.updateMany({
        where: ownedInFlight,
        data: {
          status: MessageStatus.SENT,
          providerMessageId,
          sentAt,
          errorCode: null,
          errorMessage: null,
          lockedAt: null,
          lockedBy: null,
        },
      });
    } catch (recordErr) {
      logger.error(
        `[WhatsAppMessageExecutor] Message ${message.id} was sent (providerMessageId: ${providerMessageId}) but recording SENT failed.`,
        recordErr
      );
      throw new PermanentError(`WhatsApp message ${message.id} sent but status could not be recorded.`, "SENT_NOT_RECORDED");
    }

    await dispatchOutgoingWebhooks(
      "message.sent",
      { messageId: message.id, providerMessageId, to: message.to, status: "SENT", sentAt },
      message.clientId
    );

    logger.info(`[WhatsAppMessageExecutor] Message ${message.id} SENT on attempt ${currentAttempt}`);
    return { success: true, messageId, status: MessageStatus.SENT, providerMessageId };
  }
}
