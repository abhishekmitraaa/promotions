/**
 * EmailEventProcessor
 *
 * Neutral, BullMQ-free execution service for incoming email provider webhook events.
 * - Processes persisted EmailEvent rows from PostgreSQL
 * - Monotonic delivery state progression
 * - Suppression list updates on bounce/complaint
 * - Campaign metric updates
 * - Automation journey event triggers
 * - Zero BullMQ coupling
 */

import { prisma } from "../../prisma";
import { EmailEventService } from "../email-event-service";
import {
  RetryableError,
  PermanentError,
  classifyJobError,
} from "../../errors/job-errors";
import { logger } from "../../logger";

export interface ProcessEmailEventOptions {
  eventId: string;
}

export class EmailEventProcessor {
  /**
   * Processes a single persisted EmailEvent
   */
  static async process(options: ProcessEmailEventOptions) {
    const { eventId } = options;

    logger.info(`[EmailEventProcessor] Processing event ${eventId}`);

    try {
      return await EmailEventService.processEventFromWorker(eventId);
    } catch (err) {
      const classification = classifyJobError(err);
      if (classification.isRetryable) {
        throw new RetryableError(
          `Transient error processing email event ${eventId}: ${classification.message}`,
          classification.code
        );
      } else {
        throw new PermanentError(
          `Permanent error processing email event ${eventId}: ${classification.message}`,
          classification.code
        );
      }
    }
  }

  /**
   * Finds pending or retrying email events ready for processing.
   * Excludes active PROCESSING events (only claims RECEIVED or stale abandoned PROCESSING >10m).
   */
  static async findPendingEvents(limit = 50) {
    const staleCutoff = new Date(Date.now() - 10 * 60 * 1000);
    return prisma.emailEvent.findMany({
      where: {
        attempts: { lt: 5 },
        OR: [
          { status: "RECEIVED" },
          {
            status: "PROCESSING",
            lastAttemptAt: { lt: staleCutoff },
          },
        ],
      },
      take: limit,
      orderBy: { createdAt: "asc" },
    });
  }
}
