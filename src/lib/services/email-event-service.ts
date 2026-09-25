/**
 * Email Event Service & Delivery State Machine
 *
 * Implements the core event processing lifecycle:
 * 1. Webhook and event deduplication (providerEventId uniqueness guarantees idempotency).
 * 2. Unambiguous tenant correlation (via EmailProviderConfig or EmailDelivery; rejects ambiguous events).
 * 3. Durable persistence with explicit processing states: RECEIVED -> PROCESSING -> PROCESSED / FAILED.
 * 4. Asynchronous processing via BullMQ event worker with retry and dead-letter handling.
 * 5. Monotonic Delivery State Machine (prevents stale/out-of-order events from downgrading state).
 * 6. Hard/soft bounce classification and suppression policies.
 * 7. Complaint handling with suppression and non-downgrading delivery state.
 * 8. Idempotent campaign metrics calculation (never double-increments on duplicate events).
 */

import { prisma } from "../prisma";
import {
  EmailDeliveryStatus,
  EmailEventType,
  EmailSuppressionReason,
  EmailContactStatus,
  EmailEventProcessingStatus,
  EmailProviderType,
} from "@prisma/client";
import { NormalizedEmailWebhookEvent } from "../email/webhooks/types";
import { classifyBounce } from "../email/webhooks/normalizer";
import { EmailSuppressionService } from "./email-suppression-service";
import { getEventsQueue } from "../email/queue/queues";
import {
  JOB_NAMES,
  getEventJobId,
  EmailEventJobData,
  RetryableEmailError,
  PermanentEmailError,
  isRetryableError,
} from "../email/queue/types";
import { checkAndCompleteCampaign } from "../email/queue/campaign-worker";
import { logger } from "../logger";

// Monotonic precedence levels for delivery status
export const STATUS_PRECEDENCE: Record<EmailDeliveryStatus, number> = {
  [EmailDeliveryStatus.QUEUED]: 0,
  [EmailDeliveryStatus.PROCESSING]: 1,
  [EmailDeliveryStatus.SENT]: 2,
  [EmailDeliveryStatus.DELIVERED]: 3,
  [EmailDeliveryStatus.FAILED]: 4,
  [EmailDeliveryStatus.BOUNCED]: 4,
  [EmailDeliveryStatus.COMPLAINED]: 4,
};

/**
 * Pure validator function for delivery state machine transitions.
 * Enforces strict monotonicity:
 * - SENT -> DELIVERED: allowed
 * - DELIVERED -> SENT: rejected (stale)
 * - BOUNCED -> DELIVERED: rejected (terminal bounce cannot be overwritten)
 * - FAILED after BOUNCED: rejected (BOUNCED is specific terminal state)
 * - COMPLAINED after DELIVERED: allowed (user marked spam after delivery)
 * - duplicate states: rejected / no-op
 */
export function canTransitionDeliveryStatus(
  current: EmailDeliveryStatus,
  target: EmailDeliveryStatus
): boolean {
  if (current === target) {
    return false; // No-op, not a valid state transition
  }

  // Terminal states cannot be replaced by earlier states
  if (current === EmailDeliveryStatus.DELIVERED) {
    // Once DELIVERED, cannot revert to QUEUED, PROCESSING, SENT
    if (
      target === EmailDeliveryStatus.QUEUED ||
      target === EmailDeliveryStatus.PROCESSING ||
      target === EmailDeliveryStatus.SENT
    ) {
      return false;
    }
    // DELIVERED cannot be replaced by generic FAILED or late BOUNCED
    if (
      target === EmailDeliveryStatus.FAILED ||
      target === EmailDeliveryStatus.BOUNCED
    ) {
      return false;
    }
    // Recipient can COMPLAIN after delivery
    if (target === EmailDeliveryStatus.COMPLAINED) {
      return true;
    }
    return false;
  }

  if (current === EmailDeliveryStatus.BOUNCED) {
    // Terminal BOUNCED cannot be replaced by DELIVERED, SENT, PROCESSING, QUEUED, or FAILED
    return false;
  }

  if (current === EmailDeliveryStatus.FAILED) {
    // Terminal FAILED cannot be replaced by DELIVERED, SENT, PROCESSING, QUEUED, or BOUNCED
    return false;
  }

  if (current === EmailDeliveryStatus.COMPLAINED) {
    // Terminal COMPLAINED cannot be replaced
    return false;
  }

  // From QUEUED, PROCESSING, SENT: can transition forward
  if (current === EmailDeliveryStatus.SENT) {
    if (
      target === EmailDeliveryStatus.DELIVERED ||
      target === EmailDeliveryStatus.BOUNCED ||
      target === EmailDeliveryStatus.FAILED ||
      target === EmailDeliveryStatus.COMPLAINED
    ) {
      return true;
    }
    return false; // cannot revert to QUEUED or PROCESSING
  }

  if (current === EmailDeliveryStatus.PROCESSING) {
    if (
      target === EmailDeliveryStatus.SENT ||
      target === EmailDeliveryStatus.DELIVERED ||
      target === EmailDeliveryStatus.BOUNCED ||
      target === EmailDeliveryStatus.FAILED ||
      target === EmailDeliveryStatus.COMPLAINED
    ) {
      return true;
    }
    return false;
  }

  if (current === EmailDeliveryStatus.QUEUED) {
    return true;
  }

  return false;
}

export interface RecordEventResult {
  success: boolean;
  deduplicated?: boolean;
  eventId?: string;
  status: EmailEventProcessingStatus;
  error?: string;
}

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
   * Step 1 in Target Flow:
   * Persists an authoritative EmailEvent record with status RECEIVED and enqueues a processing job.
   *
   * SECURE TENANT BINDING:
   * Unambiguously binds event to a tenant via:
   * - providerConfig (from validated configId or headers)
   * - event.clientId (if explicit)
   * - correlated EmailDelivery (via providerMessageId or deliveryId)
   * NEVER infers tenant ownership from recipient email address alone.
   * Rejects ambiguous events.
   */
  static async recordAndEnqueueEvent(
    event: NormalizedEmailWebhookEvent,
    providerConfig?: { id: string; clientId: string } | null,
    options?: { syncFallback?: boolean }
  ): Promise<RecordEventResult> {
    const { providerEventId, recipient, eventType, occurredAt } = event;

    // 1. Unambiguous Tenant Correlation
    // Tenant ownership MUST be established authoritatively before processing or resolving deliveries.
    // Recipient-only inference is forbidden!
    let clientId: string | null = null;
    const providerConfigId: string | null = providerConfig?.id || null;

    if (providerConfig?.clientId) {
      clientId = providerConfig.clientId;
    } else if (event.clientId) {
      clientId = event.clientId;
    }

    if (!clientId) {
      const errMsg = `AMBIGUOUS_TENANT_BINDING: Webhook event '${providerEventId || "unknown"}' cannot be correlated with a tenant or provider configuration. Recipient-only inference is forbidden.`;
      logger.warn(`[EventService] ${errMsg}`);
      throw new Error(errMsg);
    }

    // 2. Provider-Scoped Deduplication Guard
    // Evaluates event uniqueness within the specific provider configuration or tenant scope,
    // ensuring the same event ID from two different providers or tenants never collides.
    if (providerEventId) {
      const existing = providerConfigId
        ? await prisma.emailEvent.findFirst({
            where: {
              providerConfigId,
              providerEventId,
            },
          })
        : await prisma.emailEvent.findFirst({
            where: {
              clientId,
              providerEventId,
            },
          });

      if (existing) {
        logger.info(
          `[EventService] Event '${providerEventId}' already persisted for providerConfig ${providerConfigId || "none"} (id: ${existing.id}, status: ${existing.status}). Deduplicating.`
        );
        return {
          success: true,
          deduplicated: true,
          eventId: existing.id,
          status: existing.status,
        };
      }
    }

    // 3. Resolve target EmailDelivery strictly scoped to this tenant
    const delivery = await this.resolveDelivery(event, clientId);

    // 4. Persist Authoritative EmailEvent in DB with RECEIVED status
    let payloadObject: Record<string, unknown> = {};
    if (typeof event.rawPayload === "object" && event.rawPayload !== null) {
      payloadObject = { ...event.rawPayload };
    } else if (typeof event.rawPayload === "string") {
      try {
        payloadObject = JSON.parse(event.rawPayload);
      } catch {
        payloadObject = { raw: event.rawPayload };
      }
    }

    payloadObject._normalized = {
      bounceType: event.bounceType,
      bounceReason: event.bounceReason,
      complaintFeedback: event.complaintFeedback,
      providerType: event.providerType,
      providerMessageId: event.providerMessageId,
      deliveryId: event.deliveryId,
    };

    const payloadStr = JSON.stringify(payloadObject);

    let createdEvent: { id: string; status: EmailEventProcessingStatus };
    try {
      createdEvent = await prisma.emailEvent.create({
        data: {
          clientId,
          deliveryId: delivery?.id || (event.deliveryId && delivery ? event.deliveryId : null),
          providerConfigId,
          providerEventId,
          eventType,
          status: EmailEventProcessingStatus.RECEIVED,
          recipient,
          payload: payloadStr,
          occurredAt: occurredAt || new Date(),
          attempts: 0,
        },
      });
    } catch (createErr: unknown) {
      // Handle race condition on compound unique constraint [providerConfigId, providerEventId]
      if (
        createErr &&
        typeof createErr === "object" &&
        "code" in createErr &&
        createErr.code === "P2002" &&
        providerEventId
      ) {
        const existing = await prisma.emailEvent.findFirst({
          where: {
            providerConfigId: providerConfigId || undefined,
            clientId,
            providerEventId,
          },
        });
        if (existing) {
          logger.info(
            `[EventService] Concurrent insert deduplicated for event '${providerEventId}' (id: ${existing.id})`
          );
          return {
            success: true,
            deduplicated: true,
            eventId: existing.id,
            status: existing.status,
          };
        }
      }
      throw createErr;
    }

    logger.info(
      `[EventService] Persisted authoritative EmailEvent ${createdEvent.id} (${eventType}) for tenant ${clientId}`
    );

    // 5. Enqueue BullMQ event-processing job
    try {
      const queue = getEventsQueue();
      const jobId = getEventJobId(createdEvent.id);

      const jobData: EmailEventJobData = {
        eventRecordId: createdEvent.id,
        eventId: createdEvent.id,
        providerEventId,
        clientId,
        eventType,
        providerType: event.providerType,
        providerMessageId: event.providerMessageId,
        deliveryId: delivery?.id,
      };

      await queue.add(JOB_NAMES.PROCESS_EMAIL_EVENT, jobData, {
        jobId, // Queue-scoped deduplication on DB event record ID
        attempts: 5,
        backoff: {
          type: "exponential",
          delay: 1000,
        },
      });
    } catch (queueErr) {
      logger.warn(
        `[EventService] Failed to enqueue event job for ${createdEvent.id}: ${queueErr instanceof Error ? queueErr.message : String(queueErr)}`
      );

      // In offline tests without Redis, optionally process synchronously if requested
      if (options?.syncFallback) {
        logger.info(`[EventService] Processing event synchronously via fallback`);
        await this.processEventFromWorker(createdEvent.id);
      }
    }

    return {
      success: true,
      deduplicated: false,
      eventId: createdEvent.id,
      status: EmailEventProcessingStatus.RECEIVED,
    };
  }

  /**
   * Step 2 in Target Flow:
   * Worker loads event from DB, correlates delivery, applies strengthened state machine,
   * updates campaign metrics idempotently, applies suppression policies, and transitions event to PROCESSED.
   */
  static async processEventFromWorker(
    eventRecordId: string
  ): Promise<ProcessEventResult> {
    if (!eventRecordId) {
      throw new PermanentEmailError("eventRecordId is required");
    }

    // 1. Load authoritative EmailEvent from DB
    const eventRecord = await prisma.emailEvent.findUnique({
      where: { id: eventRecordId },
    });

    if (!eventRecord) {
      throw new PermanentEmailError(
        `EmailEvent record not found in database: ${eventRecordId}`
      );
    }

    // Idempotency: If already PROCESSED, return successfully without re-executing side effects
    if (eventRecord.status === EmailEventProcessingStatus.PROCESSED) {
      logger.info(
        `[EventService] EmailEvent ${eventRecordId} is already PROCESSED. Idempotent skip.`
      );
      return {
        success: true,
        deduplicated: true,
        eventId: eventRecord.id,
      };
    }

    // If terminal FAILED and not being re-driven, skip
    if (eventRecord.status === EmailEventProcessingStatus.FAILED && eventRecord.attempts >= 5) {
      logger.info(
        `[EventService] EmailEvent ${eventRecordId} is terminally FAILED.`
      );
      return {
        success: false,
        eventId: eventRecord.id,
        error: eventRecord.errorMessage || "Terminally failed event",
      };
    }

    // 2. Atomic Transition: RECEIVED -> PROCESSING
    await prisma.emailEvent.update({
      where: { id: eventRecordId },
      data: {
        status: EmailEventProcessingStatus.PROCESSING,
        attempts: { increment: 1 },
        lastAttemptAt: new Date(),
      },
    });

    try {
      // 3. Parse raw payload to extract bounce/complaint metadata
      let parsedPayload: Record<string, unknown> = {};
      try {
        parsedPayload =
          typeof eventRecord.payload === "string"
            ? JSON.parse(eventRecord.payload)
            : (eventRecord.payload as Record<string, unknown>);
      } catch {
        parsedPayload = {};
      }

      // Reconstruct normalized details from authoritative DB record & payload
      const normalizedMeta =
        (parsedPayload._normalized as Record<string, unknown>) || {};
      const bounceObj = (parsedPayload.bounce as Record<string, unknown>) || {};
      const complaintObj =
        (parsedPayload.complaint as Record<string, unknown>) || {};

      let bounceType: "HARD_BOUNCE" | "SOFT_BOUNCE" | undefined =
        (normalizedMeta.bounceType as "HARD_BOUNCE" | "SOFT_BOUNCE" | undefined) ||
        (parsedPayload.bounceType as "HARD_BOUNCE" | "SOFT_BOUNCE" | undefined);

      let bounceReason =
        (normalizedMeta.bounceReason as string) ||
        (parsedPayload.bounceReason as string) ||
        (bounceObj.description as string) ||
        (bounceObj.reason as string) ||
        undefined;

      if (!bounceType && eventRecord.eventType === EmailEventType.BOUNCED) {
        const classified = classifyBounce(
          (normalizedMeta.providerType as string) || (parsedPayload.providerType as string) || "MOCK",
          bounceObj.code ? String(bounceObj.code) : undefined,
          bounceObj.type ? String(bounceObj.type) : undefined,
          bounceObj.description ? String(bounceObj.description) : undefined
        );
        bounceType = classified.type;
        if (!bounceReason) bounceReason = classified.reason;
      }

      const complaintFeedback =
        (normalizedMeta.complaintFeedback as string) ||
        (parsedPayload.complaintFeedback as string) ||
        (complaintObj.feedbackType as string) ||
        undefined;

      const normalizedEvent: NormalizedEmailWebhookEvent = {
        providerType: (parsedPayload.providerType as EmailProviderType) || EmailProviderType.MOCK,
        clientId: eventRecord.clientId || undefined,
        providerEventId: eventRecord.providerEventId || eventRecord.id,
        providerMessageId: (parsedPayload.providerMessageId as string) || undefined,
        deliveryId: eventRecord.deliveryId || undefined,
        eventType: eventRecord.eventType,
        recipient: eventRecord.recipient,
        occurredAt: eventRecord.occurredAt,
        bounceType,
        bounceReason,
        complaintFeedback,
        rawPayload: parsedPayload,
      };

      // 4. Correlate target EmailDelivery strictly scoped to tenant
      let delivery = await this.resolveDelivery(
        normalizedEvent,
        eventRecord.clientId || undefined
      );
      if (!delivery && eventRecord.deliveryId && eventRecord.clientId) {
        delivery = await prisma.emailDelivery.findFirst({
          where: { id: eventRecord.deliveryId, clientId: eventRecord.clientId },
          include: { campaignRecipient: true },
        });
      }

      let statusUpdated = false;
      let suppressionCreated = false;

      // 5. Apply Strengthened Delivery State Machine & Campaign Metrics
      if (delivery) {
        statusUpdated = await this.applyDeliveryStateMachine(
          delivery.id,
          normalizedEvent
        );
      }

      // 6. Handle Suppression & Contact Policies
      if (eventRecord.clientId) {
        suppressionCreated = await this.applySuppressionPolicies(
          eventRecord.clientId,
          normalizedEvent
        );
      }

      // 7. Transition: PROCESSING -> PROCESSED
      await prisma.emailEvent.update({
        where: { id: eventRecordId },
        data: {
          status: EmailEventProcessingStatus.PROCESSED,
          processedAt: new Date(),
          deliveryId: delivery?.id || eventRecord.deliveryId || null,
          errorMessage: null,
          errorCode: null,
        },
      });

      logger.info(
        `[EventService] Event ${eventRecordId} successfully processed (statusUpdated: ${statusUpdated}, suppressionCreated: ${suppressionCreated})`
      );

      return {
        success: true,
        deduplicated: false,
        eventId: eventRecord.id,
        statusUpdated,
        suppressionCreated,
      };
    } catch (procErr) {
      const msg = procErr instanceof Error ? procErr.message : String(procErr);
      const isRetryable = isRetryableError(procErr);

      if (isRetryable) {
        logger.warn(
          `[EventService] Retryable error processing event ${eventRecordId}: ${msg}`
        );
        throw new RetryableEmailError(msg);
      }

      // Permanent failure: transition to FAILED state
      logger.error(
        `[EventService] Permanent failure processing event ${eventRecordId}:`,
        procErr
      );

      await prisma.emailEvent.update({
        where: { id: eventRecordId },
        data: {
          status: EmailEventProcessingStatus.FAILED,
          errorMessage: msg,
          errorCode: "PERMANENT_FAILURE",
        },
      });

      throw new PermanentEmailError(msg);
    }
  }

  /**
   * Resolves target EmailDelivery from event metadata, deliveryId, or providerMessageId.
   * Strictly scopes the search to the authenticated tenant (clientId).
   * Cross-tenant or recipient-only inference is forbidden.
   */
  private static async resolveDelivery(
    event: NormalizedEmailWebhookEvent,
    tenantId?: string
  ) {
    const clientId = tenantId || event.clientId;
    if (!clientId) {
      // Never correlate deliveries across all tenants if tenant is unknown
      return null;
    }

    if (event.deliveryId) {
      const byId = await prisma.emailDelivery.findFirst({
        where: { id: event.deliveryId, clientId },
        include: { campaignRecipient: true },
      });
      if (byId) return byId;
    }

    if (event.providerMessageId) {
      const byProviderId = await prisma.emailDelivery.findFirst({
        where: { providerMessageId: event.providerMessageId, clientId },
        include: { campaignRecipient: true },
      });
      if (byProviderId) return byProviderId;
    }

    // Never match delivery solely based on recipient email address!
    return null;
  }

  /**
   * Applies the Strengthened Delivery State Machine.
   * Enforces strict monotonicity and prevents duplicate metrics increments.
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

    // 1. Check state machine validity
    const allowed = canTransitionDeliveryStatus(currentStatus, targetStatus);
    if (!allowed) {
      logger.info(
        `[EventService] State machine rejected transition for delivery ${deliveryId}: ${currentStatus} -> ${targetStatus}`
      );

      // Handle COMPLAINT metric when delivery was already terminal
      if (
        event.eventType === EmailEventType.COMPLAINT &&
        delivery.campaignRecipientId &&
        delivery.campaignRecipient &&
        delivery.campaignRecipient.status !== EmailDeliveryStatus.COMPLAINED
      ) {
        await this.recordCampaignComplaintOnly(
          delivery.campaignRecipient.campaignId,
          delivery.campaignRecipient.id
        );
      }

      return false;
    }

    // 2. Prepare update payload
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

    // 3. Update EmailCampaignRecipient & EmailCampaign metrics idempotently
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
   * Increments metrics ONLY if moving into a new status category.
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

    if (
      newStatus === EmailDeliveryStatus.DELIVERED &&
      previousStatus !== EmailDeliveryStatus.DELIVERED
    ) {
      incrementField.deliveredCount = 1;
    } else if (
      newStatus === EmailDeliveryStatus.BOUNCED &&
      previousStatus !== EmailDeliveryStatus.BOUNCED
    ) {
      incrementField.bouncedCount = 1;
    } else if (
      newStatus === EmailDeliveryStatus.COMPLAINED &&
      previousStatus !== EmailDeliveryStatus.COMPLAINED
    ) {
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

    // Check if campaign reached terminal completion
    await checkAndCompleteCampaign(campaignId);
  }

  /**
   * Records a complaint for campaign metrics even if delivery was already terminal.
   * Ensures idempotency: will never double-increment complaintCount on duplicate complaint events.
   */
  private static async recordCampaignComplaintOnly(
    campaignId: string,
    recipientId: string
  ): Promise<void> {
    const recipient = await prisma.emailCampaignRecipient.findUnique({
      where: { id: recipientId },
    });
    if (recipient?.status === EmailDeliveryStatus.COMPLAINED) {
      // Monotonic idempotency: already marked as complaint and counted
      return;
    }

    await prisma.emailCampaignRecipient.update({
      where: { id: recipientId },
      data: { status: EmailDeliveryStatus.COMPLAINED },
    });

    await prisma.emailCampaign.update({
      where: { id: campaignId },
      data: {
        complaintCount: { increment: 1 },
      },
    });

    await checkAndCompleteCampaign(campaignId);
  }

  /**
   * Applies suppression policies for Hard Bounces, Complaints, and Unsubscribes.
   * Soft Bounces are logged but do NOT create permanent suppression.
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

    // B. SOFT BOUNCE -> DO NOT permanently suppress
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

  /**
   * Backwards-compatible synchronous method:
   * Records event and processes it directly (used in tests or offline scripts).
   */
  static async processNormalizedEvent(
    event: NormalizedEmailWebhookEvent,
    providerConfig?: { id: string; clientId: string } | null
  ): Promise<ProcessEventResult> {
    const recordResult = await this.recordAndEnqueueEvent(event, providerConfig, {
      syncFallback: true,
    });

    if (recordResult.deduplicated) {
      return {
        success: true,
        deduplicated: true,
        eventId: recordResult.eventId,
      };
    }

    if (!recordResult.eventId) {
      throw new Error("Failed to record event");
    }

    return await this.processEventFromWorker(recordResult.eventId);
  }

  /**
   * Backwards-compatible queue method:
   * Records and enqueues event to BullMQ.
   */
  static async enqueueOrProcess(
    event: NormalizedEmailWebhookEvent,
    providerConfig?: { id: string; clientId: string } | null
  ): Promise<ProcessEventResult> {
    const res = await this.recordAndEnqueueEvent(event, providerConfig);
    return {
      success: res.success,
      deduplicated: res.deduplicated,
      eventId: res.eventId,
    };
  }
}
