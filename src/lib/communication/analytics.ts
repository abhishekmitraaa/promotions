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

  const safeRate = (numerator: number, denominator: number): number => {
    if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) {
      return 0.0;
    }
    const ratio = numerator / denominator;
    const clamped = Math.min(1.0, Math.max(0.0, ratio));
    return Number(clamped.toFixed(4));
  };

  const deliveryBasis = delivered > 0 ? delivered : sent;

  const deliveryRate = safeRate(delivered, sent);
  const readOrOpenRate = safeRate(readOrOpened, deliveryBasis);
  const clickThroughRate = safeRate(clicked, deliveryBasis);
  const clickToOpenRate = safeRate(clicked, readOrOpened);
  const bounceRate = safeRate(bounced, sent);
  const complaintRate = safeRate(complaints, deliveryBasis);
  const optOutRate = safeRate(optOuts, deliveryBasis);


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
  * Alias for computeRateMetrics for backward compatibility.
  */
export const computeUnifiedRates = computeRateMetrics;


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

/**
 * Alias for aggregateOmnichannelAnalytics for backward compatibility.
 */
export const buildUnifiedAnalyticsSummary = aggregateOmnichannelAnalytics;

