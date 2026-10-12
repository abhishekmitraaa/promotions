import { prisma } from "../prisma";
import { normalizePhoneNumber } from "../crypto";
import { sendWhatsAppMessage } from "../whatsapp/client";
import { MetaOutboundPayload, MetaTemplateComponent } from "../whatsapp/types";
import { CreateMessageInput } from "../validation/messages";
import { BackgroundJobStatus, Message, MessageDirection, MessageStatus, MessageType, Prisma } from "@prisma/client";
import { WhatsAppApiError } from "../whatsapp/errors";
import { dispatchOutgoingWebhooks } from "../webhooks/dispatcher";
import { logger } from "../logger";
import { newClaimToken, sendInFlightToken } from "./executors/claim-lock";

/** Total send attempts per outbound WhatsApp message (first attempt + automatic retries). */
export const WHATSAPP_MAX_SEND_ATTEMPTS = 5;

/** Delay before the first automatic retry; later retries back off in the job processor. */
const WHATSAPP_FIRST_RETRY_DELAY_MS = 30 * 1000;

export const WHATSAPP_MESSAGE_JOB_TYPE = "WHATSAPP_MESSAGE";

export interface SendMessageOptions {
  idempotencyKey?: string;
  clientId: string;
}

export interface SendMessageResult {
  id: string;
  providerMessageId?: string | null;
  status: MessageStatus;
  to: string;
  type: MessageType;
  sentAt?: Date | null;
  error?: {
    code?: string | null;
    message?: string | null;
  };
  errorCode?: string;
  errorMessage?: string;
  /** True when a transient provider failure left the message QUEUED with an automatic retry scheduled. */
  retryScheduled?: boolean;
}

export function formatTemplateComponents(
  rawParameters?: unknown[] | null
): MetaTemplateComponent[] | undefined {
  if (!rawParameters || rawParameters.length === 0) return undefined;

  // Simple string array format: ["a", "b"] -> { type: "body", parameters: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }
  if (typeof rawParameters[0] === "string") {
    return [
      {
        type: "body",
        parameters: (rawParameters as string[]).map((text) => ({
          type: "text",
          text: String(text),
        })),
      },
    ];
  }

  // Already Meta-shaped components (e.g. [{ type: "body", parameters: [...] }])
  return rawParameters as MetaTemplateComponent[];
}

/**
 * Builds the Meta Cloud API payload from a persisted outbound message (used by the first
 * attempt and by retries, so both send exactly what was stored).
 */
export function buildMetaPayload(
  message: Pick<Message, "type" | "to" | "body" | "templateName" | "templateLanguage" | "templateParameters">
): MetaOutboundPayload {
  if (message.type === MessageType.TEMPLATE) {
    let rawParameters: unknown[] | null = null;
    if (message.templateParameters) {
      try {
        rawParameters = JSON.parse(message.templateParameters) as unknown[];
      } catch {
        rawParameters = null;
      }
    }
    const components = formatTemplateComponents(rawParameters);
    return {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: message.to,
      type: "template",
      template: {
        name: message.templateName!,
        language: { code: message.templateLanguage || "en_US" },
        ...(components ? { components } : {}),
      },
    };
  }

  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: message.to,
    type: "text",
    text: { preview_url: false, body: message.body! },
  };
}

export class MessageService {
  /**
   * Dispatch an outbound WhatsApp message (Text or Template) scoped to an ApiClient.
   * A transient provider failure leaves the message QUEUED and schedules an automatic retry.
   */
  static async send(
    input: CreateMessageInput,
    options: SendMessageOptions
  ): Promise<SendMessageResult> {
    const clientId = options.clientId;
    if (!clientId) {
      throw new Error("clientId is required to dispatch an outbound message");
    }

    const normalizedTo = normalizePhoneNumber(input.to);
    const typeEnum = input.type.toUpperCase() as MessageType;
    const idempotencyKey = options?.idempotencyKey?.trim() || null;

    // 1. Idempotency Check (Scoped to ApiClient)
    if (idempotencyKey) {
      const existing = await prisma.message.findFirst({
        where: { clientId, idempotencyKey },
      });

      if (existing) {
        return {
          id: existing.id,
          providerMessageId: existing.providerMessageId,
          status: existing.status,
          to: existing.to,
          type: existing.type,
          sentAt: existing.sentAt,
        };
      }
    }

    // 2. Create QUEUED Record in DB (Handling concurrent idempotency race conditions).
    //    The row carries an in-flight marker for the first attempt: if this invocation dies
    //    mid-send, reconciliation flags the message instead of anything re-sending it.
    const inFlightToken = sendInFlightToken(newClaimToken("wa-sync"));
    let messageRecord;
    try {
      messageRecord = await prisma.message.create({
        data: {
          attemptCount: 1,
          lockedBy: inFlightToken,
          lockedAt: new Date(),
          clientId,
          direction: MessageDirection.OUTBOUND,
          type: typeEnum,
          status: MessageStatus.QUEUED,
          from: "system",
          to: normalizedTo,
          body: input.body,
          templateName: input.templateName,
          templateLanguage: input.templateLanguage,
          templateParameters: input.templateParameters
            ? JSON.stringify(input.templateParameters)
            : null,
          metadata: input.metadata ? JSON.stringify(input.metadata) : null,
          idempotencyKey,
        },
      });
    } catch (createErr: unknown) {
      // Safe handling of concurrent duplicate request race on (clientId, idempotencyKey)
      if (
        typeof createErr === "object" &&
        createErr !== null &&
        "code" in createErr &&
        (createErr as { code: string }).code === "P2002" &&
        idempotencyKey
      ) {
        const raceWinner = await prisma.message.findFirst({
          where: { clientId, idempotencyKey },
        });
        if (raceWinner) {
          return {
            id: raceWinner.id,
            providerMessageId: raceWinner.providerMessageId,
            status: raceWinner.status,
            to: raceWinner.to,
            type: raceWinner.type,
            sentAt: raceWinner.sentAt,
          };
        }
      }
      throw createErr;
    }

    // 3. Construct Meta API Payload from the persisted record
    const metaPayload = buildMetaPayload(messageRecord);

    // 4. Dispatch to Meta WhatsApp Cloud API
    try {
      const metaResult = await sendWhatsAppMessage(metaPayload);
      const providerId = metaResult.messages?.[0]?.id || null;

      const updatedMessage = await prisma.message.update({
        where: { id: messageRecord.id },
        data: {
          providerMessageId: providerId,
          status: MessageStatus.SENT,
          sentAt: new Date(),
          lockedAt: null,
          lockedBy: null,
        },
      });

      // Fire outgoing webhooks asynchronously (scoped to client)
      await dispatchOutgoingWebhooks(
        "message.sent",
        {
          messageId: updatedMessage.id,
          providerMessageId: providerId,
          to: updatedMessage.to,
          status: "SENT",
          sentAt: updatedMessage.sentAt,
        },
        clientId
      );

      return {
        id: updatedMessage.id,
        providerMessageId: providerId,
        status: MessageStatus.SENT,
        to: updatedMessage.to,
        type: updatedMessage.type,
        sentAt: updatedMessage.sentAt,
      };
    } catch (err) {
      const errorCode =
        err instanceof WhatsAppApiError
          ? String(err.errorCode || err.statusCode)
          : "SEND_FAILED";
      const errorMessage =
        err instanceof Error
          ? err.message
          : "Failed to send message via Meta WhatsApp API";

      // Transient provider failure: keep the message QUEUED and hand it to the job processor
      if (err instanceof WhatsAppApiError && err.isTransient) {
        try {
          await prisma.$transaction([
            prisma.message.update({
              where: { id: messageRecord.id },
              data: { errorCode, errorMessage, lockedAt: null, lockedBy: null },
            }),
            prisma.backgroundJob.create({
              data: {
                clientId,
                type: WHATSAPP_MESSAGE_JOB_TYPE,
                status: BackgroundJobStatus.QUEUED,
                payload: JSON.stringify({ messageId: messageRecord.id, clientId }),
                availableAt: new Date(Date.now() + WHATSAPP_FIRST_RETRY_DELAY_MS),
                scheduledAt: new Date(Date.now() + WHATSAPP_FIRST_RETRY_DELAY_MS),
                maxAttempts: WHATSAPP_MAX_SEND_ATTEMPTS,
                deduplicationKey: `whatsapp-message-${messageRecord.id}`,
              },
            }),
          ]);
          logger.warn(
            `[MessageService] Transient WhatsApp failure for message ${messageRecord.id} (${errorCode}). Retry scheduled.`
          );
          return {
            id: messageRecord.id,
            providerMessageId: null,
            status: MessageStatus.QUEUED,
            to: messageRecord.to,
            type: messageRecord.type,
            retryScheduled: true,
            error: { code: errorCode, message: errorMessage },
            errorCode,
            errorMessage,
          };
        } catch (scheduleErr) {
          // Could not persist the retry: fall through and report an honest failure
          logger.error(`[MessageService] Could not schedule retry for message ${messageRecord.id}:`, scheduleErr);
        }
      }

      const failedRecord = await prisma.message.update({
        where: { id: messageRecord.id },
        data: {
          status: MessageStatus.FAILED,
          errorCode,
          errorMessage,
          failedAt: new Date(),
          lockedAt: null,
          lockedBy: null,
        },
      });

      await dispatchOutgoingWebhooks(
        "message.failed",
        {
          messageId: failedRecord.id,
          to: failedRecord.to,
          status: "FAILED",
          errorCode,
          errorMessage,
        },
        clientId
      );

      return {
        id: failedRecord.id,
        providerMessageId: null,
        status: MessageStatus.FAILED,
        to: failedRecord.to,
        type: failedRecord.type,
        error: {
          code: errorCode,
          message: errorMessage,
        },
      };
    }
  }

  /**
   * Retrieve message by internal ID or providerMessageId, scoped to clientId if provided.
   */
  static async getById(id: string, clientId?: string) {
    const orConditions = [{ id }, { providerMessageId: id }];

    if (clientId) {
      return prisma.message.findFirst({
        where: {
          clientId,
          OR: orConditions,
        },
      });
    }

    return prisma.message.findFirst({
      where: {
        OR: orConditions,
      },
    });
  }

  /**
   * List messages with pagination, optionally filtered by status, direction, and clientId.
   */
  static async getMessages(options: {
    page?: number;
    limit?: number;
    status?: MessageStatus;
    direction?: MessageDirection;
    clientId?: string;
    search?: string;
  }) {
    const page = Math.max(1, options.page || 1);
    const limit = Math.min(Math.max(1, options.limit || 20), 100);
    const skip = (page - 1) * limit;

    const whereClause: Record<string, unknown> = {};

    if (options.status) whereClause.status = options.status;
    if (options.direction) whereClause.direction = options.direction;
    if (options.clientId) whereClause.clientId = options.clientId;
    if (options.search) {
      whereClause.OR = [
        { to: { contains: options.search } },
        { from: { contains: options.search } },
        { body: { contains: options.search } },
        { providerMessageId: { contains: options.search } },
        { id: { contains: options.search } },
      ];
    }

    const [messages, total] = await Promise.all([
      prisma.message.findMany({
        where: whereClause,
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
      }),
      prisma.message.count({ where: whereClause }),
    ]);

    return {
      messages,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Group conversations by participant phone number using scalable PostgreSQL window aggregation.
   * Parameterized via Prisma.sql to eliminate injection vulnerabilities and full-table scans.
   */
  static async getConversations(
    clientId?: string,
    options?: { page?: number; limit?: number }
  ) {
    const page = Math.max(1, options?.page || 1);
    const limit = Math.min(Math.max(1, options?.limit || 50), 200);
    const offset = (page - 1) * limit;

    const whereFilter = clientId
      ? Prisma.sql`WHERE "clientId" = ${clientId}`
      : Prisma.empty;

    const rows = await prisma.$queryRaw<
      {
        phoneNumber: string;
        latestMessage: unknown;
        messageCount: bigint | number;
        unreadCount: bigint | number;
      }[]
    >`
      WITH participants AS (
        SELECT 
          CASE WHEN direction = 'OUTBOUND' THEN "to" ELSE "from" END AS participant,
          id,
          "clientId",
          "providerMessageId",
          direction,
          type,
          status,
          "from",
          "to",
          body,
          "templateName",
          "templateLanguage",
          "templateParameters",
          "mediaId",
          "mediaUrl",
          "errorCode",
          "errorMessage",
          metadata,
          "idempotencyKey",
          "sentAt",
          "deliveredAt",
          "readAt",
          "failedAt",
          "createdAt",
          "updatedAt",
          ROW_NUMBER() OVER (
            PARTITION BY CASE WHEN direction = 'OUTBOUND' THEN "to" ELSE "from" END
            ORDER BY "createdAt" DESC, id DESC
          ) as rn,
          COUNT(*) OVER (
            PARTITION BY CASE WHEN direction = 'OUTBOUND' THEN "to" ELSE "from" END
          ) as message_count,
          COUNT(CASE WHEN direction = 'INBOUND' AND status = 'RECEIVED' THEN 1 END) OVER (
            PARTITION BY CASE WHEN direction = 'OUTBOUND' THEN "to" ELSE "from" END
          ) as unread_count
        FROM "Message"
        ${whereFilter}
      )
      SELECT 
        participant AS "phoneNumber",
        json_build_object(
          'id', id,
          'clientId', "clientId",
          'providerMessageId', "providerMessageId",
          'direction', direction,
          'type', type,
          'status', status,
          'from', "from",
          'to', "to",
          'body', body,
          'templateName', "templateName",
          'templateLanguage', "templateLanguage",
          'templateParameters', "templateParameters",
          'mediaId', "mediaId",
          'mediaUrl', "mediaUrl",
          'errorCode', "errorCode",
          'errorMessage', "errorMessage",
          'metadata', metadata,
          'idempotencyKey', "idempotencyKey",
          'sentAt', "sentAt",
          'deliveredAt', "deliveredAt",
          'readAt', "readAt",
          'failedAt', "failedAt",
          'createdAt', "createdAt",
          'updatedAt', "updatedAt"
        ) AS "latestMessage",
        message_count AS "messageCount",
        unread_count AS "unreadCount"
      FROM participants
      WHERE rn = 1
      ORDER BY "createdAt" DESC
      LIMIT ${limit} OFFSET ${offset};
    `;

    return rows.map((r) => ({
      phoneNumber: r.phoneNumber,
      latestMessage: r.latestMessage,
      messageCount: Number(r.messageCount),
      unreadCount: Number(r.unreadCount),
    }));
  }
}
