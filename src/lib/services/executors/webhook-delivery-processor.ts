/**
 * WebhookDeliveryProcessor
 *
 * Neutral, BullMQ-free execution service for outgoing customer webhooks.
 * - Processes claimed WebhookDelivery records
 * - Signs payload with HMAC-SHA256
 * - Validates endpoints against SSRF protection
 * - Persists monotonic delivery states (DELIVERED, RETRYING, FAILED)
 */

import { processWebhookDeliveryQueue } from "../../webhooks/dispatcher";
import { logger } from "../../logger";

export interface ProcessWebhookQueueOptions {
  batchSize?: number;
}

export class WebhookDeliveryProcessor {
  /**
   * Processes a batch of queued or retrying webhook deliveries
   */
  static async processBatch(options?: ProcessWebhookQueueOptions) {
    const batchSize = options?.batchSize || 25;
    logger.info(`[WebhookDeliveryProcessor] Processing up to ${batchSize} webhook deliveries`);
    return await processWebhookDeliveryQueue({ batchSize });
  }
}
