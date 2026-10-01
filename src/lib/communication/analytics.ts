/**
 * Shared Analytics Contracts & Cross-Channel Aggregator
 *
 * Implements unified performance and deliverability analytics across all channels:
 * - WhatsApp
 * - Email
 * - Future SMS
 * - Future Push
 *
 * Guarantees:
 * 1. Safe arithmetic (zero division, NaN, and negative value defenses).
 * 2. Strict tenant isolation (`clientId` boundary on every query).
 * 3. Channel breakdown alongside aggregate platform metrics.
 * 4. Zero schema mutation: queries existing `Message` (WhatsApp) and `EmailDelivery` / `EmailEvent` models.
 */

import { prisma } from "../prisma";
import { assertTenantContext, TenantContext } from "./tenant";
import { ChannelType, UnifiedAnalyticsSummary, UnifiedRateMetrics } from "./types";

export interface RawChannelCounts {
  sent: number;
  delivered: number;
  readOrOpened: number;
  clicked: number;
  failed: number;
  bounced: number;
  complaints: number;
  optOuts: number;
}

export const EMPTY_RAW_COUNTS: RawChannelCounts = Object.freeze({
  sent: 0,
  delivered: 0,
  readOrOpened: 0,
  clicked: 0,
  failed: 0,
  bounced: 0,
  complaints: 0,
  optOuts: 0,
});

/**
 * Computes unified rate metrics with defensive division and precision rounding.
 */
export function computeUnifiedRates(counts: Partial<RawChannelCounts>): UnifiedRateMetrics {
  const sent = Math.max(0, counts.sent || 0);
  const delivered = Math.max(0, counts.delivered || 0);
  const readOrOpened = Math.max(0, counts.readOrOpened || 0);
  const clicked = Math.max(0, counts.clicked || 0);
  const failed = Math.max(0, counts.failed || 0);
  const bounced = Math.max(0, counts.bounced || 0);
  const complaints = Math.max(0, counts.complaints || 0);
  const optOuts = Math.max(0, counts.optOuts || 0);

  const safeRate = (numerator: number, denominator: number): number => {
    if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) {
      return 0.0;
    }
    const ratio = numerator / denominator;
    const clamped = Math.min(1.0, Math.max(0.0, ratio));
    return Number(clamped.toFixed(4));
  };

  // Deliveries basis
  const deliveryBasis = delivered > 0 ? delivered : sent;

  return {
    sent,
    delivered,
    readOrOpened,
    clicked,
    failed,
    bounced,
    complaints,
    optOuts,

    deliveryRate: safeRate(delivered, sent),
    readOrOpenRate: safeRate(readOrOpened, deliveryBasis),
    clickThroughRate: safeRate(clicked, deliveryBasis),
    clickToOpenRate: safeRate(clicked, readOrOpened),
    bounceRate: safeRate(bounced, sent),
    complaintRate: safeRate(complaints, deliveryBasis),
    optOutRate: safeRate(optOuts, deliveryBasis),
  };
}

/**
 * Aggregates raw counts across multiple channels into a unified summary.
 */
export function buildUnifiedAnalyticsSummary(
  channelMap: Partial<Record<ChannelType, Partial<RawChannelCounts>>>,
  timeframe: { startDate: Date; endDate: Date }
): UnifiedAnalyticsSummary {
  const channels: ChannelType[] = ["WHATSAPP", "EMAIL", "SMS", "PUSH"];

  const totals: RawChannelCounts = {
    sent: 0,
    delivered: 0,
    readOrOpened: 0,
    clicked: 0,
    failed: 0,
    bounced: 0,
    complaints: 0,
    optOuts: 0,
  };

  const byChannel = {} as Record<ChannelType, UnifiedRateMetrics>;

  for (const ch of channels) {
    const raw = channelMap[ch] || EMPTY_RAW_COUNTS;
    const chMetrics = computeUnifiedRates(raw);
    byChannel[ch] = chMetrics;

    totals.sent += chMetrics.sent;
    totals.delivered += chMetrics.delivered;
    totals.readOrOpened += chMetrics.readOrOpened;
    totals.clicked += chMetrics.clicked;
    totals.failed += chMetrics.failed;
    totals.bounced += chMetrics.bounced;
    totals.complaints += chMetrics.complaints;
    totals.optOuts += chMetrics.optOuts;
  }

  const overallMetrics = computeUnifiedRates(totals);

  return {
    ...overallMetrics,
    byChannel,
    timeframe,
  };
}

/**
 * Queries and computes unified cross-channel analytics for a specific tenant from database tables.
 */
export async function getUnifiedTenantAnalytics(
  tenant: TenantContext | string,
  timeframe: { startDate: Date; endDate: Date }
): Promise<UnifiedAnalyticsSummary> {
  const { clientId } = assertTenantContext(tenant);

  // 1. WhatsApp metrics from `Message` table (outbound only)
  const [waSent, waDelivered, waRead, waFailed] = await Promise.all([
    prisma.message.count({
      where: {
        clientId,
        direction: "OUTBOUND",
        createdAt: { gte: timeframe.startDate, lte: timeframe.endDate },
      },
    }),
    prisma.message.count({
      where: {
        clientId,
        direction: "OUTBOUND",
        status: { in: ["DELIVERED", "READ"] },
        createdAt: { gte: timeframe.startDate, lte: timeframe.endDate },
      },
    }),
    prisma.message.count({
      where: {
        clientId,
        direction: "OUTBOUND",
        status: "READ",
        createdAt: { gte: timeframe.startDate, lte: timeframe.endDate },
      },
    }),
    prisma.message.count({
      where: {
        clientId,
        direction: "OUTBOUND",
        status: "FAILED",
        createdAt: { gte: timeframe.startDate, lte: timeframe.endDate },
      },
    }),
  ]);

  const whatsappCounts: RawChannelCounts = {
    sent: waSent,
    delivered: waDelivered,
    readOrOpened: waRead,
    clicked: 0, // WhatsApp link clicks tracked via event webhooks if configured
    failed: waFailed,
    bounced: 0, // In WhatsApp, hard failures are marked FAILED
    complaints: 0,
    optOuts: 0,
  };

  // 2. Email metrics from `EmailDelivery` and `EmailEvent` tables
  const [emailSent, emailDelivered, emailOpened, emailClicked, emailBounced, emailComplained, emailFailed] =
    await Promise.all([
      prisma.emailDelivery.count({
        where: {
          clientId,
          sentAt: { gte: timeframe.startDate, lte: timeframe.endDate },
        },
      }),
      prisma.emailDelivery.count({
        where: {
          clientId,
          deliveredAt: { gte: timeframe.startDate, lte: timeframe.endDate },
        },
      }),
      prisma.emailEvent.count({
        where: {
          delivery: { clientId },
          eventType: "OPENED",
          createdAt: { gte: timeframe.startDate, lte: timeframe.endDate },
        },
      }),
      prisma.emailEvent.count({
        where: {
          delivery: { clientId },
          eventType: "CLICKED",
          createdAt: { gte: timeframe.startDate, lte: timeframe.endDate },
        },
      }),
      prisma.emailDelivery.count({
        where: {
          clientId,
          status: "BOUNCED",
          updatedAt: { gte: timeframe.startDate, lte: timeframe.endDate },
        },
      }),
      prisma.emailEvent.count({
        where: {
          delivery: { clientId },
          eventType: "COMPLAINT",
          createdAt: { gte: timeframe.startDate, lte: timeframe.endDate },
        },
      }),
      prisma.emailDelivery.count({
        where: {
          clientId,
          status: "FAILED",
          failedAt: { gte: timeframe.startDate, lte: timeframe.endDate },
        },
      }),
    ]);

  const emailCounts: RawChannelCounts = {
    sent: emailSent,
    delivered: emailDelivered,
    readOrOpened: emailOpened,
    clicked: emailClicked,
    failed: emailFailed,
    bounced: emailBounced,
    complaints: emailComplained,
    optOuts: 0,
  };

  // 3. SMS and Push placeholders for future channels
  const smsCounts: RawChannelCounts = { ...EMPTY_RAW_COUNTS };
  const pushCounts: RawChannelCounts = { ...EMPTY_RAW_COUNTS };

  return buildUnifiedAnalyticsSummary(
    {
      WHATSAPP: whatsappCounts,
      EMAIL: emailCounts,
      SMS: smsCounts,
      PUSH: pushCounts,
    },
    timeframe
  );
}
