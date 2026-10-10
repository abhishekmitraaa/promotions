/**
 * Unified Multi-Channel Analytics Aggregation
 *
 * Implements authoritative mathematical contracts for computing delivery,
 * engagement, bounce, and complaint metrics across individual channels
 * and the aggregated cross-channel portfolio.
 */

import { ChannelType, CHANNELS, UnifiedRateMetrics, UnifiedAnalyticsSummary } from "./types";

export interface RawMetricsCounts {
  sent?: number;
  delivered?: number;
  readOrOpened?: number;
  clicked?: number;
  failed?: number;
  bounced?: number;
  complaints?: number;
  optOuts?: number;
}

/**
 * Computes unified rate metrics from raw interaction counts with zero-division safety.
 */
export function computeRateMetrics(counts: RawMetricsCounts): UnifiedRateMetrics {
  const sent = Math.max(0, counts.sent ?? 0);
  const delivered = Math.max(0, counts.delivered ?? 0);
  const readOrOpened = Math.max(0, counts.readOrOpened ?? 0);
  const clicked = Math.max(0, counts.clicked ?? 0);
  const failed = Math.max(0, counts.failed ?? 0);
  const bounced = Math.max(0, counts.bounced ?? 0);
  const complaints = Math.max(0, counts.complaints ?? 0);
  const optOuts = Math.max(0, counts.optOuts ?? 0);

  // Delivery Rate: delivered / sent
  const deliveryRate = sent > 0 ? Number((delivered / sent).toFixed(4)) : 0;

  // Read or Open Rate: readOrOpened / delivered
  const readOrOpenRate = delivered > 0 ? Number((readOrOpened / delivered).toFixed(4)) : 0;

  // Click-Through Rate (CTR): clicked / delivered
  const clickThroughRate = delivered > 0 ? Number((clicked / delivered).toFixed(4)) : 0;

  // Click-to-Open Rate (CTOR): clicked / readOrOpened
  const clickToOpenRate = readOrOpened > 0 ? Number((clicked / readOrOpened).toFixed(4)) : 0;

  // Bounce Rate: bounced / sent
  const bounceRate = sent > 0 ? Number((bounced / sent).toFixed(4)) : 0;

  // Complaint Rate: complaints / delivered
  const complaintRate = delivered > 0 ? Number((complaints / delivered).toFixed(4)) : 0;

  // Opt-out Rate: optOuts / delivered
  const optOutRate = delivered > 0 ? Number((optOuts / delivered).toFixed(4)) : 0;

  return {
    sent,
    delivered,
    readOrOpened,
    clicked,
    failed,
    bounced,
    complaints,
    optOuts,
    deliveryRate,
    readOrOpenRate,
    clickThroughRate,
    clickToOpenRate,
    bounceRate,
    complaintRate,
    optOutRate,
  };
}

/**
 * Aggregates channel-specific metrics into an omnichannel summary report.
 */
export function aggregateOmnichannelAnalytics(
  channelMetrics: Partial<Record<ChannelType, RawMetricsCounts>>,
  timeframe: { startDate: Date; endDate: Date }
): UnifiedAnalyticsSummary {
  const byChannel: Record<ChannelType, UnifiedRateMetrics> = {
    WHATSAPP: computeRateMetrics(channelMetrics.WHATSAPP ?? {}),
    EMAIL: computeRateMetrics(channelMetrics.EMAIL ?? {}),
    SMS: computeRateMetrics(channelMetrics.SMS ?? {}),
    PUSH: computeRateMetrics(channelMetrics.PUSH ?? {}),
  };

  const totals: RawMetricsCounts = {
    sent: 0,
    delivered: 0,
    readOrOpened: 0,
    clicked: 0,
    failed: 0,
    bounced: 0,
    complaints: 0,
    optOuts: 0,
  };

  for (const ch of CHANNELS) {
    const m = byChannel[ch];
    totals.sent! += m.sent;
    totals.delivered! += m.delivered;
    totals.readOrOpened! += m.readOrOpened;
    totals.clicked! += m.clicked;
    totals.failed! += m.failed;
    totals.bounced! += m.bounced;
    totals.complaints! += m.complaints;
    totals.optOuts! += m.optOuts;
  }

  const overall = computeRateMetrics(totals);

  return {
    ...overall,
    byChannel,
    timeframe,
  };
}
