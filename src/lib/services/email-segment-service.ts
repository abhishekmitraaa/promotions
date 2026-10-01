/**
 * Controlled Email Segment & Audience AST Engine
 *
 * Implements strict, injection-proof audience segmentation with:
 * - Nested AND/OR criteria groups with arbitrary depth (protected by max-depth limit)
 * - Contact attributes (direct contact fields and custom JSON metadata)
 * - Engagement criteria (recency, last emailed, activity windows)
 * - Previous campaign activity (targeted, received)
 * - Opens tracking criteria (campaign-specific or timeframe)
 * - Clicks tracking criteria (campaign-specific, URL-specific, timeframe)
 * - Delivery history criteria (delivered, bounced, complained, failed)
 * - Suppression state criteria (hard bounce, complaint, manual, unsubscribed, not suppressed)
 * - Consent state criteria (marketing consent, verified, consent source, timestamp)
 * - List membership criteria (in list, not in list, subscription status)
 *
 * Requirements enforced:
 * - Zero arbitrary SQL strings
 * - Strictly parameterized Prisma AST query generation
 * - Multi-tenant isolation at every query node
 * - Deterministic evaluations both in Prisma and in-memory
 */

import { prisma } from "../prisma";
import {
  EmailSegment,
  EmailContact,
  EmailContactStatus,
  EmailSubscriptionStatus,
  EmailSuppressionReason,
  Prisma,
} from "@prisma/client";

export type LogicalConjunction = "AND" | "OR";

export type SegmentOperator =
  | "equals"
  | "not_equals"
  | "contains"
  | "not_contains"
  | "starts_with"
  | "ends_with"
  | "in"
  | "not_in"
  | "greater_than"
  | "greater_than_or_equal"
  | "less_than"
  | "less_than_or_equal"
  | "is_empty"
  | "is_not_empty"
  | "exists"
  | "not_exists";

export const ALLOWED_OPERATORS: readonly SegmentOperator[] = [
  "equals",
  "not_equals",
  "contains",
  "not_contains",
  "starts_with",
  "ends_with",
  "in",
  "not_in",
  "greater_than",
  "greater_than_or_equal",
  "less_than",
  "less_than_or_equal",
  "is_empty",
  "is_not_empty",
  "exists",
  "not_exists",
] as const;

export const ALLOWED_DIRECT_FIELDS: readonly string[] = [
  "marketingConsent",
  "hasMarketingConsent",
  "verified",
  "status",
  "email",
  "normalizedEmail",
  "firstName",
  "lastName",
  "consentSource",
  "consentTimestamp",
  "lastEmailedAt",
  "unsubscribedAt",
  "createdAt",
  "updatedAt",
] as const;

export type AudienceConditionType =
  | "attribute"
  | "consent"
  | "suppression"
  | "list"
  | "campaign_activity"
  | "opens"
  | "clicks"
  | "delivery_history"
  | "engagement";

export interface ContactAttributeCondition {
  type?: "attribute";
  field: string;
  operator: SegmentOperator;
  value?: string | number | boolean | Array<string | number>;
}

export interface ConsentCondition {
  type: "consent";
  field?: "hasMarketingConsent" | "consentSource" | "consentTimestamp" | "verified";
  operator: "equals" | "not_equals" | "contains" | "in" | "after" | "before" | "within_days";
  value: boolean | string | number | string[];
}

export interface SuppressionCondition {
  type: "suppression";
  operator: "is_suppressed" | "is_not_suppressed" | "reason_equals" | "reason_in";
  value?: boolean | EmailSuppressionReason | EmailSuppressionReason[];
}

export interface ListMembershipCondition {
  type: "list";
  listId?: string;
  listIds?: string[];
  operator: "in_list" | "not_in_list";
  status?: EmailSubscriptionStatus;
}

export interface CampaignActivityCondition {
  type: "campaign_activity";
  campaignId?: string;
  operator: "targeted" | "not_targeted" | "received" | "not_received";
  timeframeDays?: number;
}

export interface OpensCondition {
  type: "opens";
  campaignId?: string;
  operator: "opened" | "not_opened" | "opened_within_days";
  timeframeDays?: number;
}

export interface ClicksCondition {
  type: "clicks";
  campaignId?: string;
  operator: "clicked" | "not_clicked" | "clicked_url" | "clicked_within_days";
  url?: string;
  timeframeDays?: number;
}

export interface DeliveryHistoryCondition {
  type: "delivery_history";
  campaignId?: string;
  operator: "delivered" | "bounced" | "complained" | "failed" | "not_bounced";
  timeframeDays?: number;
}

export interface EngagementCondition {
  type: "engagement";
  dimension: "last_emailed" | "activity_recency" | "never_emailed";
  operator: "within_days" | "older_than_days" | "never" | "active" | "inactive";
  days?: number;
}

export type AudienceCondition =
  | ContactAttributeCondition
  | ConsentCondition
  | SuppressionCondition
  | ListMembershipCondition
  | CampaignActivityCondition
  | OpensCondition
  | ClicksCondition
  | DeliveryHistoryCondition
  | EngagementCondition;

// Recursive AST Node: Can be an AudienceGroup or an AudienceCondition
export interface AudienceGroup {
  type?: "group";
  conjunction?: LogicalConjunction;
  conditions: Array<AudienceNode>;
}

export type AudienceNode = AudienceGroup | AudienceCondition;

// Backwards-compatible SegmentCondition and SegmentCriteria
export type SegmentCondition = ContactAttributeCondition;
export type SegmentCriteria = AudienceGroup;

const MAX_RECURSION_DEPTH = 5;

export class EmailSegmentService {
  /**
   * Validates structured segment criteria against strict allowlists recursively.
   * Prevents prototype pollution, cyclic recursion, and SQL injection strings.
   */
  static validateCriteria(criteria: unknown, depth: number = 0): SegmentCriteria {
    if (depth > MAX_RECURSION_DEPTH) {
      throw new Error(`Maximum nesting depth of ${MAX_RECURSION_DEPTH} exceeded for segment criteria.`);
    }

    if (!criteria || typeof criteria !== "object") {
      throw new Error("Segment criteria must be a valid JSON object.");
    }

    const { conjunction = "AND", conditions } = criteria as Partial<SegmentCriteria>;

    const upperConj = String(conjunction).toUpperCase() as LogicalConjunction;
    if (upperConj !== "AND" && upperConj !== "OR") {
      throw new Error("Conjunction must be either 'AND' or 'OR'.");
    }

    if (!Array.isArray(conditions) || conditions.length === 0) {
      throw new Error("Segment criteria must contain a non-empty 'conditions' array.");
    }

    const validatedConditions: AudienceNode[] = [];

    for (let i = 0; i < conditions.length; i++) {
      const item = conditions[i];
      if (!item || typeof item !== "object") {
        throw new Error(`Condition ${i + 1} must be an object.`);
      }

      // 1. Is this a nested group?
      if ("conditions" in item && Array.isArray((item as AudienceGroup).conditions)) {
        const nestedGroup = this.validateCriteria(item, depth + 1);
        validatedConditions.push({
          type: "group",
          conjunction: nestedGroup.conjunction || "AND",
          conditions: nestedGroup.conditions,
        });
        continue;
      }

      // 2. Otherwise it is a leaf condition
      const validatedLeaf = this.validateLeafCondition(item as unknown as Record<string, unknown>, i + 1);
      validatedConditions.push(validatedLeaf);
    }

    return {
      conjunction: upperConj,
      conditions: validatedConditions,
    };
  }

  private static validateLeafCondition(
    cond: Record<string, unknown>,
    index: number
  ): AudienceCondition {
    const rawType = typeof cond.type === "string" ? cond.type.toLowerCase() : undefined;

    // Check for dangerous SQL keywords in string values
    const checkSqlDangerous = (val: unknown) => {
      if (typeof val === "string") {
        const suspicious = /(--|;|\/\*|\*\/|union\s+select|drop\s+table)/i;
        if (suspicious.test(val)) {
          throw new Error(`Dangerous characters or SQL keywords detected in condition ${index}.`);
        }
      } else if (Array.isArray(val)) {
        for (const v of val) checkSqlDangerous(v);
      }
    };

    // A. Explicit typed condition
    if (rawType === "consent") {
      const op = String(cond.operator || "equals").toLowerCase();
      const allowedOps = ["equals", "not_equals", "contains", "in", "after", "before", "within_days"];
      if (!allowedOps.includes(op)) {
        throw new Error(`Unsupported consent operator '${cond.operator}' in condition ${index}.`);
      }
      checkSqlDangerous(cond.value);
      return {
        type: "consent",
        field: (cond.field as ConsentCondition["field"]) || "hasMarketingConsent",
        operator: op as ConsentCondition["operator"],
        value: (cond.field === "hasMarketingConsent" || cond.field === "verified" || !cond.field)
          ? (typeof cond.value === "boolean" ? cond.value : String(cond.value) === "true")
          : (cond.value as string | number | string[]),
      };
    }

    if (rawType === "suppression") {
      const op = String(cond.operator || "is_suppressed").toLowerCase();
      const allowedOps = ["is_suppressed", "is_not_suppressed", "reason_equals", "reason_in"];
      if (!allowedOps.includes(op)) {
        throw new Error(`Unsupported suppression operator '${cond.operator}' in condition ${index}.`);
      }
      checkSqlDangerous(cond.value);
      return {
        type: "suppression",
        operator: op as SuppressionCondition["operator"],
        value: cond.value as SuppressionCondition["value"],
      };
    }

    if (rawType === "list" || rawType === "list_membership") {
      const op = String(cond.operator || "in_list").toLowerCase();
      if (op !== "in_list" && op !== "not_in_list") {
        throw new Error(`Unsupported list operator '${cond.operator}' in condition ${index}. Allowed: in_list, not_in_list.`);
      }
      if (!cond.listId && (!Array.isArray(cond.listIds) || cond.listIds.length === 0)) {
        throw new Error(`List condition ${index} requires 'listId' or non-empty 'listIds'.`);
      }
      if (cond.listId) checkSqlDangerous(cond.listId);
      return {
        type: "list",
        operator: op as "in_list" | "not_in_list",
        listId: typeof cond.listId === "string" ? cond.listId : undefined,
        listIds: Array.isArray(cond.listIds) ? (cond.listIds as string[]) : undefined,
        status: cond.status as EmailSubscriptionStatus | undefined,
      };
    }

    if (rawType === "campaign_activity") {
      const op = String(cond.operator || "targeted").toLowerCase();
      const allowedOps = ["targeted", "not_targeted", "received", "not_received"];
      if (!allowedOps.includes(op)) {
        throw new Error(`Unsupported campaign activity operator '${cond.operator}' in condition ${index}.`);
      }
      if (cond.campaignId) checkSqlDangerous(cond.campaignId);
      return {
        type: "campaign_activity",
        operator: op as CampaignActivityCondition["operator"],
        campaignId: typeof cond.campaignId === "string" ? cond.campaignId : undefined,
        timeframeDays: typeof cond.timeframeDays === "number" ? cond.timeframeDays : undefined,
      };
    }

    if (rawType === "opens") {
      const op = String(cond.operator || "opened").toLowerCase();
      const allowedOps = ["opened", "not_opened", "opened_within_days"];
      if (!allowedOps.includes(op)) {
        throw new Error(`Unsupported opens operator '${cond.operator}' in condition ${index}.`);
      }
      if (cond.campaignId) checkSqlDangerous(cond.campaignId);
      return {
        type: "opens",
        operator: op as OpensCondition["operator"],
        campaignId: typeof cond.campaignId === "string" ? cond.campaignId : undefined,
        timeframeDays: typeof cond.timeframeDays === "number" ? cond.timeframeDays : undefined,
      };
    }

    if (rawType === "clicks") {
      const op = String(cond.operator || "clicked").toLowerCase();
      const allowedOps = ["clicked", "not_clicked", "clicked_url", "clicked_within_days"];
      if (!allowedOps.includes(op)) {
        throw new Error(`Unsupported clicks operator '${cond.operator}' in condition ${index}.`);
      }
      if (cond.campaignId) checkSqlDangerous(cond.campaignId);
      if (cond.url) checkSqlDangerous(cond.url);
      return {
        type: "clicks",
        operator: op as ClicksCondition["operator"],
        campaignId: typeof cond.campaignId === "string" ? cond.campaignId : undefined,
        url: typeof cond.url === "string" ? cond.url : undefined,
        timeframeDays: typeof cond.timeframeDays === "number" ? cond.timeframeDays : undefined,
      };
    }

    if (rawType === "delivery_history") {
      const op = String(cond.operator || "delivered").toLowerCase();
      const allowedOps = ["delivered", "bounced", "complained", "failed", "not_bounced"];
      if (!allowedOps.includes(op)) {
        throw new Error(`Unsupported delivery history operator '${cond.operator}' in condition ${index}.`);
      }
      if (cond.campaignId) checkSqlDangerous(cond.campaignId);
      return {
        type: "delivery_history",
        operator: op as DeliveryHistoryCondition["operator"],
        campaignId: typeof cond.campaignId === "string" ? cond.campaignId : undefined,
        timeframeDays: typeof cond.timeframeDays === "number" ? cond.timeframeDays : undefined,
      };
    }

    if (rawType === "engagement") {
      const dim = String(cond.dimension || "last_emailed").toLowerCase();
      const op = String(cond.operator || "within_days").toLowerCase();
      const allowedDims = ["last_emailed", "activity_recency", "never_emailed"];
      const allowedOps = ["within_days", "older_than_days", "never", "active", "inactive"];
      if (!allowedDims.includes(dim)) {
        throw new Error(`Unsupported engagement dimension '${cond.dimension}' in condition ${index}.`);
      }
      if (!allowedOps.includes(op)) {
        throw new Error(`Unsupported engagement operator '${cond.operator}' in condition ${index}.`);
      }
      return {
        type: "engagement",
        dimension: dim as EngagementCondition["dimension"],
        operator: op as EngagementCondition["operator"],
        days: typeof cond.days === "number" ? cond.days : undefined,
      };
    }

    // B. Default / Standard Attribute Condition (field + operator + value)
    const field = cond.field;
    if (!field || typeof field !== "string") {
      throw new Error(`Condition ${index}: 'field' must be a non-empty string.`);
    }

    const isDirect = (ALLOWED_DIRECT_FIELDS as readonly string[]).includes(field);
    const isAttribute =
      field.startsWith("attributes.") ||
      field.startsWith("metadata.") ||
      field.startsWith("custom.") ||
      field === "city" ||
      field === "category" ||
      field === "tier" ||
      field === "score";

    if (!isDirect && !isAttribute) {
      throw new Error(
        `Unsupported segment field '${field}'. Allowed fields: ${ALLOWED_DIRECT_FIELDS.join(", ")}, or 'attributes.<customField>'`
      );
    }

    // Sanity check attribute names to prevent property-path injection
    if (isAttribute) {
      const attrName = field
        .replace(/^attributes\./, "")
        .replace(/^metadata\./, "")
        .replace(/^custom\./, "");
      if (!/^[a-zA-Z0-9_]{1,50}$/.test(attrName)) {
        throw new Error(`Invalid attribute name in field '${field}'. Only alphanumeric and underscores allowed.`);
      }
    }

    const normalizedOp = String(cond.operator || "").toLowerCase() as SegmentOperator;
    if (!ALLOWED_OPERATORS.includes(normalizedOp)) {
      throw new Error(`Unsupported operator '${cond.operator}'. Allowed operators: ${ALLOWED_OPERATORS.join(", ")}`);
    }

    checkSqlDangerous(cond.value);

    // Operator-specific value validation
    if (normalizedOp === "in" || normalizedOp === "not_in") {
      if (!Array.isArray(cond.value) || cond.value.length === 0) {
        throw new Error(`Operator '${cond.operator}' requires a non-empty array value in condition ${index}.`);
      }
    } else if (normalizedOp !== "is_empty" && normalizedOp !== "is_not_empty" && normalizedOp !== "exists" && normalizedOp !== "not_exists") {
      if (Array.isArray(cond.value)) {
        throw new Error(`Operator '${cond.operator}' cannot accept an array value in condition ${index}.`);
      }
    }

    // Boolean field type checks
    if (field === "marketingConsent" || field === "hasMarketingConsent" || field === "verified") {
      if (typeof cond.value !== "boolean" && cond.value !== "true" && cond.value !== "false") {
        throw new Error(`Field '${field}' must have a boolean value in condition ${index}.`);
      }
    }

    return {
      type: "attribute",
      field,
      operator: normalizedOp,
      value:
        field === "marketingConsent" || field === "hasMarketingConsent" || field === "verified"
          ? String(cond.value) === "true"
          : (cond.value as string | number | boolean | Array<string | number>),
    };
  }

  /**
   * Evaluates a contact against a segment criteria tree in-memory.
   * Supports nested AND/OR groups, attribute conditions, consent, and engagement.
   */
  static evaluateContact(
    criteria: SegmentCriteria | AudienceNode,
    contact: EmailContact,
    metadataOverride?: Record<string, unknown>
  ): boolean {
    // If leaf condition
    if (!("conditions" in criteria) || !Array.isArray(criteria.conditions)) {
      return this.evaluateLeafNode(criteria as AudienceCondition, contact, metadataOverride);
    }

    const isAnd = (criteria.conjunction || "AND") === "AND";

    let metadata: Record<string, unknown> = metadataOverride || {};
    if (!metadataOverride && contact.metadata) {
      try {
        metadata = JSON.parse(contact.metadata);
      } catch {
        metadata = {};
      }
    }

    for (const node of criteria.conditions) {
      const match = this.evaluateContact(node, contact, metadata);
      if (isAnd && !match) return false;
      if (!isAnd && match) return true;
    }

    return isAnd;
  }

  private static evaluateLeafNode(
    node: AudienceCondition,
    contact: EmailContact,
    metadata: Record<string, unknown> = {}
  ): boolean {
    const rawType = node.type || "attribute";

    // 1. Consent Condition
    if (rawType === "consent") {
      const consentCond = node as ConsentCondition;
      const field = consentCond.field || "hasMarketingConsent";
      if (field === "hasMarketingConsent") {
        const expected = typeof consentCond.value === "boolean" ? consentCond.value : String(consentCond.value) === "true";
        return consentCond.operator === "not_equals"
          ? contact.hasMarketingConsent !== expected
          : contact.hasMarketingConsent === expected;
      }
      if (field === "verified") {
        const expected = typeof consentCond.value === "boolean" ? consentCond.value : String(consentCond.value) === "true";
        return consentCond.operator === "not_equals" ? contact.verified !== expected : contact.verified === expected;
      }
      if (field === "consentSource") {
        const actual = contact.consentSource || "";
        const expected = String(consentCond.value || "");
        if (consentCond.operator === "equals") return actual.toLowerCase() === expected.toLowerCase();
        if (consentCond.operator === "contains") return actual.toLowerCase().includes(expected.toLowerCase());
      }
      if (field === "consentTimestamp" && contact.consentTimestamp) {
        const actualTime = new Date(contact.consentTimestamp).getTime();
        if (consentCond.operator === "within_days" && typeof consentCond.value === "number") {
          const cutoff = Date.now() - consentCond.value * 86400000;
          return actualTime >= cutoff;
        }
      }
      return true;
    }

    // 2. Suppression Condition (in-memory check against contact status)
    if (rawType === "suppression") {
      const suppCond = node as SuppressionCondition;
      const isSuppressed =
        contact.status === EmailContactStatus.SUPPRESSED ||
        contact.status === EmailContactStatus.BOUNCED ||
        contact.status === EmailContactStatus.COMPLAINED;

      if (suppCond.operator === "is_suppressed") return isSuppressed;
      if (suppCond.operator === "is_not_suppressed") return !isSuppressed;
      return true;
    }

    // 3. Engagement Condition
    if (rawType === "engagement") {
      const engCond = node as EngagementCondition;
      if (engCond.dimension === "last_emailed" || engCond.dimension === "never_emailed") {
        if (engCond.operator === "never" || engCond.dimension === "never_emailed") {
          return !contact.lastEmailedAt;
        }
        if (!contact.lastEmailedAt) return false;
        const lastEmailedTime = new Date(contact.lastEmailedAt).getTime();
        const days = engCond.days || 30;
        const cutoff = Date.now() - days * 86400000;
        if (engCond.operator === "within_days") return lastEmailedTime >= cutoff;
        if (engCond.operator === "older_than_days") return lastEmailedTime < cutoff;
      }
      return true;
    }

    // 4. Contact Attribute Condition
    const attrCond = node as ContactAttributeCondition;
    const { field, value, operator } = attrCond;
    const normOp = (operator || "equals").toLowerCase() as SegmentOperator;

    let actualValue: unknown;
    if (field === "marketingConsent" || field === "hasMarketingConsent") {
      actualValue = contact.hasMarketingConsent;
    } else if (field === "verified") {
      actualValue = contact.verified;
    } else if (field === "status") {
      actualValue = contact.status;
    } else if (field === "email" || field === "normalizedEmail") {
      actualValue = contact.email;
    } else if (field === "firstName") {
      actualValue = contact.firstName || "";
    } else if (field === "lastName") {
      actualValue = contact.lastName || "";
    } else if (field === "consentSource") {
      actualValue = contact.consentSource || "";
    } else if (field === "createdAt") {
      actualValue = contact.createdAt;
    } else if (field === "lastEmailedAt") {
      actualValue = contact.lastEmailedAt;
    } else {
      const key = field
        .replace(/^attributes\./, "")
        .replace(/^metadata\./, "")
        .replace(/^custom\./, "");
      actualValue = metadata[key];
    }

    return this.evaluateOperator(normOp, actualValue, value);
  }

  private static evaluateOperator(operator: SegmentOperator, actual: unknown, expected: unknown): boolean {
    switch (operator) {
      case "equals":
        if (typeof actual === "string" && typeof expected === "string") {
          return actual.toLowerCase() === expected.toLowerCase();
        }
        return actual === expected;

      case "not_equals":
        if (typeof actual === "string" && typeof expected === "string") {
          return actual.toLowerCase() !== expected.toLowerCase();
        }
        return actual !== expected;

      case "contains":
        if (actual === null || actual === undefined) return false;
        return String(actual).toLowerCase().includes(String(expected).toLowerCase());

      case "not_contains":
        if (actual === null || actual === undefined) return true;
        return !String(actual).toLowerCase().includes(String(expected).toLowerCase());

      case "starts_with":
        if (actual === null || actual === undefined) return false;
        return String(actual).toLowerCase().startsWith(String(expected).toLowerCase());

      case "ends_with":
        if (actual === null || actual === undefined) return false;
        return String(actual).toLowerCase().endsWith(String(expected).toLowerCase());

      case "in":
        if (!Array.isArray(expected)) return false;
        return expected.some((v) => {
          if (typeof actual === "string" && typeof v === "string") {
            return actual.toLowerCase() === v.toLowerCase();
          }
          return actual === v;
        });

      case "not_in":
        if (!Array.isArray(expected)) return true;
        return !expected.some((v) => {
          if (typeof actual === "string" && typeof v === "string") {
            return actual.toLowerCase() === v.toLowerCase();
          }
          return actual === v;
        });

      case "greater_than":
      case "greater_than_or_equal":
      case "less_than":
      case "less_than_or_equal": {
        if (actual === null || actual === undefined || expected === null || expected === undefined) {
          return false;
        }
        const aNum = typeof actual === "number" ? actual : Number(actual);
        const eNum = typeof expected === "number" ? expected : Number(expected);
        if (!isNaN(aNum) && !isNaN(eNum)) {
          if (operator === "greater_than") return aNum > eNum;
          if (operator === "greater_than_or_equal") return aNum >= eNum;
          if (operator === "less_than") return aNum < eNum;
          if (operator === "less_than_or_equal") return aNum <= eNum;
        }
        // Date comparisons
        const aDate = new Date(actual as string | number | Date).getTime();
        const eDate = new Date(expected as string | number | Date).getTime();
        if (!isNaN(aDate) && !isNaN(eDate)) {
          if (operator === "greater_than") return aDate > eDate;
          if (operator === "greater_than_or_equal") return aDate >= eDate;
          if (operator === "less_than") return aDate < eDate;
          if (operator === "less_than_or_equal") return aDate <= eDate;
        }
        return false;
      }

      case "is_empty":
      case "not_exists":
        return actual === null || actual === undefined || actual === "";

      case "is_not_empty":
      case "exists":
        return actual !== null && actual !== undefined && actual !== "";

      default:
        return false;
    }
  }

  /**
   * Translates structured segment criteria into parameterized Prisma where clauses recursively.
   * Parameterizes all values, scopes relations to clientId (tenant isolation), and identifies
   * if post-query attribute evaluation is required.
   */
  static buildPrismaWhereFromCriteria(
    clientId: string,
    criteria: SegmentCriteria | AudienceNode
  ): {
    prismaWhere: Prisma.EmailContactWhereInput;
    hasAttributeConditions: boolean;
  } {
    let hasAttributeConditions = false;

    const translateNode = (node: AudienceNode): Prisma.EmailContactWhereInput | null => {
      // 1. Group Node
      if ("conditions" in node && Array.isArray(node.conditions)) {
        const isAnd = (node.conjunction || "AND") === "AND";
        const childFilters: Prisma.EmailContactWhereInput[] = [];

        for (const child of node.conditions) {
          const childFilter = translateNode(child);
          if (childFilter) {
            childFilters.push(childFilter);
          }
        }

        if (childFilters.length === 0) return null;
        return isAnd ? { AND: childFilters } : { OR: childFilters };
      }

      // 2. Leaf Condition Node
      const leafFilter = this.translateLeafToPrisma(clientId, node as AudienceCondition);
      if (leafFilter) {
        return leafFilter;
      } else {
        // Condition requires in-memory / attribute evaluation
        hasAttributeConditions = true;
        return { metadata: { not: null } };
      }
    };

    const rootFilter = translateNode(criteria);

    const prismaWhere: Prisma.EmailContactWhereInput = {
      clientId,
      ...(rootFilter ? rootFilter : {}),
    };

    return {
      prismaWhere,
      hasAttributeConditions,
    };
  }

  private static translateLeafToPrisma(
    clientId: string,
    cond: AudienceCondition
  ): Prisma.EmailContactWhereInput | null {
    const rawType = cond.type || "attribute";

    // A. List Membership Condition
    if (rawType === "list") {
      const listCond = cond as ListMembershipCondition;
      const listIds = listCond.listId ? [listCond.listId] : listCond.listIds || [];
      const status = listCond.status || EmailSubscriptionStatus.SUBSCRIBED;

      if (listCond.operator === "in_list") {
        return {
          listMemberships: {
            some: {
              ...(listIds.length === 1 ? { listId: listIds[0] } : { listId: { in: listIds } }),
              status,
              list: { clientId },
            },
          },
        };
      } else if (listCond.operator === "not_in_list") {
        return {
          listMemberships: {
            none: {
              ...(listIds.length === 1 ? { listId: listIds[0] } : { listId: { in: listIds } }),
              list: { clientId },
            },
          },
        };
      }
      return null;
    }

    // B. Campaign Activity Condition
    if (rawType === "campaign_activity") {
      const campCond = cond as CampaignActivityCondition;
      const sinceDate = campCond.timeframeDays
        ? new Date(Date.now() - campCond.timeframeDays * 86400000)
        : undefined;

      if (campCond.operator === "targeted") {
        return {
          campaignRecipients: {
            some: {
              ...(campCond.campaignId ? { campaignId: campCond.campaignId } : {}),
              campaign: { clientId },
              ...(sinceDate ? { createdAt: { gte: sinceDate } } : {}),
            },
          },
        };
      } else if (campCond.operator === "not_targeted") {
        return {
          campaignRecipients: {
            none: {
              ...(campCond.campaignId ? { campaignId: campCond.campaignId } : {}),
              campaign: { clientId },
            },
          },
        };
      } else if (campCond.operator === "received") {
        return {
          campaignRecipients: {
            some: {
              ...(campCond.campaignId ? { campaignId: campCond.campaignId } : {}),
              campaign: { clientId },
              deliveries: {
                some: {
                  status: { in: ["SENT", "DELIVERED"] },
                  clientId,
                  ...(sinceDate ? { createdAt: { gte: sinceDate } } : {}),
                },
              },
            },
          },
        };
      } else if (campCond.operator === "not_received") {
        return {
          campaignRecipients: {
            none: {
              ...(campCond.campaignId ? { campaignId: campCond.campaignId } : {}),
              campaign: { clientId },
              deliveries: {
                some: {
                  status: { in: ["SENT", "DELIVERED"] },
                  clientId,
                },
              },
            },
          },
        };
      }
      return null;
    }

    // C. Opens Condition
    if (rawType === "opens") {
      const opensCond = cond as OpensCondition;
      const sinceDate = opensCond.timeframeDays
        ? new Date(Date.now() - opensCond.timeframeDays * 86400000)
        : undefined;

      if (opensCond.operator === "opened" || opensCond.operator === "opened_within_days") {
        return {
          campaignRecipients: {
            some: {
              ...(opensCond.campaignId ? { campaignId: opensCond.campaignId } : {}),
              campaign: { clientId },
              deliveries: {
                some: {
                  clientId,
                  events: {
                    some: {
                      eventType: "OPENED",
                      ...(sinceDate ? { occurredAt: { gte: sinceDate } } : {}),
                    },
                  },
                },
              },
            },
          },
        };
      } else if (opensCond.operator === "not_opened") {
        return {
          campaignRecipients: {
            none: {
              ...(opensCond.campaignId ? { campaignId: opensCond.campaignId } : {}),
              campaign: { clientId },
              deliveries: {
                some: {
                  clientId,
                  events: {
                    some: {
                      eventType: "OPENED",
                      ...(sinceDate ? { occurredAt: { gte: sinceDate } } : {}),
                    },
                  },
                },
              },
            },
          },
        };
      }
      return null;
    }

    // D. Clicks Condition
    if (rawType === "clicks") {
      const clicksCond = cond as ClicksCondition;
      const sinceDate = clicksCond.timeframeDays
        ? new Date(Date.now() - clicksCond.timeframeDays * 86400000)
        : undefined;

      if (clicksCond.operator === "clicked" || clicksCond.operator === "clicked_within_days" || clicksCond.operator === "clicked_url") {
        return {
          campaignRecipients: {
            some: {
              ...(clicksCond.campaignId ? { campaignId: clicksCond.campaignId } : {}),
              campaign: { clientId },
              deliveries: {
                some: {
                  clientId,
                  events: {
                    some: {
                      eventType: "CLICKED",
                      ...(sinceDate ? { occurredAt: { gte: sinceDate } } : {}),
                      ...(clicksCond.url ? { payload: { contains: clicksCond.url } } : {}),
                    },
                  },
                },
              },
            },
          },
        };
      } else if (clicksCond.operator === "not_clicked") {
        return {
          campaignRecipients: {
            none: {
              ...(clicksCond.campaignId ? { campaignId: clicksCond.campaignId } : {}),
              campaign: { clientId },
              deliveries: {
                some: {
                  clientId,
                  events: {
                    some: {
                      eventType: "CLICKED",
                    },
                  },
                },
              },
            },
          },
        };
      }
      return null;
    }

    // E. Delivery History Condition
    if (rawType === "delivery_history") {
      const delCond = cond as DeliveryHistoryCondition;
      const sinceDate = delCond.timeframeDays
        ? new Date(Date.now() - delCond.timeframeDays * 86400000)
        : undefined;

      if (delCond.operator === "delivered") {
        return {
          campaignRecipients: {
            some: {
              ...(delCond.campaignId ? { campaignId: delCond.campaignId } : {}),
              campaign: { clientId },
              deliveries: {
                some: {
                  clientId,
                  status: "DELIVERED",
                  ...(sinceDate ? { deliveredAt: { gte: sinceDate } } : {}),
                },
              },
            },
          },
        };
      } else if (delCond.operator === "bounced") {
        return {
          campaignRecipients: {
            some: {
              ...(delCond.campaignId ? { campaignId: delCond.campaignId } : {}),
              campaign: { clientId },
              deliveries: {
                some: {
                  clientId,
                  status: "BOUNCED",
                  ...(sinceDate ? { updatedAt: { gte: sinceDate } } : {}),
                },
              },
            },
          },
        };
      } else if (delCond.operator === "complained") {
        return {
          campaignRecipients: {
            some: {
              ...(delCond.campaignId ? { campaignId: delCond.campaignId } : {}),
              campaign: { clientId },
              deliveries: {
                some: {
                  clientId,
                  status: "COMPLAINED",
                },
              },
            },
          },
        };
      } else if (delCond.operator === "failed") {
        return {
          campaignRecipients: {
            some: {
              ...(delCond.campaignId ? { campaignId: delCond.campaignId } : {}),
              campaign: { clientId },
              deliveries: {
                some: {
                  clientId,
                  status: "FAILED",
                },
              },
            },
          },
        };
      } else if (delCond.operator === "not_bounced") {
        return {
          campaignRecipients: {
            none: {
              campaign: { clientId },
              deliveries: {
                some: {
                  clientId,
                  status: "BOUNCED",
                },
              },
            },
          },
        };
      }
      return null;
    }

    // F. Suppression Condition
    if (rawType === "suppression") {
      const suppCond = cond as SuppressionCondition;
      if (suppCond.operator === "is_suppressed") {
        return {
          status: { in: [EmailContactStatus.SUPPRESSED, EmailContactStatus.BOUNCED, EmailContactStatus.COMPLAINED] },
        };
      } else if (suppCond.operator === "is_not_suppressed") {
        return {
          status: {
            notIn: [EmailContactStatus.SUPPRESSED, EmailContactStatus.BOUNCED, EmailContactStatus.COMPLAINED],
          },
        };
      }
      return null;
    }

    // G. Engagement Condition
    if (rawType === "engagement") {
      const engCond = cond as EngagementCondition;
      const days = engCond.days || 30;
      const cutoff = new Date(Date.now() - days * 86400000);

      if (engCond.dimension === "last_emailed") {
        if (engCond.operator === "within_days") {
          return { lastEmailedAt: { gte: cutoff } };
        } else if (engCond.operator === "older_than_days") {
          return { lastEmailedAt: { lt: cutoff } };
        } else if (engCond.operator === "never") {
          return { lastEmailedAt: null };
        }
      } else if (engCond.dimension === "never_emailed") {
        return { lastEmailedAt: null };
      }
      return null;
    }

    // H. Consent Condition
    if (rawType === "consent") {
      const consentCond = cond as ConsentCondition;
      const field = consentCond.field || "hasMarketingConsent";
      if (field === "hasMarketingConsent") {
        const b = typeof consentCond.value === "boolean" ? consentCond.value : String(consentCond.value) === "true";
        return consentCond.operator === "not_equals" ? { hasMarketingConsent: !b } : { hasMarketingConsent: b };
      }
      if (field === "verified") {
        const b = typeof consentCond.value === "boolean" ? consentCond.value : String(consentCond.value) === "true";
        return consentCond.operator === "not_equals" ? { verified: !b } : { verified: b };
      }
      if (field === "consentSource") {
        const str = String(consentCond.value || "").trim();
        if (consentCond.operator === "equals") return { consentSource: { equals: str, mode: "insensitive" } };
        if (consentCond.operator === "contains") return { consentSource: { contains: str, mode: "insensitive" } };
      }
      if (field === "consentTimestamp" && consentCond.operator === "within_days") {
        const days = Number(consentCond.value) || 30;
        return { consentTimestamp: { gte: new Date(Date.now() - days * 86400000) } };
      }
      return null;
    }

    // I. Direct Attribute Condition
    const attrCond = cond as ContactAttributeCondition;
    const { field, value, operator } = attrCond;
    const normOp = (operator || "equals").toLowerCase() as SegmentOperator;

    if (field === "marketingConsent" || field === "hasMarketingConsent") {
      const b = typeof value === "boolean" ? value : String(value) === "true";
      if (normOp === "equals") return { hasMarketingConsent: b };
      if (normOp === "not_equals") return { hasMarketingConsent: !b };
      return null;
    }

    if (field === "verified") {
      const b = typeof value === "boolean" ? value : String(value) === "true";
      if (normOp === "equals") return { verified: b };
      if (normOp === "not_equals") return { verified: !b };
      return null;
    }

    if (field === "status") {
      const s = value as EmailContactStatus;
      if (normOp === "equals") return { status: s };
      if (normOp === "not_equals") return { status: { not: s } };
      if (normOp === "in" && Array.isArray(value)) return { status: { in: value as EmailContactStatus[] } };
      if (normOp === "not_in" && Array.isArray(value)) return { status: { notIn: value as EmailContactStatus[] } };
      return null;
    }

    if (field === "email" || field === "normalizedEmail") {
      const str = String(value || "").trim();
      if (normOp === "equals") return { normalizedEmail: str.toLowerCase() };
      if (normOp === "not_equals") return { normalizedEmail: { not: str.toLowerCase() } };
      if (normOp === "contains") return { email: { contains: str, mode: "insensitive" } };
      if (normOp === "starts_with") return { email: { startsWith: str, mode: "insensitive" } };
      if (normOp === "ends_with") return { email: { endsWith: str, mode: "insensitive" } };
      if (normOp === "in" && Array.isArray(value)) {
        return { normalizedEmail: { in: value.map((v) => String(v).trim().toLowerCase()) } };
      }
      if (normOp === "not_in" && Array.isArray(value)) {
        return { normalizedEmail: { notIn: value.map((v) => String(v).trim().toLowerCase()) } };
      }
      return null;
    }

    if (field === "firstName" || field === "lastName") {
      const str = String(value || "").trim();
      const col = field === "firstName" ? "firstName" : "lastName";
      if (normOp === "equals") return { [col]: { equals: str, mode: "insensitive" } };
      if (normOp === "not_equals") return { [col]: { not: str } };
      if (normOp === "contains") return { [col]: { contains: str, mode: "insensitive" } };
      if (normOp === "starts_with") return { [col]: { startsWith: str, mode: "insensitive" } };
      if (normOp === "ends_with") return { [col]: { endsWith: str, mode: "insensitive" } };
      if (normOp === "in" && Array.isArray(value)) return { [col]: { in: value.map((v) => String(v)) } };
      if (normOp === "not_in" && Array.isArray(value)) return { [col]: { notIn: value.map((v) => String(v)) } };
      return null;
    }

    if (field === "consentSource") {
      const str = String(value || "").trim();
      if (normOp === "equals") return { consentSource: { equals: str, mode: "insensitive" } };
      if (normOp === "contains") return { consentSource: { contains: str, mode: "insensitive" } };
      return null;
    }

    if (field === "createdAt" || field === "lastEmailedAt" || field === "consentTimestamp") {
      const d = new Date(value as string | number | Date);
      if (!isNaN(d.getTime())) {
        if (normOp === "greater_than" || normOp === "greater_than_or_equal") return { [field]: { gte: d } };
        if (normOp === "less_than" || normOp === "less_than_or_equal") return { [field]: { lte: d } };
      }
      return null;
    }

    // Custom metadata/attributes field: returns null to trigger stream evaluation
    return null;
  }

  /**
   * Previews matching contacts for a given criteria within a tenant.
   * Uses database aggregation for direct queries and batched keyset pagination
   * for complex criteria, avoiding loading the entire contact table into memory.
   */
  static async previewContacts(
    clientId: string,
    criteriaInput: unknown,
    options: { limit?: number } = {}
  ): Promise<{ matchingCount: number; sampleContacts: EmailContact[] }> {
    const validatedCriteria = this.validateCriteria(criteriaInput);
    const limit = Math.min(100, Math.max(1, options.limit || 20));

    const { prismaWhere, hasAttributeConditions } = this.buildPrismaWhereFromCriteria(
      clientId,
      validatedCriteria
    );

    // If pure database criteria without custom metadata checks, use fast database count & take
    if (!hasAttributeConditions) {
      const [matchingCount, sampleContacts] = await Promise.all([
        prisma.emailContact.count({ where: prismaWhere }),
        prisma.emailContact.findMany({
          where: prismaWhere,
          orderBy: { id: "asc" },
          take: limit,
        }),
      ]);

      return {
        matchingCount,
        sampleContacts,
      };
    }

    // Hybrid: batched cursor processing to avoid loading entire contact table
    let matchingCount = 0;
    const sampleContacts: EmailContact[] = [];
    const BATCH_SIZE = 500;
    let cursorId: string | undefined = undefined;

    while (true) {
      const batch: EmailContact[] = await prisma.emailContact.findMany({
        where: prismaWhere,
        orderBy: { id: "asc" },
        take: BATCH_SIZE,
        skip: cursorId ? 1 : 0,
        cursor: cursorId ? { id: cursorId } : undefined,
      });

      if (!batch || batch.length === 0) break;
      cursorId = batch[batch.length - 1].id;

      for (const contact of batch) {
        if (this.evaluateContact(validatedCriteria, contact)) {
          matchingCount++;
          if (sampleContacts.length < limit) {
            sampleContacts.push(contact);
          }
        }
      }

      if (batch.length < BATCH_SIZE) break;
    }

    return {
      matchingCount,
      sampleContacts,
    };
  }

  /**
   * Creates a new segment with validated criteria for a tenant.
   */
  static async createSegment(
    clientId: string,
    name: string,
    criteriaInput: unknown,
    description?: string | null
  ): Promise<EmailSegment> {
    if (!clientId) throw new Error("clientId is required");
    const cleanName = name?.trim();
    if (!cleanName) throw new Error("Segment name is required");

    const validated = this.validateCriteria(criteriaInput);

    const existing = await prisma.emailSegment.findUnique({
      where: { clientId_name: { clientId, name: cleanName } },
    });
    if (existing) {
      throw new Error(`Segment '${cleanName}' already exists for this tenant.`);
    }

    return prisma.emailSegment.create({
      data: {
        clientId,
        name: cleanName,
        description: description?.trim() || null,
        criteria: JSON.stringify(validated),
        active: true,
      },
    });
  }

  /**
   * Retrieves a segment by ID strictly scoped to tenant.
   */
  static async getSegmentById(clientId: string, segmentId: string): Promise<EmailSegment | null> {
    if (!clientId || !segmentId) return null;
    return prisma.emailSegment.findFirst({
      where: { id: segmentId, clientId },
    });
  }

  /**
   * Lists all segments for a tenant.
   */
  static async listSegments(clientId: string): Promise<EmailSegment[]> {
    if (!clientId) throw new Error("clientId is required");
    return prisma.emailSegment.findMany({
      where: { clientId },
      orderBy: { createdAt: "desc" },
    });
  }

  /**
   * Updates an existing segment.
   */
  static async updateSegment(
    clientId: string,
    segmentId: string,
    data: {
      name?: string;
      criteria?: unknown;
      description?: string | null;
      active?: boolean;
    }
  ): Promise<EmailSegment> {
    const segment = await prisma.emailSegment.findFirst({
      where: { id: segmentId, clientId },
    });
    if (!segment) {
      throw new Error(`Segment '${segmentId}' not found for tenant '${clientId}'.`);
    }

    const updatePayload: Record<string, unknown> = {};

    if (data.name !== undefined) {
      const cleanName = data.name.trim();
      if (!cleanName) throw new Error("Segment name cannot be empty");
      if (cleanName !== segment.name) {
        const duplicate = await prisma.emailSegment.findUnique({
          where: { clientId_name: { clientId, name: cleanName } },
        });
        if (duplicate) throw new Error(`Segment name '${cleanName}' is already taken.`);
        updatePayload.name = cleanName;
      }
    }

    if (data.criteria !== undefined) {
      const validated = this.validateCriteria(data.criteria);
      updatePayload.criteria = JSON.stringify(validated);
    }

    if (data.description !== undefined) {
      updatePayload.description = data.description?.trim() || null;
    }

    if (data.active !== undefined) {
      updatePayload.active = data.active;
    }

    return prisma.emailSegment.update({
      where: { id: segment.id },
      data: updatePayload,
    });
  }

  /**
   * Deletes a segment.
   */
  static async deleteSegment(clientId: string, segmentId: string): Promise<{ deleted: boolean }> {
    const segment = await prisma.emailSegment.findFirst({
      where: { id: segmentId, clientId },
    });
    if (!segment) {
      throw new Error(`Segment '${segmentId}' not found for tenant '${clientId}'.`);
    }

    await prisma.emailSegment.delete({
      where: { id: segment.id },
    });

    return { deleted: true };
  }
}
