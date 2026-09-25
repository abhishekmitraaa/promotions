/**
 * Email Event Service & Delivery State Machine
 *
 * Implements the core event processing lifecycle:
 * 1. Webhook and event deduplication (providerEventId uniqueness guarantees idempotency).
 * 2. Monotonic Delivery State Machine (prevents stale/out-of-order events from downgrading state).
 * 3. Bounce classification: HARD_BOUNCE creates suppression; SOFT_BOUNCE does not.
 * 4. Complaint handling: creates suppression and transitions delivery/recipient state.
 * 5. Idempotent campaign metrics calculation (never double-increments on duplicate events).
 * 6. BullMQ asynchronous event queue dispatching.
 */

import { prisma } from "../prisma";
import {
  EmailDeliveryStatus,
  EmailEventType,
  EmailSuppressionReason,
  EmailContactStatus,
} from "@prisma/client";
import { NormalizedEmailWebhookEvent } from "../email/webhooks/types";
import { EmailSuppressionService } from "./email-suppression-service";
import { getEventsQueue } from "../email/queue/queues";
import { JOB_NAMES, getEventJobId, EmailEventJobData } from "../email/queue/types";
import { logger } from "../logger";

// Monotonic precedence levels for delivery status
const STATUS_PRECEDENCE: Record<EmailDeliveryStatus, number> = {
  [EmailDeliveryStatus.QUEUED]: 0,
  [EmailDeliveryStatus.PROCESSING]: 1,
  [EmailDeliveryStatus.SENT]: 2,
  [EmailDeliveryStatus.DELIVERED]: 3,
  [EmailDeliveryStatus.FAILED]: 4,
  [EmailDeliveryStatus.BOUNCED]: 4,
  [EmailDeliveryStatus.COMPLAINED]: 4,
};

export interface ProcessEventResult {
  success: boolean;
  deduplicated?: boolean;
  eventId?: string;
  statusUpdated?: boolean;
  suppressionCreated?: boolean;
  error?: string;
}

export class EmailEventService {
  /**
   * Processes a normalized email event synchronously.
   * Enforces deduplication, state machine progression, campaign metrics, and suppression rules.
   */
  static async processNormalizedEvent(
    event: NormalizedEmailWebhookEvent
  ): Promise<ProcessEventResult> {
    const { providerEventId, recipient, eventType, occurredAt } = event;

    // 1. Deduplication Guard: Check if providerEventId already persisted
    if (providerEventId) {
      const existing = await prisma.emailEvent.findUnique({
        where: { providerEventId },
      });

      if (existing) {
        logger.info(
          `[EventService] Event '${providerEventId}' already processed. Deduplicating.`
        );
        return {
          success: true,
          deduplicated: true,
          eventId: existing.id,
        };
      }
    }

    // 2. Correlate with EmailDelivery
    const delivery = await this.resolveDelivery(event);

    let clientId = delivery?.clientId || event.clientId;
    if (!clientId && event.recipient) {
      const contact = await prisma.emailContact.findFirst({
        where: { normalizedEmail: event.recipient.toLowerCase().trim() },
        select: { clientId: true },
      });
      if (contact) {
        clientId = contact.clientId;
      }
    }

    // 3. Persist EmailEvent
    const payloadStr =
      typeof event.rawPayload === "string"
        ? event.rawPayload
        : JSON.stringify(event.rawPayload);

    const createdEvent = await prisma.emailEvent.create({
      data: {
        clientId,
        deliveryId: delivery?.id,
        providerEventId,
        eventType,
        recipient,
        payload: payloadStr,
        occurredAt,
      },
    });

    let statusUpdated = false;
    let suppressionCreated = false;

    // 4. If delivery was correlated, apply Delivery State Machine & Campaign Metrics
    if (delivery) {
      statusUpdated = await this.applyDeliveryStateMachine(delivery.id, event);
    }

    // 5. Handle Suppression & Contact Policies
    if (clientId) {
      suppressionCreated = await this.applySuppressionPolicies(clientId, event);
    }

    return {
      success: true,
      deduplicated: false,
      eventId: createdEvent.id,
      statusUpdated,
      suppressionCreated,
    };
  }

  /**
   * Dispatches a normalized event to the BullMQ events queue for asynchronous processing,
   * falling back to synchronous execution if BullMQ/Redis is unavailable.
   */
  static async enqueueOrProcess(
    event: NormalizedEmailWebhookEvent
  ): Promise<ProcessEventResult> {
    try {
      const queue = getEventsQueue();
      const jobId = getEventJobId(event.providerEventId);

      const jobData: EmailEventJobData = {
        eventId: event.providerEventId,
        eventType: event.eventType,
        providerType: event.providerType,
        providerMessageId: event.providerMessageId,
      };

      await queue.add(JOB_NAMES.PROCESS_EMAIL_EVENT, jobData, {
        jobId, // Queue-scoped deduplication
      });

      // Still process immediately in the common layer to guarantee immediate state consistency
      return await this.processNormalizedEvent(event);
    } catch {
      // In offline tests or when Redis is not running, process synchronously
      return await this.processNormalizedEvent(event);
    }
  }

  /**
   * Resolves target EmailDelivery from event metadata, deliveryId, or providerMessageId.
   */
  private static async resolveDelivery(event: NormalizedEmailWebhookEvent) {
    if (event.deliveryId) {
      const byId = await prisma.emailDelivery.findUnique({
        where: { id: event.deliveryId },
        include: { campaignRecipient: true },
      });
      if (byId) return byId;
    }

    if (event.providerMessageId) {
      const byProviderId = await prisma.emailDelivery.findFirst({
        where: { providerMessageId: event.providerMessageId },
        include: { campaignRecipient: true },
      });
      if (byProviderId) return byProviderId;
    }

    // Fallback: match by recent delivery to recipient email
    return await prisma.emailDelivery.findFirst({
      where: { to: event.recipient },
      orderBy: { createdAt: "desc" },
      include: { campaignRecipient: true },
    });
  }

  /**
   * Applies the Delivery State Machine to prevent stale events from downgrading state.
   */
  private static async applyDeliveryStateMachine(
    deliveryId: string,
    event: NormalizedEmailWebhookEvent
  ): Promise<boolean> {
    const delivery = await prisma.emailDelivery.findUnique({
      where: { id: deliveryId },
      include: { campaignRecipient: true },
    });

    if (!delivery) return false;

    const currentStatus = delivery.status;
    const targetStatus = this.mapEventToDeliveryStatus(event.eventType);

    if (!targetStatus) {
      return false; // Event does not map to a delivery status change (e.g. UNSUBSCRIBED)
    }

    const currentPrecedence = STATUS_PRECEDENCE[currentStatus];
    const targetPrecedence = STATUS_PRECEDENCE[targetStatus];

    // Stale check: If target status has lower precedence than current status, DO NOT DOWNGRADE
    if (targetPrecedence < currentPrecedence) {
      logger.info(
        `[EventService] Stale event detected for delivery ${deliveryId}: cannot transition ${currentStatus} -> ${targetStatus}`
      );
      return false;
    }

    // If status is unchanged, no state transition needed
    if (currentStatus === targetStatus) {
      return false;
    }

    // Update EmailDelivery
    const updateData: {
      status: EmailDeliveryStatus;
      deliveredAt?: Date;
      failedAt?: Date;
      errorCode?: string;
      errorMessage?: string;
    } = {
      status: targetStatus,
    };

    if (targetStatus === EmailDeliveryStatus.DELIVERED) {
      updateData.deliveredAt = event.occurredAt || new Date();
    } else if (
      targetStatus === EmailDeliveryStatus.BOUNCED ||
      targetStatus === EmailDeliveryStatus.COMPLAINED ||
      targetStatus === EmailDeliveryStatus.FAILED
    ) {
      updateData.failedAt = event.occurredAt || new Date();
      updateData.errorCode = event.bounceType || targetStatus;
      updateData.errorMessage = event.bounceReason || event.complaintFeedback;
    }

    await prisma.emailDelivery.update({
      where: { id: deliveryId },
      data: updateData,
    });

    // Update EmailCampaignRecipient & EmailCampaign metrics
    if (delivery.campaignRecipientId && delivery.campaignRecipient) {
      await this.updateCampaignRecipientAndMetrics(
        delivery.campaignRecipient.campaignId,
        delivery.campaignRecipient.id,
        currentStatus,
        targetStatus
      );
    }

    return true;
  }

  /**
   * Maps an EmailEventType to an EmailDeliveryStatus.
   */
  private static mapEventToDeliveryStatus(
    eventType: EmailEventType
  ): EmailDeliveryStatus | null {
    switch (eventType) {
      case EmailEventType.SENT:
        return EmailDeliveryStatus.SENT;
      case EmailEventType.DELIVERED:
      case EmailEventType.OPENED:
      case EmailEventType.CLICKED:
        // Opening or clicking implies successful delivery
        return EmailDeliveryStatus.DELIVERED;
      case EmailEventType.BOUNCED:
        return EmailDeliveryStatus.BOUNCED;
      case EmailEventType.COMPLAINT:
        return EmailDeliveryStatus.COMPLAINED;
      case EmailEventType.FAILED:
        return EmailDeliveryStatus.FAILED;
      default:
        return null;
    }
  }

  /**
   * Updates campaign metrics and recipient status idempotently.
   */
  private static async updateCampaignRecipientAndMetrics(
    campaignId: string,
    recipientId: string,
    previousStatus: EmailDeliveryStatus,
    newStatus: EmailDeliveryStatus
  ): Promise<void> {
    // 1. Update recipient status
    await prisma.emailCampaignRecipient.update({
      where: { id: recipientId },
      data: { status: newStatus },
    });

    // 2. Increment appropriate counter if moving into a new status category
    const incrementField: Record<string, number> = {};

    if (newStatus === EmailDeliveryStatus.DELIVERED && previousStatus !== EmailDeliveryStatus.DELIVERED) {
      incrementField.deliveredCount = 1;
    } else if (newStatus === EmailDeliveryStatus.BOUNCED && previousStatus !== EmailDeliveryStatus.BOUNCED) {
      incrementField.bouncedCount = 1;
    } else if (newStatus === EmailDeliveryStatus.COMPLAINED && previousStatus !== EmailDeliveryStatus.COMPLAINED) {
      incrementField.complaintCount = 1;
    }

    if (Object.keys(incrementField).length > 0) {
      await prisma.emailCampaign.update({
        where: { id: campaignId },
        data: {
          deliveredCount: incrementField.deliveredCount ? { increment: 1 } : undefined,
          bouncedCount: incrementField.bouncedCount ? { increment: 1 } : undefined,
          complaintCount: incrementField.complaintCount ? { increment: 1 } : undefined,
        },
      });
    }
  }

  /**
   * Applies suppression policies for Hard Bounces, Complaints, and Unsubscribes.
   */
  private static async applySuppressionPolicies(
    clientId: string,
    event: NormalizedEmailWebhookEvent
  ): Promise<boolean> {
    const { recipient, eventType, bounceType, bounceReason, complaintFeedback } = event;

    // A. HARD BOUNCE -> Add to suppression list, update contact
    if (eventType === EmailEventType.BOUNCED && bounceType === "HARD_BOUNCE") {
      await EmailSuppressionService.addSuppression(
        clientId,
        recipient,
        EmailSuppressionReason.HARD_BOUNCE,
        "WEBHOOK_HARD_BOUNCE",
        bounceReason ? { reason: bounceReason } : undefined
      );

      await prisma.emailContact.updateMany({
        where: { clientId, normalizedEmail: recipient.toLowerCase().trim() },
        data: {
          hasMarketingConsent: false,
          status: EmailContactStatus.BOUNCED,
        },
      });
      return true;
    }

    // B. SOFT BOUNCE -> DO NOT permanently suppress without a policy
    if (eventType === EmailEventType.BOUNCED && bounceType === "SOFT_BOUNCE") {
      logger.info(
        `[EventService] Soft bounce recorded for ${recipient}. Skipping permanent suppression.`
      );
      return false;
    }

    // C. COMPLAINT -> Add to suppression list, update contact
    if (eventType === EmailEventType.COMPLAINT) {
      await EmailSuppressionService.addSuppression(
        clientId,
        recipient,
        EmailSuppressionReason.COMPLAINT,
        "WEBHOOK_COMPLAINT",
        complaintFeedback ? { feedback: complaintFeedback } : undefined
      );

      await prisma.emailContact.updateMany({
        where: { clientId, normalizedEmail: recipient.toLowerCase().trim() },
        data: {
          hasMarketingConsent: false,
          status: EmailContactStatus.COMPLAINED,
        },
      });
      return true;
    }

    // D. UNSUBSCRIBE
    if (eventType === EmailEventType.UNSUBSCRIBED) {
      await EmailSuppressionService.addSuppression(
        clientId,
        recipient,
        EmailSuppressionReason.UNSUBSCRIBED,
        "WEBHOOK_UNSUBSCRIBE"
      );

      await prisma.emailContact.updateMany({
        where: { clientId, normalizedEmail: recipient.toLowerCase().trim() },
        data: {
          hasMarketingConsent: false,
          status: EmailContactStatus.UNSUBSCRIBED,
          unsubscribedAt: new Date(),
        },
      });
      return true;
    }

    return false;
  }
}
