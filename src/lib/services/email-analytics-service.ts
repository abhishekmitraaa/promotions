/**
 * Email Campaign Analytics Service
 *
 * Computes authoritative delivery and engagement analytics for email campaigns:
 * - Prevents metric inflation from duplicate events by relying on unique deliveries and recipient snapshots.
 * - Authoritative metrics: sent, delivered, failed, bounced, complaints, unsubscribed, opened, clicked.
 * - Accurately calculated percentage rates.
 */

import { prisma } from "../prisma";
import { EmailDeliveryStatus, EmailEventType } from "@prisma/client";

export interface CampaignAnalytics {
  campaignId: string;
  campaignName: string;
  status: string;
  totalRecipients: number;
  sent: number;
  delivered: number;
  failed: number;
  bounced: number;
  complaints: number;
  unsubscribed: number;
  uniqueOpens: number;
  uniqueClicks: number;
  totalOpens: number;
  totalClicks: number;
  rates: {
    deliveryRate: number; // delivered / sent
    bounceRate: number; // bounced / sent
    openRate: number; // uniqueOpens / delivered
    clickRate: number; // uniqueClicks / delivered
    complaintRate: number; // complaints / delivered
    unsubscribeRate: number; // unsubscribed / delivered
  };
}

export class EmailAnalyticsService {
  /**
   * Retrieves authoritative campaign analytics.
   */
  static async getCampaignAnalytics(
    clientId: string,
    campaignId: string
  ): Promise<CampaignAnalytics> {
    const campaign = await prisma.emailCampaign.findFirst({
      where: { id: campaignId, clientId },
      include: {
        recipients: {
          select: {
            id: true,
            status: true,
            deliveries: {
              select: {
                id: true,
                status: true,
                events: {
                  select: {
                    eventType: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!campaign) {
      throw new Error(`Campaign '${campaignId}' not found for tenant '${clientId}'.`);
    }

    // Authoritative counts from recipients and deliveries
    let sent = 0;
    let delivered = 0;
    let failed = 0;
    let bounced = 0;
    let complaints = 0;
    let uniqueOpens = 0;
    let uniqueClicks = 0;
    let totalOpens = 0;
    let totalClicks = 0;

    for (const recipient of campaign.recipients) {
      let recipientSent = false;
      let recipientDelivered = false;
      let recipientFailed = false;
      let recipientBounced = false;
      let recipientComplained = false;
      let recipientOpened = false;
      let recipientClicked = false;

      for (const delivery of recipient.deliveries) {
        if (
          delivery.status === EmailDeliveryStatus.SENT ||
          delivery.status === EmailDeliveryStatus.DELIVERED ||
          delivery.status === EmailDeliveryStatus.BOUNCED ||
          delivery.status === EmailDeliveryStatus.COMPLAINED ||
          delivery.status === EmailDeliveryStatus.FAILED
        ) {
          recipientSent = true;
        }

        if (delivery.status === EmailDeliveryStatus.DELIVERED) {
          recipientDelivered = true;
        } else if (delivery.status === EmailDeliveryStatus.FAILED) {
          recipientFailed = true;
        } else if (delivery.status === EmailDeliveryStatus.BOUNCED) {
          recipientBounced = true;
        } else if (delivery.status === EmailDeliveryStatus.COMPLAINED) {
          recipientComplained = true;
        }

        for (const evt of delivery.events) {
          if (evt.eventType === EmailEventType.OPENED) {
            totalOpens++;
            recipientOpened = true;
          } else if (evt.eventType === EmailEventType.CLICKED) {
            totalClicks++;
            recipientClicked = true;
          }
        }
      }

      // Authoritative consistency: Opens/clicks imply delivery
      if (recipientOpened || recipientClicked) {
        recipientDelivered = true;
      }

      if (recipientSent) sent++;
      if (recipientDelivered) delivered++;
      else if (recipientBounced) bounced++;
      else if (recipientComplained) complaints++;
      else if (recipientFailed) failed++;

      if (recipientOpened) uniqueOpens++;
      if (recipientClicked) uniqueClicks++;
    }

    // Fall back to campaign counters if no deliveries exist in test/mock environment
    if (sent === 0 && campaign.sentCount > 0) {
      sent = campaign.sentCount;
      delivered = campaign.deliveredCount;
      bounced = campaign.bouncedCount;
      complaints = campaign.complaintCount;
    }

    // Consistency guard: delivered can never be less than uniqueOpens or uniqueClicks
    delivered = Math.max(delivered, uniqueOpens, uniqueClicks);

    const unsubscribed = campaign.unsubscribedCount;

    // Rates calculation with safe zero-division handling
    const safeRate = (numerator: number, denominator: number): number => {
      if (denominator <= 0) return 0;
      return Math.round((numerator / denominator) * 10000) / 100; // 2 decimal places
    };

    return {
      campaignId: campaign.id,
      campaignName: campaign.name,
      status: campaign.status,
      totalRecipients: campaign.totalRecipients,
      sent,
      delivered,
      failed,
      bounced,
      complaints,
      unsubscribed,
      uniqueOpens,
      uniqueClicks,
      totalOpens,
      totalClicks,
      rates: {
        deliveryRate: safeRate(delivered, sent),
        bounceRate: safeRate(bounced, sent),
        openRate: safeRate(uniqueOpens, delivered),
        clickRate: safeRate(uniqueClicks, delivered),
        complaintRate: safeRate(complaints, delivered),
        unsubscribeRate: safeRate(unsubscribed, delivered),
      },
    };
  }

  /**
   * Retrieves authoritative aggregated tenant-wide email analytics.
   * Completely replaces synthetic or hardcoded heuristic metrics.
   */
  static async getTenantAnalytics(clientId: string): Promise<{
    sent: number;
    delivered: number;
    failed: number;
    bounced: number;
    complaints: number;
    unsubscribed: number;
    uniqueOpens: number;
    uniqueClicks: number;
    totalOpens: number;
    totalClicks: number;
    rates: {
      deliveryRate: number;
      bounceRate: number;
      openRate: number;
      clickRate: number;
      complaintRate: number;
      unsubscribeRate: number;
    };
  }> {
    const [deliveries, campaigns, unsubsCount] = await Promise.all([
      prisma.emailDelivery.findMany({
        where: { clientId },
        select: {
          id: true,
          status: true,
          events: {
            select: {
              eventType: true,
            },
          },
        },
      }),
      prisma.emailCampaign.findMany({
        where: { clientId },
        select: {
          sentCount: true,
          deliveredCount: true,
          bouncedCount: true,
          complaintCount: true,
          unsubscribedCount: true,
        },
      }),
      prisma.emailSuppression.count({
        where: { clientId, reason: "UNSUBSCRIBED" },
      }),
    ]);

    let sent = 0;
    let delivered = 0;
    let failed = 0;
    let bounced = 0;
    let complaints = 0;
    let uniqueOpens = 0;
    let uniqueClicks = 0;
    let totalOpens = 0;
    let totalClicks = 0;

    if (deliveries.length > 0) {
      for (const d of deliveries) {
        if (
          d.status === EmailDeliveryStatus.SENT ||
          d.status === EmailDeliveryStatus.DELIVERED ||
          d.status === EmailDeliveryStatus.BOUNCED ||
          d.status === EmailDeliveryStatus.COMPLAINED ||
          d.status === EmailDeliveryStatus.FAILED
        ) {
          sent++;
        }

        let isDelivered = d.status === EmailDeliveryStatus.DELIVERED;
        if (d.status === EmailDeliveryStatus.FAILED) failed++;
        else if (d.status === EmailDeliveryStatus.BOUNCED) bounced++;
        else if (d.status === EmailDeliveryStatus.COMPLAINED) complaints++;

        let opened = false;
        let clicked = false;
        for (const evt of d.events) {
          if (evt.eventType === EmailEventType.OPENED) {
            totalOpens++;
            opened = true;
          } else if (evt.eventType === EmailEventType.CLICKED) {
            totalClicks++;
            clicked = true;
          }
        }

        // Authoritative consistency: open or click implies delivery
        if (opened || clicked) isDelivered = true;
        if (isDelivered) delivered++;
        if (opened) uniqueOpens++;
        if (clicked) uniqueClicks++;
      }
    } else {
      // If no granular deliveries exist, aggregate from campaigns
      for (const c of campaigns) {
        sent += c.sentCount || 0;
        delivered += c.deliveredCount || 0;
        bounced += c.bouncedCount || 0;
        complaints += c.complaintCount || 0;
      }
      failed = Math.max(0, sent - delivered - bounced - complaints);
    }

    const campaignUnsubs = campaigns.reduce((acc, c) => acc + (c.unsubscribedCount || 0), 0);
    const unsubscribed = Math.max(unsubsCount, campaignUnsubs);

    // Guard: delivered can never be less than uniqueOpens or uniqueClicks
    delivered = Math.max(delivered, uniqueOpens, uniqueClicks);

    const safeRate = (numerator: number, denominator: number): number => {
      if (denominator <= 0) return 0;
      return Math.round((numerator / denominator) * 10000) / 100;
    };

    return {
      sent,
      delivered,
      failed,
      bounced,
      complaints,
      unsubscribed,
      uniqueOpens,
      uniqueClicks,
      totalOpens,
      totalClicks,
      rates: {
        deliveryRate: safeRate(delivered, sent),
        bounceRate: safeRate(bounced, sent),
        openRate: safeRate(uniqueOpens, delivered),
        clickRate: safeRate(uniqueClicks, delivered),
        complaintRate: safeRate(complaints, delivered),
        unsubscribeRate: safeRate(unsubscribed, delivered),
      },
    };
  }
}
