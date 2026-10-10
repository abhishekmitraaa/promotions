/**
 * Email Automation & Journey Engine
 *
 * Implements campaign automations built strictly on top of the existing campaign engine:
 * 1. Recurring Campaigns: cron / interval schedules, automatic child campaign creation, nextRunAt advance.
 * 2. Scheduled Journeys: multi-step sequential and branching DAG workflows.
 * 3. Delayed Follow-ups: durable delay steps via BullMQ delayed jobs and nextActionAt timestamps.
 * 4. Event-Triggered Automations: enrolls contacts and advances waiting steps upon email events (opens, clicks, delivery).
 * 5. Abandoned Workflow States: explicit terminal state with authoritative reasons (TIMEOUT_EXPIRED, UNSUBSCRIBED, SUPPRESSED, CRITERIA_MISMATCH, MANUAL_EXIT).
 * 6. Conditional Branches: engagement checks (opened/clicked previous step), contact attributes, and consent.
 * 7. Audience Re-evaluation Policies: ALWAYS_RE_EVALUATE, SNAPSHOT_ONCE, STRICT_CONSENT_ONLY.
 *
 * Architecture Constraints:
 * - Reuses existing BullMQ ("email-campaign" queue)
 * - Reuses existing PostgreSQL & Prisma models
 * - Reuses existing campaign state machine and recipient delivery engine
 * - Enforces real-time consent and suppression checks at every send and step
 * - Strictly isolated by tenant (clientId) at every query and operation
 * - Never creates a second campaign engine
 */

import { prisma } from "../prisma";
import {
  EmailAutomation,
  EmailAutomationEnrollment,
  EmailAutomationStatus,
  EmailAutomationTriggerType,
  AudienceReEvaluationPolicy,
  EmailEnrollmentStatus,
  EmailCampaignStatus,
  EmailType,
  EmailContact,
  Prisma,
} from "@prisma/client";
import { EmailCampaignService } from "./email-campaign-service";
import { EmailSuppressionService } from "./email-suppression-service";
import { EmailSegmentService, SegmentCriteria } from "./email-segment-service";
import { getCampaignQueue } from "../email/queue/queues";
import {
  JOB_NAMES,
  getCampaignJobId,
  getAutomationStepJobId,
  getRecurringAutomationJobId,
  CampaignJobData,
  AutomationJobData,
} from "../email/queue/types";
import { logger } from "../logger";

// =============================================================================
// Automation Journey & Step Types
// =============================================================================

export type JourneyStepType =
  | "SEND_CAMPAIGN"
  | "DELAY"
  | "CONDITIONAL_BRANCH"
  | "WAIT_FOR_EVENT"
  | "END";

export interface SendCampaignStepConfig {
  templateId?: string;
  templateVersionId?: string;
  subjectOverride?: string;
  senderIdentityId?: string;
  campaignNamePrefix?: string;
}

export interface DelayStepConfig {
  delayMinutes?: number;
  delayHours?: number;
  delayDays?: number;
  delayMs?: number;
}

export interface ConditionalBranchStepConfig {
  condition: {
    type: "EVENT_ENGAGEMENT" | "CONTACT_ATTRIBUTE" | "CONSENT_STATUS" | "LIST_MEMBERSHIP";
    // For EVENT_ENGAGEMENT:
    eventType?: "OPENED" | "CLICKED" | "DELIVERED";
    withinStepId?: string; // prior step id
    // For CONTACT_ATTRIBUTE:
    attributeKey?: string;
    operator?: "equals" | "not_equals" | "contains" | "greater_than" | "less_than";
    value?: unknown;
    // For LIST_MEMBERSHIP:
    listId?: string;
  };
  trueNextStepId: string;
  falseNextStepId: string;
}

export interface WaitForEventStepConfig {
  eventType: "OPENED" | "CLICKED" | "DELIVERED" | "CUSTOM";
  withinStepId?: string;
  timeoutMinutes?: number;
  timeoutHours?: number;
  timeoutNextStepId?: string; // If omitted and timeout expires -> ABANDONED (TIMEOUT_EXPIRED)
  nextStepId: string;
}

export interface JourneyStep {
  id: string;
  name: string;
  type: JourneyStepType;
  config?:
    | SendCampaignStepConfig
    | DelayStepConfig
    | ConditionalBranchStepConfig
    | WaitForEventStepConfig
    | Record<string, unknown>;
  nextStepId?: string | null;
}

export interface RecurringScheduleConfig {
  cronExpression?: string;
  intervalMinutes?: number;
  intervalDays?: number;
  runAtTime?: string; // "HH:MM" e.g. "09:00"
  maxRuns?: number;
  // Child campaign generation parameters:
  templateId?: string;
  templateVersionId?: string;
  listId?: string;
  segmentId?: string;
  senderIdentityId?: string;
  campaignNamePrefix?: string;
}

export interface EventTriggerConfig {
  eventType: "OPENED" | "CLICKED" | "DELIVERED" | "CONTACT_CREATED" | "CUSTOM";
  filter?: Record<string, unknown>;
  segmentId?: string;
  listId?: string;
}

export type AutomationTriggerConfig =
  | RecurringScheduleConfig
  | EventTriggerConfig
  | { segmentId?: string; listId?: string };

export interface CreateAutomationInput {
  name: string;
  description?: string | null;
  triggerType: EmailAutomationTriggerType;
  triggerConfig?: AutomationTriggerConfig;
  reEvaluationPolicy?: AudienceReEvaluationPolicy;
  steps: JourneyStep[];
}

export interface UpdateAutomationInput {
  name?: string;
  description?: string | null;
  triggerType?: EmailAutomationTriggerType;
  triggerConfig?: AutomationTriggerConfig;
  reEvaluationPolicy?: AudienceReEvaluationPolicy;
  steps?: JourneyStep[];
}

export interface EnrollmentContextData {
  stepHistory: Array<{
    stepId: string;
    type: JourneyStepType;
    executedAt: string;
    campaignId?: string;
    recipientId?: string;
    details?: Record<string, unknown>;
  }>;
  branchDecisions: Record<string, { decision: boolean; timestamp: string }>;
  initialSnapshotRecipientIds?: string[];
  variables?: Record<string, unknown>;
}

// Abandonment Reasons Enum / Constants
export const ABANDON_REASONS = {
  TIMEOUT_EXPIRED: "TIMEOUT_EXPIRED",
  UNSUBSCRIBED: "UNSUBSCRIBED",
  SUPPRESSED: "SUPPRESSED",
  CRITERIA_MISMATCH: "CRITERIA_MISMATCH",
  MANUAL_EXIT: "MANUAL_EXIT",
  FAILED_DELIVERY: "FAILED_DELIVERY",
} as const;

export type AbandonReason = (typeof ABANDON_REASONS)[keyof typeof ABANDON_REASONS];

// =============================================================================
// Helper: Cron & Interval Math
// =============================================================================

/**
 * Calculates the next execution timestamp based on cron or interval schedule.
 */
export function calculateNextRunTime(
  config: RecurringScheduleConfig,
  fromDate: Date = new Date()
): Date | null {
  const fromMs = fromDate.getTime();

  // 1. Direct Interval in Minutes
  if (config.intervalMinutes && config.intervalMinutes > 0) {
    return new Date(fromMs + config.intervalMinutes * 60 * 1000);
  }

  // 2. Direct Interval in Days
  if (config.intervalDays && config.intervalDays > 0) {
    const next = new Date(fromMs + config.intervalDays * 24 * 60 * 60 * 1000);
    if (config.runAtTime) {
      const [h, m] = config.runAtTime.split(":").map((v) => parseInt(v, 10));
      if (!isNaN(h) && !isNaN(m)) {
        next.setUTCHours(h, m, 0, 0);
      }
    }
    return next;
  }

  // 3. Cron Expression Evaluation (5-field: minute, hour, dayOfMonth, month, dayOfWeek)
  if (config.cronExpression) {
    return parseNextCronOccurrence(config.cronExpression, fromDate);
  }

  return null;
}

/**
 * Lightweight, deterministic 5-field cron occurrence evaluator.
 * Format: minute (0-59), hour (0-23), day of month (1-31), month (1-12), day of week (0-6, 0=Sun).
 */
export function parseNextCronOccurrence(cron: string, fromDate: Date = new Date()): Date {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) {
    // Fallback: 1 day later
    return new Date(fromDate.getTime() + 24 * 60 * 60 * 1000);
  }

  const [minPart, hrPart, domPart, monPart, dowPart] = parts;

  function matchesField(val: number, field: string, minVal: number, maxVal: number): boolean {
    if (field === "*") return true;
    if (field.startsWith("*/")) {
      const step = parseInt(field.slice(2), 10);
      return !isNaN(step) && step > 0 && (val - minVal) % step === 0;
    }
    if (field.includes(",")) {
      return field.split(",").some((sub) => matchesField(val, sub, minVal, maxVal));
    }
    if (field.includes("-")) {
      const [start, end] = field.split("-").map((v) => parseInt(v, 10));
      return val >= start && val <= end;
    }
    return parseInt(field, 10) === val;
  }

  // Search forward minute by minute up to 365 days
  const candidate = new Date(fromDate.getTime() + 60 * 1000);
  candidate.setUTCSeconds(0, 0);

  const maxIterations = 365 * 24 * 60; // 1 year limit
  for (let i = 0; i < maxIterations; i++) {
    const min = candidate.getUTCMinutes();
    const hr = candidate.getUTCHours();
    const dom = candidate.getUTCDate();
    const mon = candidate.getUTCMonth() + 1;
    const dow = candidate.getUTCDay();

    if (
      matchesField(min, minPart, 0, 59) &&
      matchesField(hr, hrPart, 0, 23) &&
      matchesField(dom, domPart, 1, 31) &&
      matchesField(mon, monPart, 1, 12) &&
      matchesField(dow, dowPart, 0, 6)
    ) {
      return candidate;
    }

    candidate.setTime(candidate.getTime() + 60 * 1000);
  }

  return new Date(fromDate.getTime() + 24 * 60 * 60 * 1000);
}

// =============================================================================
// Email Automation Service Implementation
// =============================================================================

export class EmailAutomationService {
  /**
   * Validates journey steps structure (DAG integrity, step names, types, targets, cycle detection, depth, and reachability).
   */
  static validateSteps(steps: unknown): JourneyStep[] {
    if (!Array.isArray(steps) || steps.length === 0) {
      throw new Error("Automation steps must be a non-empty array.");
    }

    const stepIdSet = new Set<string>();
    const typedSteps: JourneyStep[] = [];

    // Phase 1: Structure, unique IDs, types, and step-level config
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (!step || typeof step !== "object") {
        throw new Error(`Invalid step definition at index ${i}: step must be an object.`);
      }
      const s = step as Partial<JourneyStep>;
      if (!s.id || typeof s.id !== "string" || !s.id.trim()) {
        throw new Error(`Step at index ${i} must have a unique non-empty string 'id'.`);
      }
      const cleanId = s.id.trim();
      if (stepIdSet.has(cleanId)) {
        throw new Error(`Duplicate step id '${cleanId}' detected.`);
      }
      stepIdSet.add(cleanId);

      const validTypes: JourneyStepType[] = [
        "SEND_CAMPAIGN",
        "DELAY",
        "CONDITIONAL_BRANCH",
        "WAIT_FOR_EVENT",
        "END",
      ];
      if (!s.type || !validTypes.includes(s.type)) {
        throw new Error(
          `Invalid step type '${s.type}' for step '${cleanId}'. Valid types: ${validTypes.join(", ")}`
        );
      }

      typedSteps.push({
        id: cleanId,
        name: s.name ? String(s.name).trim() : `Step ${cleanId}`,
        type: s.type,
        config: (s.config || {}) as JourneyStep["config"],
        nextStepId: s.nextStepId ? String(s.nextStepId).trim() : null,
      });
    }

    // Build adjacency list for graph analysis
    const adjacencyList = new Map<string, string[]>();
    for (const step of typedSteps) {
      adjacencyList.set(step.id, []);
    }

    for (const s of typedSteps) {
      const outEdges: string[] = [];

      switch (s.type) {
        case "SEND_CAMPAIGN": {
          const cfg = (s.config || {}) as SendCampaignStepConfig;
          if (!cfg.templateId && !cfg.templateVersionId) {
            throw new Error(`SEND_CAMPAIGN step '${s.id}' requires either 'templateId' or 'templateVersionId'.`);
          }
          if (s.nextStepId) {
            if (s.nextStepId === s.id) {
              throw new Error(`Self-referential edge detected: step '${s.id}' points to itself.`);
            }
            if (!stepIdSet.has(s.nextStepId)) {
              throw new Error(`Step '${s.id}' references non-existent nextStepId '${s.nextStepId}'.`);
            }
            outEdges.push(s.nextStepId);
          }
          break;
        }

        case "DELAY": {
          const delayConfig = (s.config || {}) as DelayStepConfig;
          const hasDuration = Boolean(
            (delayConfig.delayMinutes && delayConfig.delayMinutes > 0) ||
            (delayConfig.delayHours && delayConfig.delayHours > 0) ||
            (delayConfig.delayDays && delayConfig.delayDays > 0) ||
            (delayConfig.delayMs && delayConfig.delayMs > 0)
          );
          if (!hasDuration) {
            throw new Error(`DELAY step '${s.id}' must specify a positive delay duration.`);
          }
          if (!s.nextStepId) {
            throw new Error(`DELAY step '${s.id}' must specify a valid nextStepId continuation. Dangling delay steps are forbidden.`);
          }
          if (s.nextStepId === s.id) {
            throw new Error(`Self-referential edge detected: DELAY step '${s.id}' points to itself.`);
          }
          if (!stepIdSet.has(s.nextStepId)) {
            throw new Error(`DELAY step '${s.id}' references non-existent nextStepId '${s.nextStepId}'.`);
          }
          outEdges.push(s.nextStepId);
          break;
        }

        case "CONDITIONAL_BRANCH": {
          const branchConfig = s.config as ConditionalBranchStepConfig | undefined;
          if (!branchConfig || !branchConfig.trueNextStepId || !branchConfig.falseNextStepId) {
            throw new Error(
              `CONDITIONAL_BRANCH step '${s.id}' requires 'trueNextStepId' and 'falseNextStepId'.`
            );
          }
          const trueTarget = String(branchConfig.trueNextStepId).trim();
          const falseTarget = String(branchConfig.falseNextStepId).trim();

          if (trueTarget === s.id || falseTarget === s.id) {
            throw new Error(`Self-referential edge detected: CONDITIONAL_BRANCH step '${s.id}' points to itself.`);
          }
          if (!stepIdSet.has(trueTarget)) {
            throw new Error(`CONDITIONAL_BRANCH step '${s.id}' references non-existent trueNextStepId '${trueTarget}'.`);
          }
          if (!stepIdSet.has(falseTarget)) {
            throw new Error(`CONDITIONAL_BRANCH step '${s.id}' references non-existent falseNextStepId '${falseTarget}'.`);
          }
          outEdges.push(trueTarget);
          outEdges.push(falseTarget);
          break;
        }

        case "WAIT_FOR_EVENT": {
          const waitConfig = s.config as WaitForEventStepConfig | undefined;
          if (!waitConfig || !waitConfig.nextStepId) {
            throw new Error(`WAIT_FOR_EVENT step '${s.id}' requires 'nextStepId'.`);
          }
          const nextTarget = String(waitConfig.nextStepId).trim();
          if (nextTarget === s.id) {
            throw new Error(`Self-referential edge detected: WAIT_FOR_EVENT step '${s.id}' points to itself.`);
          }
          if (!stepIdSet.has(nextTarget)) {
            throw new Error(`WAIT_FOR_EVENT step '${s.id}' references non-existent nextStepId '${nextTarget}'.`);
          }
          outEdges.push(nextTarget);

          if (waitConfig.timeoutNextStepId) {
            const timeoutTarget = String(waitConfig.timeoutNextStepId).trim();
            if (timeoutTarget === s.id) {
              throw new Error(`Self-referential edge detected: WAIT_FOR_EVENT timeout step '${s.id}' points to itself.`);
            }
            if (!stepIdSet.has(timeoutTarget)) {
              throw new Error(`WAIT_FOR_EVENT step '${s.id}' references non-existent timeoutNextStepId '${timeoutTarget}'.`);
            }
            outEdges.push(timeoutTarget);
          }
          break;
        }

        case "END": {
          if (s.nextStepId) {
            throw new Error(`END step '${s.id}' cannot have outgoing nextStepId.`);
          }
          break;
        }
      }

      adjacencyList.set(s.id, outEdges);
    }

    // Phase 2: Cycle Detection using Depth-First Search with 3-color node state
    // 0 = UNVISITED, 1 = VISITING (in current recursion stack), 2 = VISITED
    const visitState = new Map<string, number>();
    for (const step of typedSteps) {
      visitState.set(step.id, 0);
    }

    function checkCycle(nodeId: string, pathStack: string[]): void {
      visitState.set(nodeId, 1);
      pathStack.push(nodeId);

      const neighbors = adjacencyList.get(nodeId) || [];
      for (const neighbor of neighbors) {
        const state = visitState.get(neighbor);
        if (state === 1) {
          const cyclePath = [...pathStack, neighbor].join(" -> ");
          throw new Error(`Cycle detected in automation workflow graph: ${cyclePath}.`);
        }
        if (state === 0) {
          checkCycle(neighbor, pathStack);
        }
      }

      pathStack.pop();
      visitState.set(nodeId, 2);
    }

    for (const step of typedSteps) {
      if (visitState.get(step.id) === 0) {
        checkCycle(step.id, []);
      }
    }

    // Phase 3: Reachability Analysis from Root Node (step[0])
    const rootId = typedSteps[0].id;
    const reachable = new Set<string>();
    const queue = [rootId];
    reachable.add(rootId);

    while (queue.length > 0) {
      const curr = queue.shift()!;
      const neighbors = adjacencyList.get(curr) || [];
      for (const next of neighbors) {
        if (!reachable.has(next)) {
          reachable.add(next);
          queue.push(next);
        }
      }
    }

    const unreachable = typedSteps.filter((s) => !reachable.has(s.id)).map((s) => s.id);
    if (unreachable.length > 0) {
      throw new Error(`Unreachable step(s) detected: ${unreachable.join(", ")}. All steps must be reachable from root.`);
    }

    // Phase 4: Bounded Graph Depth (Max 50 steps from root)
    const MAX_GRAPH_DEPTH = 50;
    function computeMaxDepth(nodeId: string, currentDepth: number): number {
      if (currentDepth > MAX_GRAPH_DEPTH) {
        throw new Error(`Workflow graph exceeds maximum allowed depth of ${MAX_GRAPH_DEPTH}.`);
      }
      const neighbors = adjacencyList.get(nodeId) || [];
      if (neighbors.length === 0) return currentDepth;
      let maxSub = currentDepth;
      for (const next of neighbors) {
        const d = computeMaxDepth(next, currentDepth + 1);
        if (d > maxSub) maxSub = d;
      }
      return maxSub;
    }
    computeMaxDepth(rootId, 1);

    // Phase 5: Terminal Path Validation (Every path must be able to terminate)
    const hasTerminal = typedSteps.some((s) => (adjacencyList.get(s.id) || []).length === 0);
    if (!hasTerminal) {
      throw new Error("Workflow graph has no valid terminal path. At least one terminal step (e.g. END) is required.");
    }

    return typedSteps;
  }

  /**
   * Validates trigger configuration according to triggerType.
   */
  static validateTriggerConfig(triggerType: EmailAutomationTriggerType, triggerConfig?: unknown): void {
    if (triggerType === EmailAutomationTriggerType.RECURRING_SCHEDULE) {
      if (!triggerConfig || typeof triggerConfig !== "object") {
        throw new Error("RECURRING_SCHEDULE automation requires 'triggerConfig' object.");
      }
      const cfg = triggerConfig as RecurringScheduleConfig;
      if (!cfg.cronExpression && (!cfg.intervalMinutes || cfg.intervalMinutes <= 0) && (!cfg.intervalDays || cfg.intervalDays <= 0)) {
        throw new Error("RECURRING_SCHEDULE trigger requires a valid 'cronExpression', 'intervalMinutes', or 'intervalDays'.");
      }
    }
    if (triggerType === EmailAutomationTriggerType.EVENT_TRIGGERED) {
      if (!triggerConfig || typeof triggerConfig !== "object") {
        throw new Error("EVENT_TRIGGERED automation requires 'triggerConfig' object.");
      }
      const cfg = triggerConfig as EventTriggerConfig;
      if (!cfg.eventType || typeof cfg.eventType !== "string") {
        throw new Error("EVENT_TRIGGERED trigger requires a valid 'eventType'.");
      }
    }
  }

  /**
   * Validates referenced resources (template, list, segment, sender) under the same tenant.
   */
  static async validateAutomationResources(
    clientId: string,
    input: CreateAutomationInput | UpdateAutomationInput
  ): Promise<void> {
    if (input.triggerConfig) {
      const tc = input.triggerConfig as Record<string, unknown>;
      if (tc.segmentId) {
        const seg = await prisma.emailSegment.findFirst({ where: { id: tc.segmentId, clientId } });
        if (!seg) throw new Error(`Referenced segment '${tc.segmentId}' not found for tenant '${clientId}'.`);
      }
      if (tc.listId) {
        const list = await prisma.emailList.findFirst({ where: { id: tc.listId, clientId } });
        if (!list) throw new Error(`Referenced list '${tc.listId}' not found for tenant '${clientId}'.`);
      }
    }

    if (input.steps && Array.isArray(input.steps)) {
      for (const step of input.steps) {
        if (step.type === "SEND_CAMPAIGN" && step.config) {
          const sc = step.config as SendCampaignStepConfig;
          if (sc.templateId) {
            const tpl = await prisma.emailTemplate.findFirst({ where: { id: sc.templateId, clientId } });
            if (!tpl) throw new Error(`Referenced template '${sc.templateId}' in step '${step.id}' not found for tenant '${clientId}'.`);
          }
          if (sc.senderIdentityId) {
            const sender = await prisma.emailSenderIdentity.findFirst({ where: { id: sc.senderIdentityId, clientId } });
            if (!sender) throw new Error(`Referenced sender identity '${sc.senderIdentityId}' in step '${step.id}' not found for tenant '${clientId}'.`);
          }
        }
      }
    }
  }

  // ===========================================================================
  // 1. CRUD & Lifecycle Management
  // ===========================================================================

  /**
   * Creates a new campaign automation for a tenant.
   */
  static async createAutomation(
    clientId: string,
    input: CreateAutomationInput
  ): Promise<EmailAutomation> {
    if (!clientId) throw new Error("clientId is required");
    const name = input.name?.trim();
    if (!name) throw new Error("Automation name is required");

    const validatedSteps = this.validateSteps(input.steps);
    this.validateTriggerConfig(input.triggerType, input.triggerConfig);
    await this.validateAutomationResources(clientId, input);

    // Check duplicate name per tenant
    const existing = await prisma.emailAutomation.findUnique({
      where: { clientId_name: { clientId, name } },
    });
    if (existing) {
      throw new Error(`Automation '${name}' already exists for this tenant.`);
    }

    // Calculate initial nextRunAt for recurring automations
    let nextRunAt: Date | null = null;
    if (input.triggerType === EmailAutomationTriggerType.RECURRING_SCHEDULE && input.triggerConfig) {
      nextRunAt = calculateNextRunTime(input.triggerConfig as RecurringScheduleConfig);
    }

    return prisma.emailAutomation.create({
      data: {
        clientId,
        name,
        description: input.description?.trim() || null,
        status: EmailAutomationStatus.DRAFT,
        triggerType: input.triggerType,
        triggerConfig: input.triggerConfig ? JSON.stringify(input.triggerConfig) : null,
        reEvaluationPolicy: input.reEvaluationPolicy || AudienceReEvaluationPolicy.ALWAYS_RE_EVALUATE,
        steps: JSON.stringify(validatedSteps),
        nextRunAt,
      },
    });
  }

  /**
   * Retrieves an automation by ID strictly scoped to tenant.
   */
  static async getAutomationById(
    clientId: string,
    automationId: string
  ): Promise<EmailAutomation | null> {
    if (!clientId || !automationId) return null;
    return prisma.emailAutomation.findFirst({
      where: { id: automationId, clientId },
    });
  }

  /**
   * Lists all automations for a tenant.
   */
  static async listAutomations(
    clientId: string,
    query?: { status?: EmailAutomationStatus }
  ): Promise<EmailAutomation[]> {
    if (!clientId) throw new Error("clientId is required");
    const where: Prisma.EmailAutomationWhereInput = { clientId };
    if (query?.status) where.status = query.status;

    return prisma.emailAutomation.findMany({
      where,
      orderBy: { createdAt: "desc" },
    });
  }

  /**
   * Updates an existing automation with full DAG, trigger, and resource validation.
   */
  static async updateAutomation(
    clientId: string,
    automationId: string,
    input: UpdateAutomationInput
  ): Promise<EmailAutomation> {
    const existing = await this.getAutomationById(clientId, automationId);
    if (!existing) {
      throw new Error(`Automation '${automationId}' not found for tenant '${clientId}'.`);
    }

    const data: Prisma.EmailAutomationUpdateInput = {};

    if (input.name !== undefined) {
      const cleanName = input.name.trim();
      if (!cleanName) throw new Error("Automation name cannot be empty");
      if (cleanName !== existing.name) {
        const dup = await prisma.emailAutomation.findUnique({
          where: { clientId_name: { clientId, name: cleanName } },
        });
        if (dup) throw new Error(`Automation name '${cleanName}' is already taken.`);
        data.name = cleanName;
      }
    }

    if (input.description !== undefined) {
      data.description = input.description?.trim() || null;
    }

    if (input.triggerType !== undefined) {
      data.triggerType = input.triggerType;
    }

    if (input.triggerConfig !== undefined) {
      data.triggerConfig = JSON.stringify(input.triggerConfig);
      if (
        (input.triggerType || existing.triggerType) === EmailAutomationTriggerType.RECURRING_SCHEDULE
      ) {
        data.nextRunAt = calculateNextRunTime(input.triggerConfig as RecurringScheduleConfig);
      }
    }

    if (input.triggerType || input.triggerConfig) {
      this.validateTriggerConfig(
        input.triggerType || existing.triggerType,
        input.triggerConfig !== undefined ? input.triggerConfig : (existing.triggerConfig ? JSON.parse(existing.triggerConfig) : undefined)
      );
    }

    if (input.reEvaluationPolicy !== undefined) {
      data.reEvaluationPolicy = input.reEvaluationPolicy;
    }

    if (input.steps !== undefined) {
      const validated = this.validateSteps(input.steps);
      data.steps = JSON.stringify(validated);
    }

    await this.validateAutomationResources(clientId, input);

    return prisma.emailAutomation.update({
      where: { id: existing.id },
      data,
    });
  }

  /**
   * Activates an automation and recovers/reschedules any paused or overdue enrollments.
   */
  static async activateAutomation(clientId: string, automationId: string): Promise<EmailAutomation> {
    const automation = await this.getAutomationById(clientId, automationId);
    if (!automation) {
      throw new Error(`Automation '${automationId}' not found for tenant '${clientId}'.`);
    }

    let nextRunAt = automation.nextRunAt;
    if (automation.triggerType === EmailAutomationTriggerType.RECURRING_SCHEDULE) {
      const config: RecurringScheduleConfig = automation.triggerConfig
        ? JSON.parse(automation.triggerConfig)
        : {};
      if (!nextRunAt || nextRunAt.getTime() <= Date.now()) {
        nextRunAt = calculateNextRunTime(config, new Date());
      }

      // Enqueue recurring trigger job on BullMQ
      if (nextRunAt) {
        const delayMs = Math.max(0, nextRunAt.getTime() - Date.now());
        const queue = getCampaignQueue();
        const jobId = getRecurringAutomationJobId(automation.id, automation.executionCount + 1);

        await queue.add(
          JOB_NAMES.TRIGGER_RECURRING_AUTOMATION,
          {
            automationId: automation.id,
            clientId,
            recurrenceIndex: automation.executionCount + 1,
          } as AutomationJobData,
          {
            delay: delayMs,
            jobId,
          }
        );
      }
    }

    // Recover paused enrollments for this automation so they are not permanently stranded
    const pausedEnrollments = await prisma.emailAutomationEnrollment.findMany({
      where: {
        automationId: automation.id,
        status: EmailEnrollmentStatus.PAUSED,
      },
    });

    const queue = getCampaignQueue();
    for (const enrollment of pausedEnrollments) {
      const isWaitingStep = Boolean(
        enrollment.currentStepId &&
        enrollment.nextActionAt &&
        enrollment.nextActionAt.getTime() > Date.now()
      );
      const newStatus = isWaitingStep ? EmailEnrollmentStatus.WAITING : EmailEnrollmentStatus.ACTIVE;

      await prisma.emailAutomationEnrollment.update({
        where: { id: enrollment.id },
        data: { status: newStatus },
      });

      if (!isWaitingStep && enrollment.currentStepId) {
        const jobId = getAutomationStepJobId(enrollment.id, enrollment.currentStepId);
        await queue.add(
          JOB_NAMES.PROCESS_AUTOMATION_STEP,
          {
            automationId: automation.id,
            enrollmentId: enrollment.id,
            clientId,
            stepId: enrollment.currentStepId,
          } as AutomationJobData,
          { jobId }
        );
      }
    }

    return prisma.emailAutomation.update({
      where: { id: automation.id },
      data: {
        status: EmailAutomationStatus.ACTIVE,
        nextRunAt,
      },
    });
  }

  /**
   * Pauses an active automation and marks active/waiting enrollments as PAUSED.
   */
  static async pauseAutomation(clientId: string, automationId: string): Promise<EmailAutomation> {
    const automation = await this.getAutomationById(clientId, automationId);
    if (!automation) {
      throw new Error(`Automation '${automationId}' not found for tenant '${clientId}'.`);
    }

    // Mark active and waiting enrollments as PAUSED
    await prisma.emailAutomationEnrollment.updateMany({
      where: {
        automationId: automation.id,
        status: { in: [EmailEnrollmentStatus.ACTIVE, EmailEnrollmentStatus.WAITING] },
      },
      data: {
        status: EmailEnrollmentStatus.PAUSED,
      },
    });

    return prisma.emailAutomation.update({
      where: { id: automation.id },
      data: { status: EmailAutomationStatus.PAUSED },
    });
  }

  /**
   * Archives an automation.
   */
  static async archiveAutomation(clientId: string, automationId: string): Promise<EmailAutomation> {
    const automation = await this.getAutomationById(clientId, automationId);
    if (!automation) {
      throw new Error(`Automation '${automationId}' not found for tenant '${clientId}'.`);
    }

    return prisma.emailAutomation.update({
      where: { id: automation.id },
      data: { status: EmailAutomationStatus.ARCHIVED },
    });
  }

  /**
   * Deletes an automation.
   */
  static async deleteAutomation(
    clientId: string,
    automationId: string
  ): Promise<{ deleted: boolean }> {
    const automation = await this.getAutomationById(clientId, automationId);
    if (!automation) {
      throw new Error(`Automation '${automationId}' not found for tenant '${clientId}'.`);
    }

    await prisma.emailAutomation.delete({
      where: { id: automation.id },
    });

    return { deleted: true };
  }

  // ===========================================================================
  // 2. Recipient Enrollment & Management
  // ===========================================================================

  /**
   * Enrolls a single contact into an automation journey.
   * Enforces tenant boundary, deduplication, consent, and suppression.
   */
  static async enrollContact(
    clientId: string,
    automationId: string,
    contactId: string,
    contextData: Record<string, unknown> = {}
  ): Promise<EmailAutomationEnrollment> {
    const [automation, contact] = await Promise.all([
      this.getAutomationById(clientId, automationId),
      prisma.emailContact.findFirst({
        where: { id: contactId, clientId },
      }),
    ]);

    if (!automation) {
      throw new Error(`Automation '${automationId}' not found for tenant '${clientId}'.`);
    }
    if (!contact) {
      throw new Error(`Contact '${contactId}' not found for tenant '${clientId}'.`);
    }

    // Check existing enrollment
    const existing = await prisma.emailAutomationEnrollment.findUnique({
      where: { automationId_contactId: { automationId, contactId } },
    });
    if (existing) {
      if (
        existing.status === EmailEnrollmentStatus.ACTIVE ||
        existing.status === EmailEnrollmentStatus.WAITING ||
        existing.status === EmailEnrollmentStatus.PAUSED
      ) {
        return existing; // Already actively enrolled
      }

      // Re-entry Policy Guard: By default, do NOT re-enroll completed or abandoned contacts.
      const triggerCfg = (automation.triggerConfig ? JSON.parse(automation.triggerConfig) : {}) as Record<string, unknown>;
      const allowReentry = Boolean(triggerCfg.allowReentry);

      if (!allowReentry) {
        logger.info(
          `[Automation:Reentry] Contact '${contactId}' previously completed or abandoned automation '${automationId}'. Re-entry is disabled. Skipping.`
        );
        return existing;
      }

      // Cooldown protection (default minimum 60 minutes)
      const cooldownMinutes = typeof triggerCfg.reentryCooldownMinutes === "number" ? triggerCfg.reentryCooldownMinutes : 60;
      const lastFinished = existing.completedAt || existing.abandonedAt || existing.updatedAt;
      if (lastFinished && Date.now() - lastFinished.getTime() < cooldownMinutes * 60 * 1000) {
        logger.info(
          `[Automation:Reentry] Contact '${contactId}' within cooldown (${cooldownMinutes}m) for automation '${automationId}'. Skipping.`
        );
        return existing;
      }

      // Re-enroll if policy explicitly permits and cooldown passed
      return this.resetAndStartEnrollment(clientId, existing.id, automation, contact, contextData);
    }

    // Parse steps to get starting step
    const steps: JourneyStep[] = JSON.parse(automation.steps);
    const firstStep = steps[0];
    if (!firstStep) {
      throw new Error(`Automation '${automationId}' has no steps.`);
    }

    // Authoritative Consent & Suppression check
    if (!contact.hasMarketingConsent) {
      return prisma.emailAutomationEnrollment.create({
        data: {
          automationId,
          contactId,
          clientId,
          currentStepId: null,
          status: EmailEnrollmentStatus.ABANDONED,
          abandonedReason: ABANDON_REASONS.UNSUBSCRIBED,
          abandonedAt: new Date(),
          contextData: JSON.stringify({
            stepHistory: [],
            branchDecisions: {},
            reason: "Initial enrollment rejected: contact has no marketing consent",
          }),
        },
      });
    }

    const suppCheck = await EmailSuppressionService.isSuppressed(clientId, contact.email);
    if (suppCheck.suppressed) {
      return prisma.emailAutomationEnrollment.create({
        data: {
          automationId,
          contactId,
          clientId,
          currentStepId: null,
          status: EmailEnrollmentStatus.ABANDONED,
          abandonedReason: ABANDON_REASONS.SUPPRESSED,
          abandonedAt: new Date(),
          contextData: JSON.stringify({
            stepHistory: [],
            branchDecisions: {},
            reason: `Initial enrollment rejected: contact is suppressed (${suppCheck.reason || "SUPPRESSED"})`,
          }),
        },
      });
    }

    // Create active enrollment
    const initialContext: EnrollmentContextData = {
      stepHistory: [],
      branchDecisions: {},
      variables: contextData,
    };

    const enrollment = await prisma.emailAutomationEnrollment.create({
      data: {
        automationId,
        contactId,
        clientId,
        currentStepId: firstStep.id,
        status: EmailEnrollmentStatus.ACTIVE,
        contextData: JSON.stringify(initialContext),
        nextActionAt: new Date(),
      },
    });

    // Update automation active enrollment count
    await prisma.emailAutomation.update({
      where: { id: automation.id },
      data: { activeEnrollmentsCount: { increment: 1 } },
    });

    // Process first step asynchronously or synchronously if active
    if (automation.status === EmailAutomationStatus.ACTIVE) {
      await this.processEnrollmentStep(clientId, enrollment.id, firstStep.id);
    }

    return prisma.emailAutomationEnrollment.findUniqueOrThrow({
      where: { id: enrollment.id },
    });
  }

  /**
   * Resets and re-starts an enrollment that previously completed or abandoned.
   */
  private static async resetAndStartEnrollment(
    clientId: string,
    enrollmentId: string,
    automation: EmailAutomation,
    contact: EmailContact,
    contextData: Record<string, unknown>
  ): Promise<EmailAutomationEnrollment> {
    const steps: JourneyStep[] = JSON.parse(automation.steps);
    const firstStep = steps[0];

    const initialContext: EnrollmentContextData = {
      stepHistory: [],
      branchDecisions: {},
      variables: contextData,
    };

    const updated = await prisma.emailAutomationEnrollment.update({
      where: { id: enrollmentId },
      data: {
        currentStepId: firstStep?.id || null,
        status: EmailEnrollmentStatus.ACTIVE,
        abandonedReason: null,
        abandonedAt: null,
        completedAt: null,
        contextData: JSON.stringify(initialContext),
        nextActionAt: new Date(),
      },
    });

    await prisma.emailAutomation.update({
      where: { id: automation.id },
      data: { activeEnrollmentsCount: { increment: 1 } },
    });

    if (automation.status === EmailAutomationStatus.ACTIVE && firstStep) {
      await this.processEnrollmentStep(clientId, updated.id, firstStep.id);
    }

    return prisma.emailAutomationEnrollment.findUniqueOrThrow({
      where: { id: enrollmentId },
    });
  }

  /**
   * Enrolls an entire audience (segment or list) into an automation.
   */
  static async enrollAudience(
    clientId: string,
    automationId: string,
    options?: { segmentId?: string; listId?: string }
  ): Promise<{ enrolledCount: number; skippedCount: number }> {
    const automation = await this.getAutomationById(clientId, automationId);
    if (!automation) {
      throw new Error(`Automation '${automationId}' not found for tenant '${clientId}'.`);
    }

    const config: Record<string, unknown> = automation.triggerConfig
      ? JSON.parse(automation.triggerConfig)
      : {};
    const segmentId = options?.segmentId || (config.segmentId as string | undefined);
    const listId = options?.listId || (config.listId as string | undefined);

    let contacts: EmailContact[] = [];

    if (segmentId) {
      const segment = await EmailSegmentService.getSegmentById(clientId, segmentId);
      if (!segment) throw new Error(`Segment '${segmentId}' not found.`);
      const criteria = JSON.parse(segment.criteria);
      const preview = await EmailSegmentService.previewContacts(clientId, criteria, { limit: 10000 });
      contacts = preview.sampleContacts;
    } else if (listId) {
      contacts = await prisma.emailContact.findMany({
        where: {
          clientId,
          listMemberships: {
            some: { listId, status: "SUBSCRIBED" },
          },
        },
      });
    } else {
      // All subscribed contacts with consent
      contacts = await prisma.emailContact.findMany({
        where: { clientId, status: "SUBSCRIBED" },
      });
    }

    let enrolledCount = 0;
    let skippedCount = 0;

    for (const contact of contacts) {
      try {
        const res = await this.enrollContact(clientId, automationId, contact.id);
        if (res.status === EmailEnrollmentStatus.ACTIVE || res.status === EmailEnrollmentStatus.WAITING) {
          enrolledCount++;
        } else {
          skippedCount++;
        }
      } catch {
        skippedCount++;
      }
    }

    return { enrolledCount, skippedCount };
  }

  /**
   * Transitions an enrollment explicitly to ABANDONED state with a documented reason.
   */
  static async abandonEnrollment(
    clientId: string,
    enrollmentId: string,
    reason: AbandonReason | string
  ): Promise<EmailAutomationEnrollment> {
    const enrollment = await prisma.emailAutomationEnrollment.findFirst({
      where: { id: enrollmentId, clientId },
    });
    if (!enrollment) {
      throw new Error(`Enrollment '${enrollmentId}' not found for tenant '${clientId}'.`);
    }

    if (enrollment.status === EmailEnrollmentStatus.ABANDONED) {
      return enrollment; // Already abandoned
    }

    const updated = await prisma.emailAutomationEnrollment.update({
      where: { id: enrollment.id },
      data: {
        status: EmailEnrollmentStatus.ABANDONED,
        abandonedReason: reason,
        abandonedAt: new Date(),
        currentStepId: null,
      },
    });

    await prisma.emailAutomation.update({
      where: { id: enrollment.automationId },
      data: {
        activeEnrollmentsCount: { decrement: 1 },
        abandonedEnrollmentsCount: { increment: 1 },
      },
    });

    logger.info(
      `[Automation] Enrollment ${enrollmentId} abandoned with reason: '${reason}' (tenant: ${clientId})`
    );

    return updated;
  }

  // ===========================================================================
  // 3. Core Journey Step Execution Engine
  // ===========================================================================

  /**
   * Processes a specific journey step for an enrolled contact.
   * Evaluates audience re-evaluation policies, consent, suppression,
   * dispatches campaigns via the existing campaign engine, handles delays,
   * evaluates branches, and advances state machine.
   */
  static async processEnrollmentStep(
    clientId: string,
    enrollmentId: string,
    targetStepId?: string
  ): Promise<{
    status: EmailEnrollmentStatus;
    stepId?: string | null;
    abandonedReason?: string | null;
  }> {
    const enrollment = await prisma.emailAutomationEnrollment.findFirst({
      where: { id: enrollmentId, clientId },
      include: {
        automation: true,
        contact: true,
      },
    });

    if (!enrollment) {
      throw new Error(`Enrollment '${enrollmentId}' not found for tenant '${clientId}'.`);
    }

    // Guard: Terminal or Paused states
    if (
      enrollment.status === EmailEnrollmentStatus.COMPLETED ||
      enrollment.status === EmailEnrollmentStatus.ABANDONED ||
      enrollment.status === EmailEnrollmentStatus.FAILED
    ) {
      return {
        status: enrollment.status,
        stepId: enrollment.currentStepId,
        abandonedReason: enrollment.abandonedReason,
      };
    }

    // Guard: Automation paused or archived
    if (enrollment.automation.status !== EmailAutomationStatus.ACTIVE) {
      logger.info(
        `[Automation] Automation ${enrollment.automationId} is ${enrollment.automation.status}. Postponing enrollment ${enrollmentId}.`
      );
      return { status: enrollment.status, stepId: enrollment.currentStepId };
    }

    const steps: JourneyStep[] = JSON.parse(enrollment.automation.steps);
    const stepIdToExecute = targetStepId || enrollment.currentStepId;

    if (!stepIdToExecute) {
      // Completed journey
      return this.completeEnrollment(clientId, enrollment.id, enrollment.automationId);
    }

    const step = steps.find((s) => s.id === stepIdToExecute);
    if (!step) {
      throw new Error(`Step '${stepIdToExecute}' not found in automation '${enrollment.automationId}'.`);
    }

    // -------------------------------------------------------------------------
    // A. Audience Re-evaluation Policy Enforcement
    // -------------------------------------------------------------------------
    const policy = enrollment.automation.reEvaluationPolicy;

    // 1. Universal Deliverability Safety: Consent & Suppression
    if (!enrollment.contact.hasMarketingConsent) {
      await this.abandonEnrollment(clientId, enrollment.id, ABANDON_REASONS.UNSUBSCRIBED);
      return { status: EmailEnrollmentStatus.ABANDONED, abandonedReason: ABANDON_REASONS.UNSUBSCRIBED };
    }

    const suppCheck = await EmailSuppressionService.isSuppressed(clientId, enrollment.contact.email);
    if (suppCheck.suppressed) {
      await this.abandonEnrollment(clientId, enrollment.id, ABANDON_REASONS.SUPPRESSED);
      return { status: EmailEnrollmentStatus.ABANDONED, abandonedReason: ABANDON_REASONS.SUPPRESSED };
    }

    // 2. Strict Segment Criteria Re-evaluation (if ALWAYS_RE_EVALUATE)
    if (policy === AudienceReEvaluationPolicy.ALWAYS_RE_EVALUATE) {
      const triggerConfig = enrollment.automation.triggerConfig
        ? JSON.parse(enrollment.automation.triggerConfig)
        : {};
      if (triggerConfig.segmentId) {
        const segment = await EmailSegmentService.getSegmentById(clientId, triggerConfig.segmentId);
        if (segment) {
          const criteria: SegmentCriteria = JSON.parse(segment.criteria);
          const stillEligible = EmailSegmentService.evaluateContact(criteria, enrollment.contact);
          if (!stillEligible) {
            logger.info(
              `[Automation] Contact ${enrollment.contactId} no longer qualifies under ALWAYS_RE_EVALUATE. Abandoning.`
            );
            await this.abandonEnrollment(clientId, enrollment.id, ABANDON_REASONS.CRITERIA_MISMATCH);
            return {
              status: EmailEnrollmentStatus.ABANDONED,
              abandonedReason: ABANDON_REASONS.CRITERIA_MISMATCH,
            };
          }
        }
      }
    }

    // -------------------------------------------------------------------------
    // B. Step Execution by Type
    // -------------------------------------------------------------------------
    const context: EnrollmentContextData = enrollment.contextData
      ? JSON.parse(enrollment.contextData)
      : { stepHistory: [], branchDecisions: {} };

    switch (step.type) {
      case "SEND_CAMPAIGN": {
        // Dispatches email using existing campaign engine
        await this.executeSendCampaignStep(clientId, enrollment, step, context);

        // Advance to next step
        const nextStepId = step.nextStepId || null;
        if (nextStepId) {
          await prisma.emailAutomationEnrollment.update({
            where: { id: enrollment.id },
            data: {
              currentStepId: nextStepId,
              contextData: JSON.stringify(context),
            },
          });
          return this.processEnrollmentStep(clientId, enrollment.id, nextStepId);
        } else {
          return this.completeEnrollment(clientId, enrollment.id, enrollment.automationId);
        }
      }

      case "DELAY": {
        const delayConfig = (step.config || {}) as DelayStepConfig;
        let delayMs = delayConfig.delayMs || 0;
        if (delayConfig.delayMinutes) delayMs = delayConfig.delayMinutes * 60 * 1000;
        if (delayConfig.delayHours) delayMs = delayConfig.delayHours * 3600 * 1000;
        if (delayConfig.delayDays) delayMs = delayConfig.delayDays * 86400 * 1000;

        const nextActionAt = new Date(Date.now() + delayMs);
        const nextStepId = step.nextStepId || null;

        await prisma.emailAutomationEnrollment.update({
          where: { id: enrollment.id },
          data: {
            status: EmailEnrollmentStatus.WAITING,
            currentStepId: step.id,
            nextActionAt,
            contextData: JSON.stringify(context),
          },
        });

        // Enqueue delayed job on BullMQ
        if (nextStepId) {
          const queue = getCampaignQueue();
          const jobId = getAutomationStepJobId(enrollment.id, nextStepId);
          await queue.add(
            JOB_NAMES.PROCESS_AUTOMATION_STEP,
            {
              automationId: enrollment.automationId,
              enrollmentId: enrollment.id,
              clientId,
              stepId: nextStepId,
            } as AutomationJobData,
            {
              delay: delayMs,
              jobId,
            }
          );
        }

        return { status: EmailEnrollmentStatus.WAITING, stepId: step.id };
      }

      case "CONDITIONAL_BRANCH": {
        const branchConfig = step.config as ConditionalBranchStepConfig;
        const evaluationResult = await this.evaluateCondition(
          clientId,
          enrollment.contact,
          branchConfig.condition,
          context
        );

        const chosenNextStepId = evaluationResult
          ? branchConfig.trueNextStepId
          : branchConfig.falseNextStepId;

        context.branchDecisions[step.id] = {
          decision: evaluationResult,
          timestamp: new Date().toISOString(),
        };

        context.stepHistory.push({
          stepId: step.id,
          type: "CONDITIONAL_BRANCH",
          executedAt: new Date().toISOString(),
          details: { conditionResult: evaluationResult, chosenNextStepId },
        });

        await prisma.emailAutomationEnrollment.update({
          where: { id: enrollment.id },
          data: {
            currentStepId: chosenNextStepId,
            contextData: JSON.stringify(context),
          },
        });

        return this.processEnrollmentStep(clientId, enrollment.id, chosenNextStepId);
      }

      case "WAIT_FOR_EVENT": {
        // If enrollment is ALREADY waiting on this step, this invocation represents the timeout check!
        if (enrollment.status === EmailEnrollmentStatus.WAITING && enrollment.currentStepId === step.id) {
          await this.executeStepTimeout(clientId, enrollment.id, step.id);
          const updated = await prisma.emailAutomationEnrollment.findUnique({ where: { id: enrollment.id } });
          return {
            status: updated?.status || EmailEnrollmentStatus.WAITING,
            stepId: updated?.currentStepId || step.id,
            abandonedReason: updated?.abandonedReason || undefined,
          };
        }

        const waitConfig = (step.config || {}) as WaitForEventStepConfig;
        let timeoutMs = 24 * 3600 * 1000; // default 24h
        if (waitConfig.timeoutMinutes) timeoutMs = waitConfig.timeoutMinutes * 60 * 1000;
        if (waitConfig.timeoutHours) timeoutMs = waitConfig.timeoutHours * 3600 * 1000;

        const nextActionAt = new Date(Date.now() + timeoutMs);

        await prisma.emailAutomationEnrollment.update({
          where: { id: enrollment.id },
          data: {
            status: EmailEnrollmentStatus.WAITING,
            currentStepId: step.id,
            nextActionAt,
            contextData: JSON.stringify(context),
          },
        });

        // Enqueue delayed timeout check (Deterministic ID)
        const queue = getCampaignQueue();
        const timeoutJobId = `timeout-${enrollment.id}-${step.id}`;

        const existingJob = await queue.getJob(timeoutJobId);
        if (existingJob) {
          const state = await existingJob.getState();
          if (state === "completed" || state === "failed") {
            await existingJob.remove();
          }
        }

        await queue.add(
          JOB_NAMES.PROCESS_AUTOMATION_STEP,
          {
            automationId: enrollment.automationId,
            enrollmentId: enrollment.id,
            clientId,
            stepId: step.id,
            isTimeout: true,
          } as AutomationJobData,
          {
            delay: timeoutMs,
            jobId: timeoutJobId,
          }
        );

        return { status: EmailEnrollmentStatus.WAITING, stepId: step.id };
      }

      case "END": {
        return this.completeEnrollment(clientId, enrollment.id, enrollment.automationId);
      }

      default:
        throw new Error(`Unhandled step type: ${(step as JourneyStep).type}`);
    }
  }

  /**
   * Authoritative timeout execution for WAIT_FOR_EVENT steps.
   * If enrollment is still waiting at this step:
   * - Advances to timeoutNextStepId if specified.
   * - Otherwise transitions to ABANDONED (TIMEOUT_EXPIRED).
   * Idempotent: no-op if enrollment has already advanced past this step.
   */
  static async executeStepTimeout(
    clientId: string,
    enrollmentId: string,
    stepId: string
  ): Promise<{ handled: boolean; action: string }> {
    const enrollment = await prisma.emailAutomationEnrollment.findUnique({
      where: { id: enrollmentId },
      include: { automation: true },
    });

    if (!enrollment || enrollment.clientId !== clientId) {
      return { handled: false, action: "ENROLLMENT_NOT_FOUND" };
    }

    // 1. Guard: Automation paused or archived
    if (enrollment.automation.status !== EmailAutomationStatus.ACTIVE) {
      logger.info(
        `[Automation:Timeout] Automation ${enrollment.automationId} is ${enrollment.automation.status}. Postponing timeout execution.`
      );
      return { handled: false, action: "AUTOMATION_NOT_ACTIVE" };
    }

    // 2. Guard: Verification that enrollment is STILL waiting on THIS exact step
    if (enrollment.status !== EmailEnrollmentStatus.WAITING || enrollment.currentStepId !== stepId) {
      logger.info(
        `[Automation:Timeout] Enrollment ${enrollmentId} is no longer waiting on step ${stepId} (status: ${enrollment.status}, step: ${enrollment.currentStepId}). Timeout is an idempotent no-op.`
      );
      return { handled: true, action: "NOOP_ALREADY_ADVANCED" };
    }

    // 3. Load step configuration
    const steps: JourneyStep[] = JSON.parse(enrollment.automation.steps);
    const step = steps.find((s) => s.id === stepId);
    if (!step || step.type !== "WAIT_FOR_EVENT") {
      return { handled: false, action: "INVALID_STEP_TYPE" };
    }

    const config = (step.config || {}) as WaitForEventStepConfig;
    const context: EnrollmentContextData = enrollment.contextData
      ? JSON.parse(enrollment.contextData)
      : { stepHistory: [], branchDecisions: {} };

    // 4. Branch on timeoutNextStepId vs Abandonment
    if (config.timeoutNextStepId) {
      logger.info(
        `[Automation:Timeout] Enrollment ${enrollmentId} timed out at step ${stepId}. Branching to '${config.timeoutNextStepId}'.`
      );
      context.stepHistory.push({
        stepId: step.id,
        type: "WAIT_FOR_EVENT",
        executedAt: new Date().toISOString(),
        details: { outcome: "TIMEOUT_BRANCHED", nextStepId: config.timeoutNextStepId },
      });

      await prisma.emailAutomationEnrollment.update({
        where: { id: enrollment.id },
        data: {
          status: EmailEnrollmentStatus.ACTIVE,
          currentStepId: config.timeoutNextStepId,
          nextActionAt: new Date(),
          contextData: JSON.stringify(context),
        },
      });

      await this.processEnrollmentStep(clientId, enrollment.id, config.timeoutNextStepId);
      return { handled: true, action: "TIMEOUT_BRANCHED" };
    } else {
      logger.info(
        `[Automation:Timeout] Enrollment ${enrollmentId} timed out at step ${stepId} without next step. Abandoning with TIMEOUT_EXPIRED.`
      );
      await this.abandonEnrollment(clientId, enrollment.id, ABANDON_REASONS.TIMEOUT_EXPIRED);
      return { handled: true, action: "TIMEOUT_ABANDONED" };
    }
  }

  /**
   * Executes a SEND_CAMPAIGN step using the existing campaign engine.
   * Dedicated child campaign per enrollment/execution (Option A):
   * Ensures campaign worker completion never causes later contacts to be skipped!
   */
  private static async executeSendCampaignStep(
    clientId: string,
    enrollment: EmailAutomationEnrollment & { contact: EmailContact },
    step: JourneyStep,
    context: EnrollmentContextData
  ): Promise<void> {
    const config = (step.config || {}) as SendCampaignStepConfig;

    // Find or create dedicated child campaign for this enrollment's step execution
    const stepCampaignName = `${config.campaignNamePrefix || "Journey Step"} - ${step.name} - ${enrollment.id.slice(0, 8)}`;

    let stepCampaign = await prisma.emailCampaign.findFirst({
      where: {
        clientId,
        automationId: enrollment.automationId,
        automationStepId: step.id,
        name: stepCampaignName,
      },
    });

    if (!stepCampaign) {
      let templateVersionId = config.templateVersionId;
      if (!templateVersionId && config.templateId) {
        const latestVersion = await prisma.emailTemplateVersion.findFirst({
          where: { templateId: config.templateId },
          orderBy: { version: "desc" },
        });
        templateVersionId = latestVersion?.id;
      }

      if (!templateVersionId) {
        throw new Error(
          `SEND_CAMPAIGN step '${step.id}' requires a valid templateId or templateVersionId.`
        );
      }

      stepCampaign = await prisma.emailCampaign.create({
        data: {
          clientId,
          automationId: enrollment.automationId,
          automationStepId: step.id,
          name: stepCampaignName,
          templateVersionId,
          senderIdentityId: config.senderIdentityId || null,
          type: EmailType.PROMOTIONAL,
          status: EmailCampaignStatus.RUNNING,
          startedAt: new Date(),
        },
      });
    }

    // Ensure recipient record exists under step campaign
    let recipient = await prisma.emailCampaignRecipient.findFirst({
      where: {
        campaignId: stepCampaign.id,
        contactId: enrollment.contactId,
      },
    });

    if (!recipient) {
      recipient = await prisma.emailCampaignRecipient.create({
        data: {
          campaignId: stepCampaign.id,
          contactId: enrollment.contactId,
          email: enrollment.contact.email,
          status: "PENDING",
          metadataSnapshot: enrollment.contact.metadata || "{}",
        },
      });

      await prisma.emailCampaign.update({
        where: { id: stepCampaign.id },
        data: { totalRecipients: { increment: 1 } },
      });
    }

    // Enqueue individual recipient dispatch on BullMQ queue
    const queue = getCampaignQueue();
    const jobId = getCampaignJobId(recipient.id);

    const existingJob = await queue.getJob(jobId);
    if (existingJob) {
      const state = await existingJob.getState();
      if (state === "completed" || state === "failed") {
        await existingJob.remove();
      }
    }

    const jobData: CampaignJobData = {
      campaignRecipientId: recipient.id,
      campaignId: stepCampaign.id,
      clientId,
      category: "PROMOTIONAL",
    };

    await queue.add(JOB_NAMES.SEND_CAMPAIGN_RECIPIENT, jobData, { jobId });

    // Record step history
    context.stepHistory.push({
      stepId: step.id,
      type: "SEND_CAMPAIGN",
      executedAt: new Date().toISOString(),
      campaignId: stepCampaign.id,
      recipientId: recipient.id,
    });
  }

  /**
   * Evaluates branch condition in-memory / with parameterized database queries.
   */
  private static async evaluateCondition(
    clientId: string,
    contact: EmailContact,
    condition: ConditionalBranchStepConfig["condition"],
    context: EnrollmentContextData
  ): Promise<boolean> {
    switch (condition.type) {
      case "EVENT_ENGAGEMENT": {
        // Did contact open / click / deliver an email sent in a previous step?
        const eventType = condition.eventType || "OPENED";
        const withinStepId = condition.withinStepId;

        // Find relevant step execution in history
        const priorExecutions = context.stepHistory.filter(
          (h) => h.type === "SEND_CAMPAIGN" && (!withinStepId || h.stepId === withinStepId)
        );

        if (priorExecutions.length === 0) return false;

        const recipientIds = priorExecutions
          .map((h) => h.recipientId)
          .filter((id): id is string => Boolean(id));

        if (recipientIds.length === 0) return false;

        if (eventType === "OPENED") {
          const opened = await prisma.emailEvent.findFirst({
            where: {
              delivery: {
                campaignRecipientId: { in: recipientIds },
              },
              eventType: "OPENED",
            },
          });
          return Boolean(opened);
        }

        if (eventType === "CLICKED") {
          const clicked = await prisma.emailEvent.findFirst({
            where: {
              delivery: {
                campaignRecipientId: { in: recipientIds },
              },
              eventType: "CLICKED",
            },
          });
          return Boolean(clicked);
        }

        if (eventType === "DELIVERED") {
          const delivered = await prisma.emailCampaignRecipient.findFirst({
            where: {
              id: { in: recipientIds },
              status: "SENT",
            },
          });
          return Boolean(delivered);
        }

        return false;
      }

      case "CONTACT_ATTRIBUTE": {
        const { attributeKey, operator, value } = condition;
        if (!attributeKey) return false;

        let actual: unknown;
        if (attributeKey === "marketingConsent" || attributeKey === "hasMarketingConsent") {
          actual = contact.hasMarketingConsent;
        } else if (attributeKey === "verified") {
          actual = contact.verified;
        } else if (attributeKey === "status") {
          actual = contact.status;
        } else if (attributeKey === "email") {
          actual = contact.email;
        } else if (attributeKey === "firstName") {
          actual = contact.firstName;
        } else if (attributeKey === "lastName") {
          actual = contact.lastName;
        } else {
          // Metadata attribute
          let meta: Record<string, unknown> = {};
          try {
            meta = contact.metadata ? JSON.parse(contact.metadata) : {};
          } catch {
            meta = {};
          }
          actual = meta[attributeKey];
        }

        const normOp = (operator || "equals").toLowerCase();
        if (normOp === "equals") {
          if (typeof actual === "string" && typeof value === "string") {
            return actual.toLowerCase() === value.toLowerCase();
          }
          return actual === value;
        }
        if (normOp === "not_equals") {
          if (typeof actual === "string" && typeof value === "string") {
            return actual.toLowerCase() !== value.toLowerCase();
          }
          return actual !== value;
        }
        if (normOp === "contains") {
          if (actual === null || actual === undefined) return false;
          return String(actual).toLowerCase().includes(String(value).toLowerCase());
        }
        if (normOp === "greater_than") {
          return Number(actual) > Number(value);
        }
        if (normOp === "less_than") {
          return Number(actual) < Number(value);
        }
        return false;
      }

      case "CONSENT_STATUS": {
        return contact.hasMarketingConsent === true;
      }

      case "LIST_MEMBERSHIP": {
        if (!condition.listId) return false;
        const membership = await prisma.emailListMember.findUnique({
          where: {
            listId_contactId: {
              listId: condition.listId,
              contactId: contact.id,
            },
          },
        });
        return membership?.status === "SUBSCRIBED";
      }

      default:
        return false;
    }
  }

  /**
   * Marks an enrollment as COMPLETED.
   */
  private static async completeEnrollment(
    clientId: string,
    enrollmentId: string,
    automationId: string
  ): Promise<{ status: EmailEnrollmentStatus; stepId: null }> {
    await prisma.emailAutomationEnrollment.update({
      where: { id: enrollmentId },
      data: {
        status: EmailEnrollmentStatus.COMPLETED,
        completedAt: new Date(),
        currentStepId: null,
      },
    });

    await prisma.emailAutomation.update({
      where: { id: automationId },
      data: {
        activeEnrollmentsCount: { decrement: 1 },
        completedEnrollmentsCount: { increment: 1 },
      },
    });

    logger.info(`[Automation] Enrollment ${enrollmentId} reached completion.`);
    return { status: EmailEnrollmentStatus.COMPLETED, stepId: null };
  }

  // ===========================================================================
  // 4. Recurring Campaign Execution Engine
  // ===========================================================================

  /**
   * Triggers a recurring campaign run.
   * Creates a new child EmailCampaign under the existing campaign engine,
   * enforces re-evaluation policy, triggers send, and advances nextRunAt.
   */
  static async executeRecurringStep(
    clientId: string,
    automationId: string
  ): Promise<{ campaignId: string; enqueuedCount: number; nextRunAt: Date | null }> {
    const automation = await this.getAutomationById(clientId, automationId);
    if (!automation) {
      throw new Error(`Automation '${automationId}' not found for tenant '${clientId}'.`);
    }

    if (automation.status !== EmailAutomationStatus.ACTIVE) {
      logger.info(
        `[Automation:Recurring] Automation ${automationId} is ${automation.status}. Skipping recurring run.`
      );
      return { campaignId: "", enqueuedCount: 0, nextRunAt: automation.nextRunAt };
    }

    const config: RecurringScheduleConfig = automation.triggerConfig
      ? JSON.parse(automation.triggerConfig)
      : {};

    // Check Max Runs limit
    const recurrenceIndex = automation.executionCount + 1;
    if (config.maxRuns && recurrenceIndex > config.maxRuns) {
      logger.info(
        `[Automation:Recurring] Automation ${automationId} reached max runs (${config.maxRuns}). Pausing.`
      );
      await this.pauseAutomation(clientId, automationId);
      return { campaignId: "", enqueuedCount: 0, nextRunAt: null };
    }

    // Resolve Template Version
    let templateVersionId = config.templateVersionId;
    if (!templateVersionId && config.templateId) {
      const latest = await prisma.emailTemplateVersion.findFirst({
        where: { templateId: config.templateId },
        orderBy: { version: "desc" },
      });
      templateVersionId = latest?.id;
    }

    if (!templateVersionId) {
      throw new Error(
        `Recurring automation '${automationId}' requires a valid templateId or templateVersionId in triggerConfig.`
      );
    }

    // 1. Create Child Campaign under Existing Campaign Engine
    const childCampaign = await prisma.emailCampaign.create({
      data: {
        clientId,
        automationId: automation.id,
        recurrenceIndex,
        name: `${config.campaignNamePrefix || automation.name} - Run #${recurrenceIndex}`,
        templateVersionId,
        listId: config.listId || null,
        segmentId: config.segmentId || null,
        senderIdentityId: config.senderIdentityId || null,
        type: EmailType.PROMOTIONAL,
        status: EmailCampaignStatus.DRAFT,
      },
    });

    // 2. Dispatches Campaign via Existing Campaign Engine
    // (This triggers audience snapshotting, consent verification, suppression checks, and BullMQ enqueuing)
    const sendResult = await EmailCampaignService.sendCampaignNow(clientId, childCampaign.id);

    // 3. Advance Execution Count and Calculate Next Run
    const nextRunAt = calculateNextRunTime(config, new Date());

    await prisma.emailAutomation.update({
      where: { id: automation.id },
      data: {
        executionCount: { increment: 1 },
        lastExecutedAt: new Date(),
        nextRunAt,
      },
    });

    // 4. Enqueue Next Recurring Run on BullMQ if schedule continues
    if (nextRunAt && (!config.maxRuns || recurrenceIndex + 1 <= config.maxRuns)) {
      const delayMs = Math.max(0, nextRunAt.getTime() - Date.now());
      const queue = getCampaignQueue();
      const nextJobId = getRecurringAutomationJobId(automation.id, recurrenceIndex + 1);

      await queue.add(
        JOB_NAMES.TRIGGER_RECURRING_AUTOMATION,
        {
          automationId: automation.id,
          clientId,
          recurrenceIndex: recurrenceIndex + 1,
        } as AutomationJobData,
        {
          delay: delayMs,
          jobId: nextJobId,
        }
      );
    }

    logger.info(
      `[Automation:Recurring] Automation ${automationId} Run #${recurrenceIndex} dispatched campaign ${childCampaign.id} (${sendResult.enqueuedCount} recipients). Next run: ${nextRunAt?.toISOString()}`
    );

    return {
      campaignId: childCampaign.id,
      enqueuedCount: sendResult.enqueuedCount,
      nextRunAt,
    };
  }

  // ===========================================================================
  // 5. Event-Triggered Automation & Webhook Hook
  // ===========================================================================

  /**
   * Handles email events (OPENED, CLICKED, DELIVERED) from webhooks or tracking pixels.
   * 1. Advances active enrollments waiting at WAIT_FOR_EVENT steps.
   * 2. Auto-enrolls contacts into active EVENT_TRIGGERED automations.
   */
  static async handleEmailEvent(event: {
    clientId: string;
    eventType: string; // "OPENED" | "CLICKED" | "DELIVERED"
    email: string;
    deliveryId?: string;
    campaignId?: string;
  }): Promise<{ matchedEnrollments: number; newEnrollments: number }> {
    const { clientId, eventType, email, campaignId } = event;
    if (!clientId || !email) return { matchedEnrollments: 0, newEnrollments: 0 };

    // Resolve Contact
    const contact = await prisma.emailContact.findFirst({
      where: { clientId, email },
    });
    if (!contact) return { matchedEnrollments: 0, newEnrollments: 0 };

    let matchedEnrollments = 0;
    let newEnrollments = 0;

    // A. Check Waiting Enrollments at WAIT_FOR_EVENT
    const waitingEnrollments = await prisma.emailAutomationEnrollment.findMany({
      where: {
        clientId,
        contactId: contact.id,
        status: EmailEnrollmentStatus.WAITING,
        currentStepId: { not: null },
      },
      include: { automation: true },
    });

    for (const enrollment of waitingEnrollments) {
      if (enrollment.automation.status !== EmailAutomationStatus.ACTIVE) continue;

      const steps: JourneyStep[] = JSON.parse(enrollment.automation.steps);
      const currentStep = steps.find((s) => s.id === enrollment.currentStepId);

      if (currentStep && currentStep.type === "WAIT_FOR_EVENT") {
        const config = currentStep.config as WaitForEventStepConfig;

        // Match event type
        if (config.eventType === eventType || config.eventType === "CUSTOM") {
          // If withinStepId is specified, verify campaign association
          let matchesStep = true;
          if (config.withinStepId && campaignId) {
            const context: EnrollmentContextData = enrollment.contextData
              ? JSON.parse(enrollment.contextData)
              : { stepHistory: [], branchDecisions: {} };

            const wasTargetCampaign = context.stepHistory.some(
              (h) => h.stepId === config.withinStepId && h.campaignId === campaignId
            );
            if (!wasTargetCampaign) {
              matchesStep = false;
            }
          }

          if (matchesStep) {
            logger.info(
              `[Automation:Event] Enrollment ${enrollment.id} event matched '${eventType}'. Advancing to step '${config.nextStepId}'.`
            );
            await prisma.emailAutomationEnrollment.update({
              where: { id: enrollment.id },
              data: {
                status: EmailEnrollmentStatus.ACTIVE,
                currentStepId: config.nextStepId,
                nextActionAt: new Date(),
              },
            });
            await this.processEnrollmentStep(clientId, enrollment.id, config.nextStepId);
            matchedEnrollments++;
          }
        }
      }
    }

    // B. Check Active Automations with EVENT_TRIGGERED
    const eventAutomations = await prisma.emailAutomation.findMany({
      where: {
        clientId,
        status: EmailAutomationStatus.ACTIVE,
        triggerType: EmailAutomationTriggerType.EVENT_TRIGGERED,
      },
    });

    for (const auto of eventAutomations) {
      // Strict Self-Trigger Prevention: If the event was emitted by a campaign
      // originating from this same automation, NEVER re-trigger this automation!
      if (campaignId) {
        const sourceCampaign = await prisma.emailCampaign.findUnique({
          where: { id: campaignId },
          select: { automationId: true },
        });
        if (sourceCampaign?.automationId === auto.id) {
          logger.info(
            `[Automation:SelfTrigger] Blocked event '${eventType}' from campaign '${campaignId}' originating from automation '${auto.id}'. Self-reentry prohibited.`
          );
          continue;
        }
      }

      const config: EventTriggerConfig = auto.triggerConfig ? JSON.parse(auto.triggerConfig) : {};
      if (config.eventType === eventType || config.eventType === "CUSTOM") {
        try {
          await this.enrollContact(clientId, auto.id, contact.id, { triggerEvent: event });
          newEnrollments++;
        } catch (err) {
          logger.warn(`[Automation:Event] Auto-enrollment error for ${auto.id}:`, err);
        }
      }
    }

    return { matchedEnrollments, newEnrollments };
  }
}
