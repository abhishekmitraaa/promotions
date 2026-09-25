/**
 * Controlled Email Segment Engine
 *
 * Implements strict, injection-proof audience segmentation:
 * - Accepts ONLY structured JSON criteria (strict allowlist of fields and operators)
 * - Zero arbitrary SQL or raw strings permitted
 * - Evaluates criteria safely against tenant-scoped EmailContact records
 * - In-memory and Prisma query translation
 */

import { prisma } from "../prisma";
import { EmailSegment, EmailContact } from "@prisma/client";

export type SegmentOperator =
  | "equals"
  | "not_equals"
  | "contains"
  | "starts_with"
  | "in"
  | "not_in";

export const ALLOWED_OPERATORS: readonly SegmentOperator[] = [
  "equals",
  "not_equals",
  "contains",
  "starts_with",
  "in",
  "not_in",
] as const;

export const ALLOWED_DIRECT_FIELDS: readonly string[] = [
  "marketingConsent",
  "verified",
  "status",
  "email",
  "firstName",
  "lastName",
] as const;

export interface SegmentCondition {
  field: string;
  operator: SegmentOperator;
  value: string | number | boolean | Array<string | number>;
}

export interface SegmentCriteria {
  conjunction?: "AND" | "OR";
  conditions: SegmentCondition[];
}

export class EmailSegmentService {
  /**
   * Validates structured segment criteria against strict allowlists.
   * Throws detailed errors if any field, operator, or value structure is invalid.
   */
  static validateCriteria(criteria: unknown): SegmentCriteria {
    if (!criteria || typeof criteria !== "object") {
      throw new Error("Segment criteria must be a valid JSON object.");
    }

    const { conjunction = "AND", conditions } = criteria as Partial<SegmentCriteria>;

    if (conjunction !== "AND" && conjunction !== "OR") {
      throw new Error("Conjunction must be either 'AND' or 'OR'.");
    }

    if (!Array.isArray(conditions) || conditions.length === 0) {
      throw new Error("Segment criteria must contain a non-empty 'conditions' array.");
    }

    for (let i = 0; i < conditions.length; i++) {
      const cond = conditions[i];
      if (!cond || typeof cond !== "object") {
        throw new Error(`Condition ${i + 1} must be an object.`);
      }

      const { field, operator, value } = cond;

      if (!field || typeof field !== "string") {
        throw new Error(`Condition ${i + 1}: 'field' must be a non-empty string.`);
      }

      // Check field allowlist: either a direct field or an attribute field (e.g., 'attributes.city', 'attributes.category', 'city', 'category')
      const isDirect = (ALLOWED_DIRECT_FIELDS as readonly string[]).includes(field);
      const isAttribute = field.startsWith("attributes.") || field === "city" || field === "category";

      if (!isDirect && !isAttribute) {
        throw new Error(`Unsupported segment field '${field}'. Allowed fields: ${ALLOWED_DIRECT_FIELDS.join(", ")}, or 'attributes.<customField>'`);
      }

      // Attribute field name sanity check (prevent injection via property paths)
      if (isAttribute) {
        const attrName = field.startsWith("attributes.") ? field.replace("attributes.", "") : field;
        if (!/^[a-zA-Z0-9_]{1,50}$/.test(attrName)) {
          throw new Error(`Invalid attribute name in field '${field}'. Only alphanumeric and underscores allowed.`);
        }
      }

      // Check operator allowlist
      if (!ALLOWED_OPERATORS.includes(operator)) {
        throw new Error(`Unsupported operator '${operator}'. Allowed operators: ${ALLOWED_OPERATORS.join(", ")}`);
      }

      // Check for SQL injection patterns in strings
      if (typeof value === "string") {
        const suspicious = /(--|;|\/\*|\*\/|union\s+select|drop\s+table)/i;
        if (suspicious.test(value)) {
          throw new Error(`Dangerous characters or SQL keywords detected in condition ${i + 1}.`);
        }
      }

      // Value type checks based on operator
      if (operator === "in" || operator === "not_in") {
        if (!Array.isArray(value) || value.length === 0) {
          throw new Error(`Operator '${operator}' requires a non-empty array value in condition ${i + 1}.`);
        }
      } else if (Array.isArray(value)) {
        throw new Error(`Operator '${operator}' cannot accept an array value in condition ${i + 1}.`);
      }

      // Specific field type checks
      if (field === "marketingConsent" || field === "verified") {
        if (typeof value !== "boolean" && value !== "true" && value !== "false") {
          throw new Error(`Field '${field}' must have a boolean value in condition ${i + 1}.`);
        }
      }
    }

    return {
      conjunction,
      conditions: conditions.map((c) => ({
        field: c.field,
        operator: c.operator,
        value: c.field === "marketingConsent" || c.field === "verified"
          ? String(c.value) === "true"
          : c.value,
      })),
    };
  }

  /**
   * Evaluates a single contact against segment criteria in-memory.
   */
  static evaluateContact(criteria: SegmentCriteria, contact: EmailContact): boolean {
    const isAnd = (criteria.conjunction || "AND") === "AND";

    let metadata: Record<string, unknown> = {};
    if (contact.metadata) {
      try {
        metadata = JSON.parse(contact.metadata);
      } catch {
        metadata = {};
      }
    }

    for (const condition of criteria.conditions) {
      const match = this.evaluateCondition(condition, contact, metadata);
      if (isAnd && !match) return false;
      if (!isAnd && match) return true;
    }

    return isAnd;
  }

  private static evaluateCondition(
    condition: SegmentCondition,
    contact: EmailContact,
    metadata: Record<string, unknown>
  ): boolean {
    const { field, operator, value } = condition;
    let actualValue: unknown;

    if (field === "marketingConsent") {
      actualValue = contact.hasMarketingConsent;
    } else if (field === "verified") {
      actualValue = contact.verified;
    } else if (field === "status") {
      actualValue = contact.status;
    } else if (field === "email") {
      actualValue = contact.email;
    } else if (field === "firstName") {
      actualValue = contact.firstName || "";
    } else if (field === "lastName") {
      actualValue = contact.lastName || "";
    } else {
      // Attribute field (e.g. 'attributes.city' or 'city')
      const attrKey = field.startsWith("attributes.") ? field.replace("attributes.", "") : field;
      actualValue = metadata[attrKey];
    }

    // Compare actualValue with expected value
    switch (operator) {
      case "equals":
        if (typeof actualValue === "string" && typeof value === "string") {
          return actualValue.toLowerCase() === value.toLowerCase();
        }
        return actualValue === value;

      case "not_equals":
        if (typeof actualValue === "string" && typeof value === "string") {
          return actualValue.toLowerCase() !== value.toLowerCase();
        }
        return actualValue !== value;

      case "contains":
        if (actualValue === null || actualValue === undefined) return false;
        return String(actualValue).toLowerCase().includes(String(value).toLowerCase());

      case "starts_with":
        if (actualValue === null || actualValue === undefined) return false;
        return String(actualValue).toLowerCase().startsWith(String(value).toLowerCase());

      case "in":
        if (!Array.isArray(value)) return false;
        return value.some((v) => {
          if (typeof actualValue === "string" && typeof v === "string") {
            return actualValue.toLowerCase() === v.toLowerCase();
          }
          return actualValue === v;
        });

      case "not_in":
        if (!Array.isArray(value)) return true;
        return !value.some((v) => {
          if (typeof actualValue === "string" && typeof v === "string") {
            return actualValue.toLowerCase() === v.toLowerCase();
          }
          return actualValue === v;
        });

      default:
        return false;
    }
  }

  /**
   * Previews matching contacts for a given criteria within a tenant.
   */
  static async previewContacts(
    clientId: string,
    criteriaInput: unknown,
    options: { limit?: number } = {}
  ): Promise<{ matchingCount: number; sampleContacts: EmailContact[] }> {
    const validatedCriteria = this.validateCriteria(criteriaInput);
    const limit = Math.min(100, Math.max(1, options.limit || 20));

    // Load tenant contacts
    const contacts = await prisma.emailContact.findMany({
      where: { clientId },
      take: 1000, // Safe preview ceiling
    });

    const matching = contacts.filter((c) => this.evaluateContact(validatedCriteria, c));

    return {
      matchingCount: matching.length,
      sampleContacts: matching.slice(0, limit),
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
