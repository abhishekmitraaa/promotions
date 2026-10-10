/**
 * CampaignTriggerService
 *
 * Neutral, BullMQ-free service for campaign triggering and lifecycle transitions.
 * - Triggers scheduled campaigns: verifies schedule, checks sender/template/audience
 * - Atomically moves SCHEDULED -> RUNNING
 * - Resolves audience snapshot and seeds EmailCampaignRecipient records
 * - Enqueues durable BackgroundJob records for recipients
 * - Detects completion: moves RUNNING -> COMPLETED when all recipients reach terminal states
 */

import { prisma } from "../../prisma";
import {
  EmailCampaignStatus,
  EmailProviderStatus,
  BackgroundJobStatus,
} from "@prisma/client";
import { EmailAudienceResolver } from "../email-audience-resolver";
import {
  RetryableError,
  PermanentError,
} from "../../errors/job-errors";
import { logger } from "../../logger";

export interface TriggerCampaignOptions {
  campaignId: string;
  clientId: string;
}

export interface TriggerCampaignResult {
  success: boolean;
  campaignId: string;
  recipientCount: number;
  skipped?: boolean;
  reason?: string;
}

export class CampaignTriggerService {
  /**
   * Deterministically transitions campaign to COMPLETED if all recipients
   * have reached terminal states (SENT, FAILED, CANCELLED, SUPPRESSED, BOUNCED).
   */
  static async checkAndCompleteCampaign(campaignId: string): Promise<boolean> {
    const activeRecipients = await prisma.emailCampaignRecipient.count({
      where: {
        campaignId,
        status: { in: ["PENDING", "PROCESSING", "RETRYING"] },
      },
    });

    if (activeRecipients === 0) {
      const updated = await prisma.emailCampaign.updateMany({
        where: {
          id: campaignId,
          status: { in: [EmailCampaignStatus.RUNNING, EmailCampaignStatus.PAUSED] },
        },
        data: {
          status: EmailCampaignStatus.COMPLETED,
          completedAt: new Date(),
        },
      });

      if (updated.count > 0) {
        logger.info(
          `[CampaignTriggerService] Campaign ${campaignId} completed deterministically. All recipients reached terminal states.`
        );
        return true;
      }
    }
    return false;
  }

  /**
   * Finds scheduled campaigns that are ready to trigger
   */
  static async findDueScheduledCampaigns(limit = 10) {
    const now = new Date();
    return prisma.emailCampaign.findMany({
      where: {
        status: EmailCampaignStatus.SCHEDULED,
        scheduledAt: { lte: now },
      },
      take: limit,
      orderBy: { scheduledAt: "asc" },
    });
  }

  /**
   * Triggers a scheduled campaign into RUNNING and freezes the audience snapshot
   */
  static async triggerScheduledCampaign(
    options: TriggerCampaignOptions
  ): Promise<TriggerCampaignResult> {
    const { campaignId, clientId } = options;

    logger.info(
      `[CampaignTriggerService] Triggering campaign ${campaignId} for tenant ${clientId}`
    );

    // 1. Load Campaign with relations
    const campaign = await prisma.emailCampaign.findFirst({
      where: { id: campaignId, clientId },
      include: {
        templateVersion: true,
        senderIdentity: {
          include: {
            providerConfig: true,
          },
        },
        list: true,
        segment: true,
      },
    });

    if (!campaign) {
      throw new PermanentError(`Campaign '${campaignId}' not found for tenant '${clientId}'.`);
    }

    if (campaign.status !== EmailCampaignStatus.SCHEDULED) {
      logger.info(
        `[CampaignTriggerService] Campaign '${campaignId}' is in status '${campaign.status}'. Skipping trigger.`
      );
      return {
        success: true,
        campaignId,
        recipientCount: 0,
        skipped: true,
        reason: `CAMPAIGN_NOT_SCHEDULED_${campaign.status}`,
      };
    }

    // 2. Validate Scheduled Time
    const now = new Date();
    if (campaign.scheduledAt && campaign.scheduledAt.getTime() > now.getTime() + 1000) {
      throw new RetryableError(
        `Scheduled time ${campaign.scheduledAt.toISOString()} has not arrived yet for campaign '${campaignId}'.`
      );
    }

    // 3. Validate Configuration
    if (!campaign.templateVersionId || !campaign.templateVersion) {
      await prisma.emailCampaign.update({
        where: { id: campaign.id },
        data: { status: EmailCampaignStatus.FAILED },
      });
      throw new PermanentError(`Campaign '${campaignId}' has no bound template version.`);
    }

    if (!campaign.listId && !campaign.segmentId) {
      await prisma.emailCampaign.update({
        where: { id: campaign.id },
        data: { status: EmailCampaignStatus.FAILED },
      });
      throw new PermanentError(`Campaign '${campaignId}' has no audience list or segment.`);
    }

    if (campaign.senderIdentityId && campaign.senderIdentity) {
      if (!campaign.senderIdentity.verified) {
        await prisma.emailCampaign.update({
          where: { id: campaign.id },
          data: { status: EmailCampaignStatus.FAILED },
        });
        throw new PermanentError(`Sender identity '${campaign.senderIdentity.email}' is not verified.`);
      }
    }

    // 4. Atomically transition from SCHEDULED to RUNNING
    const transitionResult = await prisma.emailCampaign.updateMany({
      where: {
        id: campaign.id,
        status: EmailCampaignStatus.SCHEDULED,
      },
      data: {
        status: EmailCampaignStatus.RUNNING,
        startedAt: new Date(),
      },
    });

    if (transitionResult.count === 0) {
      logger.info(
        `[CampaignTriggerService] Campaign '${campaignId}' was already transitioned by another worker. Skipping.`
      );
      return {
        success: true,
        campaignId,
        recipientCount: 0,
        skipped: true,
        reason: "ALREADY_TRANSITIONED",
      };
    }

    // 5. Freeze Audience Snapshot
    await EmailAudienceResolver.createRecipientSnapshot(clientId, {
      id: campaign.id,
      listId: campaign.listId,
      segmentId: campaign.segmentId,
      type: campaign.type,
    });

    const recipients = await prisma.emailCampaignRecipient.findMany({
      where: { campaignId: campaign.id },
    });

    logger.info(
      `[CampaignTriggerService] Resolved audience of ${recipients.length} recipients for campaign ${campaign.id}`
    );

    // Empty audience guard
    if (recipients.length === 0) {
      logger.info(
        `[CampaignTriggerService] Campaign ${campaign.id} resolved 0 eligible recipients. Marking COMPLETED.`
      );
      await prisma.emailCampaign.update({
        where: { id: campaign.id },
        data: {
          status: EmailCampaignStatus.COMPLETED,
          completedAt: new Date(),
          totalRecipients: 0,
        },
      });
      return {
        success: true,
        campaignId: campaign.id,
        recipientCount: 0,
      };
    }

    await prisma.emailCampaign.update({
      where: { id: campaign.id },
      data: { totalRecipients: recipients.length },
    });

    // 6. Create durable BackgroundJob rows for serverless execution
    const batchSize = 100;
    for (let i = 0; i < recipients.length; i += batchSize) {
      const slice = recipients.slice(i, i + batchSize);
      await prisma.$transaction(
        slice.map((r: { id: string }) =>
          prisma.backgroundJob.create({
            data: {
              clientId,
              type: "CAMPAIGN_RECIPIENT",
              status: BackgroundJobStatus.QUEUED,
              payload: JSON.stringify({
                campaignId: campaign.id,
                campaignRecipientId: r.id,
                clientId,
              }),
              deduplicationKey: `campaign-recip:${r.id}`,
            },
          })
        )
      );
    }

    logger.info(
      `[CampaignTriggerService] Campaign ${campaign.id} triggered into RUNNING with ${recipients.length} background jobs.`
    );

    return {
      success: true,
      campaignId: campaign.id,
      recipientCount: recipients.length,
    };
  }
}
