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
import { EmailSegment, EmailContact, EmailContactStatus, Prisma } from "@prisma/client";

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
  "hasMarketingConsent",
  "verified",
  "status",
  "email",
  "normalizedEmail",
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

      // Check operator allowlist (case-insensitive)
      const normalizedOp = (operator || "").toLowerCase() as SegmentOperator;
      if (!ALLOWED_OPERATORS.includes(normalizedOp)) {
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
      if (normalizedOp === "in" || normalizedOp === "not_in") {
        if (!Array.isArray(value) || value.length === 0) {
          throw new Error(`Operator '${operator}' requires a non-empty array value in condition ${i + 1}.`);
        }
      } else if (Array.isArray(value)) {
        throw new Error(`Operator '${operator}' cannot accept an array value in condition ${i + 1}.`);
      }

      // Specific field type checks
      if (field === "marketingConsent" || field === "hasMarketingConsent" || field === "verified") {
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
        value: c.field === "marketingConsent" || c.field === "hasMarketingConsent" || c.field === "verified"
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
    const { field, value } = condition;
    const operator = (condition.operator || "").toLowerCase();
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
   * Translates structured segment criteria into parameterized Prisma where clauses.
   * Direct fields are converted into native Prisma filters.
   * Attribute fields trigger pre-filters where practical and indicate attribute evaluation needed.
   */
  static buildPrismaWhereFromCriteria(
    clientId: string,
    criteria: SegmentCriteria
  ): {
    prismaWhere: Prisma.EmailContactWhereInput;
    hasAttributeConditions: boolean;
  } {
    const isAnd = (criteria.conjunction || "AND") === "AND";
    const directFilters: Prisma.EmailContactWhereInput[] = [];
    let hasAttributeConditions = false;

    for (const condition of criteria.conditions) {
      const direct = this.translateConditionToPrisma(condition);
      if (direct) {
        directFilters.push(direct);
      } else {
        hasAttributeConditions = true;
        if (isAnd) {
          directFilters.push({ metadata: { not: null } });
        }
      }
    }

    let criteriaFilter: Prisma.EmailContactWhereInput = {};
    if (isAnd) {
      if (directFilters.length > 0) {
        criteriaFilter = { AND: directFilters };
      }
    } else {
      // OR conjunction
      if (directFilters.length > 0 && !hasAttributeConditions) {
        criteriaFilter = { OR: directFilters };
      }
    }

    return {
      prismaWhere: {
        clientId,
        ...criteriaFilter,
      },
      hasAttributeConditions,
    };
  }

  private static translateConditionToPrisma(
    condition: SegmentCondition
  ): Prisma.EmailContactWhereInput | null {
    const { field, value } = condition;
    const operator = (condition.operator || "").toLowerCase();

    if (field === "marketingConsent" || field === "hasMarketingConsent") {
      const b = typeof value === "boolean" ? value : String(value) === "true";
      if (operator === "equals") return { hasMarketingConsent: b };
      if (operator === "not_equals") return { hasMarketingConsent: !b };
      return null;
    }

    if (field === "verified") {
      const b = typeof value === "boolean" ? value : String(value) === "true";
      if (operator === "equals") return { verified: b };
      if (operator === "not_equals") return { verified: !b };
      return null;
    }

    if (field === "status") {
      const s = value as EmailContactStatus;
      if (operator === "equals") return { status: s };
      if (operator === "not_equals") return { status: { not: s } };
      if (operator === "in" && Array.isArray(value)) return { status: { in: value as EmailContactStatus[] } };
      if (operator === "not_in" && Array.isArray(value)) return { status: { notIn: value as EmailContactStatus[] } };
      return null;
    }

    if (field === "email" || field === "normalizedEmail") {
      const str = String(value).trim();
      if (operator === "equals") return { normalizedEmail: str.toLowerCase() };
      if (operator === "not_equals") return { normalizedEmail: { not: str.toLowerCase() } };
      if (operator === "contains") return { email: { contains: str, mode: "insensitive" } };
      if (operator === "starts_with") return { email: { startsWith: str, mode: "insensitive" } };
      if (operator === "in" && Array.isArray(value)) {
        return { normalizedEmail: { in: value.map((v) => String(v).trim().toLowerCase()) } };
      }
      if (operator === "not_in" && Array.isArray(value)) {
        return { normalizedEmail: { notIn: value.map((v) => String(v).trim().toLowerCase()) } };
      }
      return null;
    }

    if (field === "firstName") {
      const str = String(value);
      if (operator === "equals") return { firstName: { equals: str, mode: "insensitive" } };
      if (operator === "not_equals") return { firstName: { not: str } };
      if (operator === "contains") return { firstName: { contains: str, mode: "insensitive" } };
      if (operator === "starts_with") return { firstName: { startsWith: str, mode: "insensitive" } };
      if (operator === "in" && Array.isArray(value)) return { firstName: { in: value.map((v) => String(v)) } };
      if (operator === "not_in" && Array.isArray(value)) return { firstName: { notIn: value.map((v) => String(v)) } };
      return null;
    }

    if (field === "lastName") {
      const str = String(value);
      if (operator === "equals") return { lastName: { equals: str, mode: "insensitive" } };
      if (operator === "not_equals") return { lastName: { not: str } };
      if (operator === "contains") return { lastName: { contains: str, mode: "insensitive" } };
      if (operator === "starts_with") return { lastName: { startsWith: str, mode: "insensitive" } };
      if (operator === "in" && Array.isArray(value)) return { lastName: { in: value.map((v) => String(v)) } };
      if (operator === "not_in" && Array.isArray(value)) return { lastName: { notIn: value.map((v) => String(v)) } };
      return null;
    }

    // Attribute field: evaluated in batch / in-memory
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

    // If pure direct criteria without attribute checks, use fast database count & take
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

      if (batch.length === 0) break;
      cursorId = batch[batch.length - 1].id;

      for (const contact of batch) {
        if (this.evaluateContact(validatedCriteria, contact)) {
          matchingCount++;
          if (sampleContacts.length < limit) {
            sampleContacts.push(contact);
          }
        }
      }
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
