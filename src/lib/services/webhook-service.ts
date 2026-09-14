import { env } from "../env";
import { verifyHmacSha256, normalizePhoneNumber } from "../crypto";
import { prisma } from "../prisma";
import { logger } from "../logger";
import { WebhookPayload, WebhookStatus, WebhookIncomingMessage } from "../whatsapp/types";
import { MessageDirection, MessageStatus, MessageType, ProcessingStatus } from "@prisma/client";
import { dispatchOutgoingWebhooks } from "../webhooks/dispatcher";

export class WebhookService {
  /**
   * Verify GET Meta Webhook Challenge.
   */
  static verifyChallenge(
    mode: string | null,
    token: string | null,
    challenge: string | null
  ): { success: boolean; challenge?: string; status: number; message?: string } {
    const configuredToken = env.META_WEBHOOK_VERIFY_TOKEN;

    if (!mode || !token) {
      return {
        success: false,
        status: 400,
        message: "Missing hub.mode or hub.verify_token query parameters",
      };
    }

    if (mode !== "subscribe") {
      return {
        success: false,
        status: 400,
        message: "Invalid hub.mode parameter. Expected 'subscribe'",
      };
    }

    const expectedToken = configuredToken || "development_webhook_verify_token";
    if (token !== expectedToken) {
      logger.warn("Webhook verification failed: token mismatch");
      return {
        success: false,
        status: 403,
        message: "Forbidden: Webhook verification token mismatch",
      };
    }

    logger.info("Meta Webhook verification challenge succeeded!");
    return {
      success: true,
      challenge: challenge || "",
      status: 200,
    };
  }

  /**
   * Validate POST request signature using X-Hub-Signature-256 header.
   */
  static validateSignature(rawBody: string, signatureHeader: string | null): boolean {
    const appSecret = env.META_APP_SECRET;

    // If app secret is not configured in local development, log warning and allow
    if (!appSecret || appSecret.trim() === "") {
      if (env.DEV_ALLOW_UNCONFIGURED_META) {
        logger.warn("[Dev Mode] META_APP_SECRET not configured; skipping X-Hub-Signature-256 validation");
        return true;
      }
      return false;
    }

    if (!signatureHeader) {
      logger.error("Missing X-Hub-Signature-256 header on incoming webhook");
      return false;
    }

    return verifyHmacSha256(rawBody, appSecret, signatureHeader);
  }

  /**
   * Process incoming Meta Webhook payload.
   */
  static async processPayload(payload: WebhookPayload): Promise<void> {
    if (!payload.entry || !Array.isArray(payload.entry)) return;

    for (const entry of payload.entry) {
      if (!entry.changes || !Array.isArray(entry.changes)) continue;

      for (const change of entry.changes) {
        const value = change.value;
        if (!value) continue;

        // 1. Process Status Updates
        if (value.statuses && Array.isArray(value.statuses)) {
          for (const statusObj of value.statuses) {
            await this.handleStatusUpdate(statusObj, value);
          }
        }

        // 2. Process Incoming Messages
        if (value.messages && Array.isArray(value.messages)) {
          for (const messageObj of value.messages) {
            await this.handleIncomingMessage(messageObj, value);
          }
        }
      }
    }
  }

  /**
   * Handle status updates (sent, delivered, read, failed).
   */
  private static async handleStatusUpdate(statusObj: WebhookStatus, value: unknown): Promise<void> {
    const providerMessageId = statusObj.id;
    const statusType = statusObj.status; // 'sent' | 'delivered' | 'read' | 'failed'
    const eventId = `status_${providerMessageId}_${statusType}_${statusObj.timestamp}`;

    // Deduplication check
    const existingEvent = await prisma.messageEvent.findUnique({
      where: { providerEventId: eventId },
    });
    if (existingEvent) {
      logger.info(`Status update event ${eventId} already processed.`);
      return;
    }

    // Record raw event
    const eventRecord = await prisma.messageEvent.create({
      data: {
        providerEventId: eventId,
        providerMessageId,
        eventType: `status.${statusType}`,
        payload: JSON.stringify(value),
        processingStatus: ProcessingStatus.PENDING,
      },
    });

    try {
      const message = await prisma.message.findUnique({
        where: { providerMessageId },
      });

      if (!message) {
        logger.warn(`No message record found for providerMessageId: ${providerMessageId}`);
        await prisma.messageEvent.update({
          where: { id: eventRecord.id },
          data: { processingStatus: ProcessingStatus.PROCESSED, processedAt: new Date() },
        });
        return;
      }

      // Status ordering hierarchy: SENT < DELIVERED < READ. FAILED is terminal.
      const statusHierarchy: Record<MessageStatus, number> = {
        QUEUED: 0,
        SENT: 1,
        RECEIVED: 1,
        DELIVERED: 2,
        READ: 3,
        FAILED: 4,
      };

      const statusMap: Record<string, MessageStatus> = {
        sent: MessageStatus.SENT,
        delivered: MessageStatus.DELIVERED,
        read: MessageStatus.READ,
        failed: MessageStatus.FAILED,
      };

      const newStatus = statusMap[statusType];

      if (newStatus) {
        const currentRank = statusHierarchy[message.status] ?? 0;
        const newRank = statusHierarchy[newStatus] ?? 0;

        // Prevent status downgrade (e.g. READ -> SENT due to out of order webhook)
        const updateData: Record<string, unknown> = {};

        if (newRank > currentRank || message.status !== MessageStatus.READ) {
          updateData.status = newStatus;
        }

        const timestamp = new Date(parseInt(statusObj.timestamp, 10) * 1000 || Date.now());

        if (statusType === "delivered" && !message.deliveredAt) {
          updateData.deliveredAt = timestamp;
        } else if (statusType === "read") {
          updateData.readAt = timestamp;
          if (!message.deliveredAt) updateData.deliveredAt = timestamp;
        } else if (statusType === "failed") {
          updateData.failedAt = timestamp;
          const firstErr = statusObj.errors?.[0];
          if (firstErr) {
            updateData.errorCode = String(firstErr.code);
            updateData.errorMessage = firstErr.message || firstErr.title;
          }
        }

        if (Object.keys(updateData).length > 0) {
          await prisma.message.update({
            where: { id: message.id },
            data: updateData,
          });
        }

        // Trigger outgoing webhooks
        dispatchOutgoingWebhooks(`message.${statusType}`, {
          messageId: message.id,
          providerMessageId,
          to: message.to,
          status: newStatus,
          timestamp: timestamp.toISOString(),
          error: statusObj.errors?.[0],
        }).catch(() => {});
      }

      await prisma.messageEvent.update({
        where: { id: eventRecord.id },
        data: { processingStatus: ProcessingStatus.PROCESSED, processedAt: new Date() },
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Error processing status update";
      logger.error("Failed to process status update:", err);
      await prisma.messageEvent.update({
        where: { id: eventRecord.id },
        data: { processingStatus: ProcessingStatus.FAILED, errorMessage: errorMsg },
      });
    }
  }

  /**
   * Handle incoming inbound messages from Meta WhatsApp webhook.
   */
  private static async handleIncomingMessage(
    messageObj: WebhookIncomingMessage,
    value: unknown
  ): Promise<void> {
    const providerMessageId = messageObj.id;
    const eventId = `inbound_${providerMessageId}`;

    // Deduplication check
    const existingMessage = await prisma.message.findUnique({
      where: { providerMessageId },
    });
    if (existingMessage) {
      logger.info(`Inbound message ${providerMessageId} already exists in database.`);
      return;
    }

    // Record raw event
    const eventRecord = await prisma.messageEvent.create({
      data: {
        providerEventId: eventId,
        providerMessageId,
        eventType: "message.received",
        payload: JSON.stringify(value),
        processingStatus: ProcessingStatus.PENDING,
      },
    });

    try {
      const fromNumber = normalizePhoneNumber(messageObj.from);

      let bodyText: string | null = null;
      let msgTypeEnum: MessageType = MessageType.TEXT;

      if (messageObj.type === "text" && messageObj.text) {
        bodyText = messageObj.text.body;
      } else if (messageObj.type === "image" && messageObj.image) {
        msgTypeEnum = MessageType.IMAGE;
        bodyText = messageObj.image.caption || "[Image Message]";
      } else if (messageObj.type === "document" && messageObj.document) {
        msgTypeEnum = MessageType.DOCUMENT;
        bodyText = messageObj.document.filename || "[Document Message]";
      } else if (messageObj.type === "audio") {
        msgTypeEnum = MessageType.AUDIO;
        bodyText = "[Audio Message]";
      } else if (messageObj.type === "video") {
        msgTypeEnum = MessageType.VIDEO;
        bodyText = "[Video Message]";
      } else {
        bodyText = `[${messageObj.type.toUpperCase()} Message]`;
      }

      const createdMessage = await prisma.message.create({
        data: {
          providerMessageId,
          direction: MessageDirection.INBOUND,
          type: msgTypeEnum,
          status: MessageStatus.RECEIVED,
          from: fromNumber,
          to: "system",
          body: bodyText,
          metadata: JSON.stringify(messageObj),
        },
      });

      await prisma.messageEvent.update({
        where: { id: eventRecord.id },
        data: { processingStatus: ProcessingStatus.PROCESSED, processedAt: new Date() },
      });

      // Dispatch outgoing webhook event for incoming message
      dispatchOutgoingWebhooks("message.received", {
        messageId: createdMessage.id,
        providerMessageId: createdMessage.providerMessageId,
        from: createdMessage.from,
        body: createdMessage.body,
        type: createdMessage.type,
        createdAt: createdMessage.createdAt.toISOString(),
      }).catch(() => {});
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Error processing incoming message";
      logger.error("Failed to process incoming message:", err);
      await prisma.messageEvent.update({
        where: { id: eventRecord.id },
        data: { processingStatus: ProcessingStatus.FAILED, errorMessage: errorMsg },
      });
    }
  }
}
