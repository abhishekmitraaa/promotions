/**
 * AutomationExecutor
 *
 * Neutral, BullMQ-free execution service for campaign automation journeys & recurring automations.
 * - Advances multi-step journey steps (SEND_CAMPAIGN, DELAY, CONDITIONAL_BRANCH, WAIT_FOR_EVENT)
 * - Evaluates timeout deadlines on event gates
 * - Spawns child campaigns for recurring automations
 * - Wraps domain execution in standard JobError handling
 */

import { prisma } from "../../prisma";
import { EmailAutomationService } from "../email-automation-service";
import {
  RetryableError,
  PermanentError,
  classifyJobError,
} from "../../errors/job-errors";
import { logger } from "../../logger";

export interface ExecuteStepOptions {
  clientId: string;
  enrollmentId: string;
  stepId?: string;
  isTimeout?: boolean;
}

export interface ExecuteRecurringOptions {
  clientId: string;
  automationId: string;
}

export class AutomationExecutor {
  /**
   * Executes or advances a journey step for an enrolled contact
   */
  static async executeStep(options: ExecuteStepOptions) {
    const { clientId, enrollmentId, stepId, isTimeout } = options;

    logger.info(
      `[AutomationExecutor] Executing ${isTimeout ? "timeout" : "step"} for enrollment ${enrollmentId} (client: ${clientId})`
    );

    try {
      if (isTimeout && stepId) {
        return await EmailAutomationService.executeStepTimeout(clientId, enrollmentId, stepId);
      }
      return await EmailAutomationService.processEnrollmentStep(clientId, enrollmentId, stepId);
    } catch (err) {
      const classification = classifyJobError(err);
      if (classification.isRetryable) {
        throw new RetryableError(
          `Transient error in automation step: ${classification.message}`,
          classification.code
        );
      } else {
        throw new PermanentError(
          `Permanent error in automation step: ${classification.message}`,
          classification.code
        );
      }
    }
  }

  /**
   * Executes a recurring campaign automation check & trigger
   */
  static async executeRecurring(options: ExecuteRecurringOptions) {
    const { clientId, automationId } = options;

    logger.info(
      `[AutomationExecutor] Executing recurring automation ${automationId} (client: ${clientId})`
    );

    try {
      return await EmailAutomationService.executeRecurringStep(clientId, automationId);
    } catch (err) {
      const classification = classifyJobError(err);
      if (classification.isRetryable) {
        throw new RetryableError(
          `Transient error in recurring automation: ${classification.message}`,
          classification.code
        );
      } else {
        throw new PermanentError(
          `Permanent error in recurring automation: ${classification.message}`,
          classification.code
        );
      }
    }
  }

  /**
   * Finds enrollments where nextActionAt <= now and status is ACTIVE
   */
  static async findDueEnrollments(limit = 50) {
    const now = new Date();
    return prisma.emailAutomationEnrollment.findMany({
      where: {
        status: { in: ["ACTIVE", "WAITING"] },
        nextActionAt: { lte: now },
      },
      take: limit,
      orderBy: { nextActionAt: "asc" },
    });
  }

  /**
   * Finds recurring automations where nextRunAt <= now and status is ACTIVE
   */
  static async findDueRecurringAutomations(limit = 10) {
    const now = new Date();
    return prisma.emailAutomation.findMany({
      where: {
        status: "ACTIVE",
        triggerType: "RECURRING_SCHEDULE",
        nextRunAt: { lte: now },
      },
      take: limit,
      orderBy: { nextRunAt: "asc" },
    });
  }
}
