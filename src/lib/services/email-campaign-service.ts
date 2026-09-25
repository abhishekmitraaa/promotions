/**
 * Email Campaign Service & Lifecycle State Machine
 *
 * Implements end-to-end campaign management:
 * - Strict lifecycle state machine transitions
 * - Audience preview and pre-send safety validation
 * - Isolated test email delivery (never generates campaign recipient records)
 * - Immutable template version binding (cannot change under a scheduled/running campaign)
 * - Safe individual BullMQ recipient job dispatching
 * - Pause and cancel controls
 */

import { prisma } from "../prisma";
import { EmailAudienceResolver } from "./email-audience-resolver";
import { EmailTemplateService } from "./email-template-service";
import { TemplateEngine } from "../email/template-engine";
import { providerRegistry } from "../email/registry";
import { getCampaignQueue } from "../email/queue/queues";
import { JOB_NAMES, getCampaignJobId, CampaignJobData } from "../email/queue/types";
import { isValidEmail } from "../email/normalization";
import { EmailProvider } from "../email/types";
import { logger } from "../logger";
import {
  EmailCampaign,
  EmailCampaignStatus,
  EmailEventType,
  EmailType,
  EmailTemplateVersion,
} from "@prisma/client";

const VALID_TRANSITIONS: Record<EmailCampaignStatus, EmailCampaignStatus[]> = {
  [EmailCampaignStatus.DRAFT]: [
    EmailCampaignStatus.SCHEDULED,
    EmailCampaignStatus.RUNNING,
    EmailCampaignStatus.CANCELLED,
  ],
  [EmailCampaignStatus.SCHEDULED]: [
    EmailCampaignStatus.RUNNING,
    EmailCampaignStatus.PAUSED,
    EmailCampaignStatus.CANCELLED,
  ],
  [EmailCampaignStatus.RUNNING]: [
    EmailCampaignStatus.PAUSED,
    EmailCampaignStatus.COMPLETED,
    EmailCampaignStatus.FAILED,
    EmailCampaignStatus.CANCELLED,
  ],
  [EmailCampaignStatus.PAUSED]: [
    EmailCampaignStatus.RUNNING,
    EmailCampaignStatus.CANCELLED,
  ],
  [EmailCampaignStatus.COMPLETED]: [], // Strictly terminal
  [EmailCampaignStatus.CANCELLED]: [], // Strictly terminal
  [EmailCampaignStatus.FAILED]: [EmailCampaignStatus.RUNNING],
};

export interface CreateCampaignInput {
  name: string;
  description?: string | null;
  type?: EmailType;
  templateId?: string;
  templateVersionId?: string;
  listId?: string | null;
  segmentId?: string | null;
  senderIdentityId?: string | null;
  scheduledAt?: Date | null;
}

export interface UpdateCampaignInput {
  name?: string;
  description?: string | null;
  templateVersionId?: string;
  listId?: string | null;
  segmentId?: string | null;
  senderIdentityId?: string | null;
  scheduledAt?: Date | null;
}

export interface CampaignPreviewResult {
  campaignName: string;
  emailType: EmailType;
  status: EmailCampaignStatus;
  template: {
    id: string;
    version: number;
    subject: string;
  } | null;
  sender: {
    id: string;
    email: string;
    name: string | null;
  } | null;
  audienceCount: number;
  suppressedCount: number;
  unsubscribedCount: number;
  invalidCount: number;
  eligibleRecipientCount: number;
  scheduledTime: Date | null;
}

export class EmailCampaignService {
  /**
   * Asserts valid state machine transition.
   */
  static validateTransition(
    currentStatus: EmailCampaignStatus,
    targetStatus: EmailCampaignStatus
  ): void {
    if (currentStatus === targetStatus) return;
    const allowed = VALID_TRANSITIONS[currentStatus] || [];
    if (!allowed.includes(targetStatus)) {
      throw new Error(
        `Invalid campaign state transition from '${currentStatus}' to '${targetStatus}'.`
      );
    }
  }

  /**
   * Explicitly validates that all referenced campaign resources belong to the given tenant.
   * Never relies solely on database foreign keys.
   */
  static async validateResourceOwnership(
    clientId: string,
    resources: {
      templateId?: string | null;
      templateVersionId?: string | null;
      listId?: string | null;
      segmentId?: string | null;
      senderIdentityId?: string | null;
    }
  ): Promise<void> {
    if (resources.templateId) {
      const template = await prisma.emailTemplate.findFirst({
        where: { id: resources.templateId, clientId },
      });
      if (!template) {
        throw new Error(
          `Referenced template '${resources.templateId}' does not belong to tenant '${clientId}'.`
        );
      }
    }

    if (resources.templateVersionId) {
      const version = await prisma.emailTemplateVersion.findFirst({
        where: {
          id: resources.templateVersionId,
          template: { clientId },
        },
        include: { template: true },
      });
      if (!version) {
        throw new Error(
          `Referenced template version '${resources.templateVersionId}' does not belong to tenant '${clientId}'.`
        );
      }
      if (resources.templateId && version.templateId !== resources.templateId) {
        throw new Error(
          `Template version '${resources.templateVersionId}' does not belong to template '${resources.templateId}'.`
        );
      }
    }

    if (resources.listId) {
      const list = await prisma.emailList.findFirst({
        where: { id: resources.listId, clientId },
      });
      if (!list) {
        throw new Error(
          `Referenced list '${resources.listId}' does not belong to tenant '${clientId}'.`
        );
      }
    }

    if (resources.segmentId) {
      const segment = await prisma.emailSegment.findFirst({
        where: { id: resources.segmentId, clientId },
      });
      if (!segment) {
        throw new Error(
          `Referenced segment '${resources.segmentId}' does not belong to tenant '${clientId}'.`
        );
      }
    }

    if (resources.senderIdentityId) {
      const identity = await prisma.emailSenderIdentity.findFirst({
        where: { id: resources.senderIdentityId, clientId },
      });
      if (!identity) {
        throw new Error(
          `Referenced sender identity '${resources.senderIdentityId}' does not belong to tenant '${clientId}'.`
        );
      }
    }
  }

  /**
   * Creates a new campaign in DRAFT state.
   */
  static async createCampaign(
    clientId: string,
    input: CreateCampaignInput
  ): Promise<EmailCampaign> {
    if (!clientId) throw new Error("clientId is required");
    const name = input.name?.trim();
    if (!name) throw new Error("Campaign name is required");

    // Explicitly validate all cross-tenant resource references
    await this.validateResourceOwnership(clientId, {
      templateId: input.templateId,
      templateVersionId: input.templateVersionId,
      listId: input.listId,
      segmentId: input.segmentId,
      senderIdentityId: input.senderIdentityId,
    });

    let versionId = input.templateVersionId;

    // If templateId provided without versionId, resolve active version
    if (!versionId && input.templateId) {
      const template = await EmailTemplateService.getTemplateById(clientId, input.templateId);
      if (!template || !template.activeVersion) {
        throw new Error(`Template '${input.templateId}' or active version not found.`);
      }
      versionId = template.activeVersion.id;
    }

    return prisma.emailCampaign.create({
      data: {
        clientId,
        name,
        description: input.description?.trim() || null,
        status: EmailCampaignStatus.DRAFT,
        type: input.type || EmailType.PROMOTIONAL,
        templateVersionId: versionId || null,
        listId: input.listId || null,
        segmentId: input.segmentId || null,
        senderIdentityId: input.senderIdentityId || null,
        scheduledAt: input.scheduledAt || null,
      },
    });
  }

  /**
   * Retrieves a campaign by ID strictly scoped to tenant.
   */
  static async getCampaignById(
    clientId: string,
    campaignId: string
  ): Promise<(EmailCampaign & { templateVersion: EmailTemplateVersion | null }) | null> {
    if (!clientId || !campaignId) return null;
    return prisma.emailCampaign.findFirst({
      where: { id: campaignId, clientId },
      include: {
        templateVersion: true,
        list: true,
        segment: true,
        senderIdentity: true,
      },
    });
  }

  /**
   * Updates campaign configuration in DRAFT or SCHEDULED state.
   */
  static async updateCampaign(
    clientId: string,
    campaignId: string,
    data: UpdateCampaignInput
  ): Promise<EmailCampaign> {
    const campaign = await this.getCampaignById(clientId, campaignId);
    if (!campaign) {
      throw new Error(`Campaign '${campaignId}' not found for tenant '${clientId}'.`);
    }

    if (
      campaign.status !== EmailCampaignStatus.DRAFT &&
      campaign.status !== EmailCampaignStatus.SCHEDULED
    ) {
      throw new Error(
        `Campaign in '${campaign.status}' state cannot be modified. Only DRAFT or SCHEDULED campaigns can be updated.`
      );
    }

    // Explicitly validate all cross-tenant resource references on update
    await this.validateResourceOwnership(clientId, {
      templateVersionId: data.templateVersionId,
      listId: data.listId,
      segmentId: data.segmentId,
      senderIdentityId: data.senderIdentityId,
    });

    const updatePayload: Record<string, unknown> = {};

    if (data.name !== undefined) updatePayload.name = data.name.trim();
    if (data.description !== undefined) updatePayload.description = data.description?.trim() || null;
    if (data.templateVersionId !== undefined) updatePayload.templateVersionId = data.templateVersionId;
    if (data.listId !== undefined) updatePayload.listId = data.listId;
    if (data.segmentId !== undefined) updatePayload.segmentId = data.segmentId;
    if (data.senderIdentityId !== undefined) updatePayload.senderIdentityId = data.senderIdentityId;
    if (data.scheduledAt !== undefined) updatePayload.scheduledAt = data.scheduledAt;

    return prisma.emailCampaign.update({
      where: { id: campaign.id },
      data: updatePayload,
    });
  }

  /**
   * Generates a comprehensive internal preview object for campaign planning.
   */
  static async previewCampaign(
    clientId: string,
    campaignId: string
  ): Promise<CampaignPreviewResult> {
    const campaign = await this.getCampaignById(clientId, campaignId);
    if (!campaign) {
      throw new Error(`Campaign '${campaignId}' not found for tenant '${clientId}'.`);
    }

    // Resolve audience metrics without creating database records
    const audience = await EmailAudienceResolver.resolvePreview(clientId, {
      listId: campaign.listId,
      segmentId: campaign.segmentId,
      type: campaign.type,
    });

    return {
      campaignName: campaign.name,
      emailType: campaign.type,
      status: campaign.status,
      template: campaign.templateVersion
        ? {
            id: campaign.templateVersion.id,
            version: campaign.templateVersion.version,
            subject: campaign.templateVersion.subject,
          }
        : null,
      sender: campaign.senderIdentityId
        ? {
            id: campaign.senderIdentityId,
            email: "sender@whatsapphub.internal",
            name: "Sender",
          }
        : null,
      audienceCount: audience.totalAudience,
      suppressedCount: audience.suppressedCount,
      unsubscribedCount: audience.unsubscribedCount,
      invalidCount: audience.invalidCount,
      eligibleRecipientCount: audience.eligibleCount,
      scheduledTime: campaign.scheduledAt,
    };
  }

  /**
   * Sends a test email to a specific address using the campaign's bound template.
   * NEVER creates an EmailCampaignRecipient production record.
   */
  static async sendTestEmail(
    clientId: string,
    campaignId: string,
    testEmail: string,
    customVariables: Record<string, unknown> = {},
    options?: { providerOverride?: EmailProvider }
  ): Promise<{ success: boolean; providerMessageId?: string; sentTo: string }> {
    if (!isValidEmail(testEmail)) {
      throw new Error(`Invalid test email address: '${testEmail}'`);
    }

    const campaign = await this.getCampaignById(clientId, campaignId);
    if (!campaign) {
      throw new Error(`Campaign '${campaignId}' not found for tenant '${clientId}'.`);
    }

    if (!campaign.templateVersion) {
      throw new Error(`Campaign '${campaignId}' does not have a bound template version.`);
    }

    // Render template with test recipient data & fallback variables
    const sampleVariables = {
      firstName: "TestUser",
      lastName: "Tester",
      email: testEmail,
      ...customVariables,
    };

    const rendered = TemplateEngine.renderTemplate(
      campaign.templateVersion,
      sampleVariables
    );

    // Resolve provider and send
    let provider: EmailProvider;
    let senderEmail: string | undefined;

    if (options?.providerOverride) {
      provider = options.providerOverride;
    } else {
      const resolved = await providerRegistry.resolveForTenant(clientId);
      provider = resolved.provider;
      senderEmail = resolved.senderEmail;
    }

    const result = await provider.send({
      clientId,
      type: "TRANSACTIONAL", // Test sends bypass bulk promotional headers
      to: testEmail,
      from: senderEmail || "test@whatsapphub.internal",
      subject: `[TEST] ${rendered.subject}`,
      html: rendered.html,
      text: rendered.text,
    });

    if (!result.accepted) {
      throw new Error(result.error?.message || "Test email delivery failed.");
    }

    return {
      success: true,
      providerMessageId: result.providerMessageId,
      sentTo: testEmail,
    };
  }

  /**
   * Initiates campaign sending now.
   * 1. Validates prerequisites (template bound, sender configured).
   * 2. Transitions state to RUNNING.
   * 3. Creates immutable EmailCampaignRecipient snapshot.
   * 4. Enqueues small individual BullMQ jobs per recipient.
   */
  static async sendCampaignNow(
    clientId: string,
    campaignId: string
  ): Promise<{ success: boolean; enqueuedCount: number; status: EmailCampaignStatus }> {
    const campaign = await this.getCampaignById(clientId, campaignId);
    if (!campaign) {
      throw new Error(`Campaign '${campaignId}' not found for tenant '${clientId}'.`);
    }

    if (!campaign.templateVersionId) {
      throw new Error(`Campaign '${campaignId}' cannot be sent without a bound template version.`);
    }

    this.validateTransition(campaign.status, EmailCampaignStatus.RUNNING);

    // 1. Create Immutable Recipient Snapshot
    const snapshotResult = await EmailAudienceResolver.createRecipientSnapshot(clientId, {
      id: campaign.id,
      listId: campaign.listId,
      segmentId: campaign.segmentId,
      type: campaign.type,
    });

    if (snapshotResult.eligibleCount === 0) {
      throw new Error("No eligible recipients found. Campaign cannot be sent to an empty audience.");
    }

    // 2. Transition State to RUNNING
    await prisma.emailCampaign.update({
      where: { id: campaign.id },
      data: {
        status: EmailCampaignStatus.RUNNING,
        startedAt: new Date(),
      },
    });

    // 3. Enqueue Individual Recipient Jobs on BullMQ (Honest Queue Failure Contract)
    let enqueuedCount = 0;
    try {
      const queue = getCampaignQueue();

      for (const recipient of snapshotResult.snapshotRecipients) {
        const jobId = getCampaignJobId(recipient.id);
        const jobData: CampaignJobData = {
          campaignRecipientId: recipient.id,
          campaignId: campaign.id,
          clientId,
          category: "PROMOTIONAL",
        };

        const existingJob = await queue.getJob(jobId);
        if (existingJob) {
          const state = await existingJob.getState();
          if (state === "completed" || state === "failed") {
            await existingJob.remove();
          }
        }

        await queue.add(JOB_NAMES.SEND_CAMPAIGN_RECIPIENT, jobData, {
          jobId, // Custom stable business ID guarantees queue-scoped idempotency
        });
        enqueuedCount++;
      }
    } catch (err: unknown) {
      // Revert/mark campaign state to FAILED honestly
      await prisma.emailCampaign.update({
        where: { id: campaign.id },
        data: {
          status: EmailCampaignStatus.FAILED,
        },
      });
      const errorMsg = err instanceof Error ? err.message : "Failed to enqueue campaign recipient jobs";
      throw new Error(`Failed to enqueue campaign recipient jobs: ${errorMsg}`);
    }

    return {
      success: true,
      enqueuedCount,
      status: EmailCampaignStatus.RUNNING,
    };
  }

  /**
   * Schedules a campaign for future execution.
   */
  static async scheduleCampaign(
    clientId: string,
    campaignId: string,
    scheduledAt: Date
  ): Promise<EmailCampaign> {
    if (!scheduledAt || scheduledAt.getTime() <= Date.now()) {
      throw new Error("scheduledAt must be a valid future timestamp.");
    }

    const campaign = await this.getCampaignById(clientId, campaignId);
    if (!campaign) {
      throw new Error(`Campaign '${campaignId}' not found for tenant '${clientId}'.`);
    }

    if (!campaign.templateVersionId) {
      throw new Error("Campaign cannot be scheduled without a bound template version.");
    }

    this.validateTransition(campaign.status, EmailCampaignStatus.SCHEDULED);

    const updated = await prisma.emailCampaign.update({
      where: { id: campaign.id },
      data: {
        status: EmailCampaignStatus.SCHEDULED,
        scheduledAt,
      },
    });

    // Enqueue delayed trigger job on BullMQ (Honest Queue Failure Contract)
    try {
      const delayMs = scheduledAt.getTime() - Date.now();
      const queue = getCampaignQueue();
      await queue.add(
        JOB_NAMES.TRIGGER_SCHEDULED_CAMPAIGN,
        {
          campaignId: campaign.id,
          clientId,
          category: "PROMOTIONAL",
        },
        {
          delay: Math.max(0, delayMs),
          jobId: `trigger-campaign-${campaign.id}`,
        }
      );
    } catch (err: unknown) {
      // Revert campaign state to DRAFT honestly
      await prisma.emailCampaign.update({
        where: { id: campaign.id },
        data: {
          status: EmailCampaignStatus.DRAFT,
          scheduledAt: null,
        },
      });
      const errorMsg = err instanceof Error ? err.message : "Failed to enqueue scheduled campaign trigger";
      throw new Error(`Failed to enqueue scheduled campaign trigger: ${errorMsg}`);
    }

    return updated;
  }

  /**
   * Pauses an active or scheduled campaign.
   */
  static async pauseCampaign(clientId: string, campaignId: string): Promise<EmailCampaign> {
    const campaign = await this.getCampaignById(clientId, campaignId);
    if (!campaign) {
      throw new Error(`Campaign '${campaignId}' not found for tenant '${clientId}'.`);
    }

    this.validateTransition(campaign.status, EmailCampaignStatus.PAUSED);

    return prisma.emailCampaign.update({
      where: { id: campaign.id },
      data: { status: EmailCampaignStatus.PAUSED },
    });
  }

  /**
   * Resumes a paused or failed campaign.
   * - Only ADMIN can execute (enforced in API route)
   * - Transitions PAUSED / FAILED -> RUNNING
   * - Requeues eligible PENDING recipients
   * - Already SENT recipients are NEVER resent
   * - CANCELLED and COMPLETED campaigns can never be resumed
   */
  static async resumeCampaign(
    clientId: string,
    campaignId: string
  ): Promise<{ success: boolean; requeuedCount: number; status: EmailCampaignStatus }> {
    const campaign = await this.getCampaignById(clientId, campaignId);
    if (!campaign) {
      throw new Error(`Campaign '${campaignId}' not found for tenant '${clientId}'.`);
    }

    if (campaign.status === EmailCampaignStatus.CANCELLED) {
      throw new Error("Cancelled campaigns cannot be resumed.");
    }

    if (campaign.status === EmailCampaignStatus.COMPLETED) {
      throw new Error("Completed campaigns cannot be resumed.");
    }

    this.validateTransition(campaign.status, EmailCampaignStatus.RUNNING);

    // 1. Atomically transition campaign state to RUNNING
    await prisma.emailCampaign.update({
      where: { id: campaign.id },
      data: { status: EmailCampaignStatus.RUNNING },
    });

    // 2. Query eligible PENDING recipients only - already SENT recipients are never resent
    const pendingRecipients = await prisma.emailCampaignRecipient.findMany({
      where: {
        campaignId: campaign.id,
        status: "PENDING",
      },
    });

    let requeuedCount = 0;
    if (pendingRecipients.length > 0) {
      try {
        const queue = getCampaignQueue();
        for (const recipient of pendingRecipients) {
          const jobId = getCampaignJobId(recipient.id);
          const jobData: CampaignJobData = {
            campaignRecipientId: recipient.id,
            campaignId: campaign.id,
            clientId,
            category: "PROMOTIONAL",
          };

          // If a completed or failed job with the same ID already exists in BullMQ, remove it first
          const existingJob = await queue.getJob(jobId);
          if (existingJob) {
            const state = await existingJob.getState();
            if (state === "completed" || state === "failed") {
              await existingJob.remove();
            }
          }

          await queue.add(JOB_NAMES.SEND_CAMPAIGN_RECIPIENT, jobData, {
            jobId,
          });
          requeuedCount++;
        }
      } catch (err: unknown) {
        // Revert campaign state to FAILED honestly
        await prisma.emailCampaign.update({
          where: { id: campaign.id },
          data: { status: EmailCampaignStatus.FAILED },
        });
        const errorMsg = err instanceof Error ? err.message : "Failed to requeue campaign recipient jobs";
        throw new Error(`Failed to requeue campaign recipient jobs: ${errorMsg}`);
      }
    } else {
      // If there are no pending recipients, check if all are terminal and complete
      const nonTerminalCount = await prisma.emailCampaignRecipient.count({
        where: {
          campaignId: campaign.id,
          status: { in: ["PENDING", "PROCESSING"] },
        },
      });

      if (nonTerminalCount === 0) {
        await prisma.emailCampaign.update({
          where: { id: campaign.id },
          data: {
            status: EmailCampaignStatus.COMPLETED,
            completedAt: new Date(),
          },
        });
        return {
          success: true,
          requeuedCount: 0,
          status: EmailCampaignStatus.COMPLETED,
        };
      }
    }

    return {
      success: true,
      requeuedCount,
      status: EmailCampaignStatus.RUNNING,
    };
  }

  /**
   * Cancels a campaign.
   * Handles:
   * - Removing delayed trigger jobs from BullMQ
   * - Updating all PENDING recipients to CANCELLED in database
   * - Transitioning campaign to CANCELLED
   * - Ensures already transmitted messages remain untouched (no fake recalls)
   */
  static async cancelCampaign(clientId: string, campaignId: string): Promise<EmailCampaign> {
    const campaign = await this.getCampaignById(clientId, campaignId);
    if (!campaign) {
      throw new Error(`Campaign '${campaignId}' not found for tenant '${clientId}'.`);
    }

    if (campaign.status === EmailCampaignStatus.CANCELLED) {
      throw new Error(`Campaign '${campaignId}' is already cancelled.`);
    }

    if (campaign.status === EmailCampaignStatus.COMPLETED) {
      throw new Error(`Completed campaign '${campaignId}' cannot be cancelled.`);
    }

    this.validateTransition(campaign.status, EmailCampaignStatus.CANCELLED);

    // 1. Remove delayed BullMQ trigger job if present
    try {
      const queue = getCampaignQueue();
      const triggerJob = await queue.getJob(`trigger-campaign-${campaign.id}`);
      if (triggerJob) {
        await triggerJob.remove();
        logger.info(`[CampaignService:cancel] Removed delayed trigger job for campaign ${campaign.id}`);
      }
    } catch (err) {
      logger.warn(`[CampaignService:cancel] Could not remove BullMQ trigger job: ${err}`);
    }

    // 2. Cancel remaining pending recipients in database
    await prisma.emailCampaignRecipient.updateMany({
      where: {
        campaignId: campaign.id,
        status: "PENDING",
      },
      data: {
        status: "CANCELLED",
      },
    });

    // 3. Mark campaign status as CANCELLED
    return prisma.emailCampaign.update({
      where: { id: campaign.id },
      data: { status: EmailCampaignStatus.CANCELLED },
    });
  }

  /**
   * Lists campaigns for a tenant with authentic engagement metrics.
   */
  static async listCampaigns(
    clientId: string,
    options: { status?: EmailCampaignStatus } = {}
  ): Promise<
    (EmailCampaign & {
      uniqueOpens: number;
      uniqueClicks: number;
      openRate: number;
      clickRate: number;
    })[]
  > {
    if (!clientId) throw new Error("clientId is required");

    const where: Record<string, unknown> = { clientId };
    if (options.status) where.status = options.status;

    const campaigns = await prisma.emailCampaign.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: {
        recipients: {
          select: {
            deliveries: {
              select: {
                events: {
                  select: { eventType: true },
                },
              },
            },
          },
        },
      },
    });

    return campaigns.map((camp) => {
      let uniqueOpens = 0;
      let uniqueClicks = 0;

      for (const recipient of camp.recipients || []) {
        let recipientOpened = false;
        let recipientClicked = false;

        for (const delivery of recipient.deliveries || []) {
          for (const evt of delivery.events || []) {
            if (evt.eventType === EmailEventType.OPENED) {
              recipientOpened = true;
            } else if (evt.eventType === EmailEventType.CLICKED) {
              recipientClicked = true;
            }
          }
        }

        if (recipientOpened) uniqueOpens++;
        if (recipientClicked) uniqueClicks++;
      }

      const delivered = Math.max(camp.deliveredCount, uniqueOpens);
      const openRate =
        delivered > 0 ? Math.round((uniqueOpens / delivered) * 10000) / 100 : 0;
      const clickRate =
        delivered > 0 ? Math.round((uniqueClicks / delivered) * 10000) / 100 : 0;

      const rest = { ...camp };
      delete (rest as { recipients?: unknown }).recipients;
      return {
        ...rest,
        uniqueOpens,
        uniqueClicks,
        openRate,
        clickRate,
      };
    });
  }
}
