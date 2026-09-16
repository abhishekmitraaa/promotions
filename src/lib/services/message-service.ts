import { prisma } from "../prisma";
import { normalizePhoneNumber } from "../crypto";
import { sendWhatsAppMessage } from "../whatsapp/client";
import { MetaOutboundPayload, MetaTemplateComponent } from "../whatsapp/types";
import { CreateMessageInput } from "../validation/messages";
import { MessageDirection, MessageStatus, MessageType } from "@prisma/client";
import { WhatsAppApiError } from "../whatsapp/errors";
import { dispatchOutgoingWebhooks } from "../webhooks/dispatcher";

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

export class MessageService {
  /**
   * Dispatch an outbound WhatsApp message (Text or Template) scoped to an ApiClient.
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

    // 2. Create QUEUED Record in DB (Handling concurrent idempotency race conditions)
    let messageRecord;
    try {
      messageRecord = await prisma.message.create({
        data: {
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

    // 3. Construct Meta API Payload
    let metaPayload: MetaOutboundPayload;

    if (typeEnum === MessageType.TEMPLATE) {
      const components = formatTemplateComponents(input.templateParameters);

      metaPayload = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: normalizedTo,
        type: "template",
        template: {
          name: input.templateName!,
          language: {
            code: input.templateLanguage || "en_US",
          },
          ...(components ? { components } : {}),
        },
      };
    } else {
      metaPayload = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: normalizedTo,
        type: "text",
        text: {
          preview_url: false,
          body: input.body!,
        },
      };
    }

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
        },
      });

      // Fire outgoing webhooks asynchronously (scoped to client)
      dispatchOutgoingWebhooks(
        "message.sent",
        {
          messageId: updatedMessage.id,
          providerMessageId: providerId,
          to: updatedMessage.to,
          status: "SENT",
          sentAt: updatedMessage.sentAt,
        },
        clientId
      ).catch(() => {});

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

      const failedRecord = await prisma.message.update({
        where: { id: messageRecord.id },
        data: {
          status: MessageStatus.FAILED,
          errorCode,
          errorMessage,
          failedAt: new Date(),
        },
      });

      dispatchOutgoingWebhooks(
        "message.failed",
        {
          messageId: failedRecord.id,
          to: failedRecord.to,
          status: "FAILED",
          errorCode,
          errorMessage,
        },
        clientId
      ).catch(() => {});

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
   * Query list of messages with filtering, pagination, and tenant isolation.
   */
  static async getMessages(params: {
    clientId?: string;
    direction?: MessageDirection;
    status?: MessageStatus;
    search?: string;
    page?: number;
    limit?: number;
  }) {
    const page = Math.max(1, params.page || 1);
    const limit = Math.min(100, Math.max(1, params.limit || 20));
    const skip = (page - 1) * limit;

    const whereClause: Record<string, unknown> = {};

    if (params.clientId) whereClause.clientId = params.clientId;
    if (params.direction) whereClause.direction = params.direction;
    if (params.status) whereClause.status = params.status;
    if (params.search) {
      whereClause.OR = [
        { to: { contains: params.search } },
        { from: { contains: params.search } },
        { body: { contains: params.search } },
        { providerMessageId: { contains: params.search } },
        { id: { contains: params.search } },
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
   * Group conversations by recipient phone number, scoped to clientId if provided.
   */
  static async getConversations(clientId?: string) {
    const allMessages = await prisma.message.findMany({
      where: clientId ? { clientId } : undefined,
      orderBy: { createdAt: "desc" },
    });

    const conversationMap = new Map<
      string,
      {
        phoneNumber: string;
        latestMessage: (typeof allMessages)[0];
        messageCount: number;
        unreadCount: number;
      }
    >();

    for (const msg of allMessages) {
      const participant =
        msg.direction === MessageDirection.OUTBOUND ? msg.to : msg.from;

      if (!conversationMap.has(participant)) {
        conversationMap.set(participant, {
          phoneNumber: participant,
          latestMessage: msg,
          messageCount: 1,
          unreadCount:
            msg.direction === MessageDirection.INBOUND &&
            msg.status === MessageStatus.RECEIVED
              ? 1
              : 0,
        });
      } else {
        const existing = conversationMap.get(participant)!;
        existing.messageCount += 1;
        if (
          msg.direction === MessageDirection.INBOUND &&
          msg.status === MessageStatus.RECEIVED
        ) {
          existing.unreadCount += 1;
        }
      }
    }

    return Array.from(conversationMap.values());
  }
}
