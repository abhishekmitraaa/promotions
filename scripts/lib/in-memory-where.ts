/**
 * Minimal Prisma `where` evaluator for in-memory test mocks.
 * Supports equality, null, in/notIn, lt/lte/gt/gte, not, startsWith/endsWith/contains,
 * and the OR / AND / NOT combinators. Compound unique keys (e.g. `clientId_idempotencyKey`)
 * are expanded into their fields.
 */

type Where = Record<string, unknown>;

function compare(a: unknown, b: unknown): number {
  const av = a instanceof Date ? a.getTime() : (a as number);
  const bv = b instanceof Date ? b.getTime() : (b as number);
  return av < bv ? -1 : av > bv ? 1 : 0;
}

function matchesField(value: unknown, condition: unknown): boolean {
  if (condition === null) return value === null || value === undefined;
  if (condition instanceof Date) return value instanceof Date && value.getTime() === condition.getTime();
  if (typeof condition !== "object") return value === condition;

  const c = condition as Record<string, unknown>;
  for (const [op, arg] of Object.entries(c)) {
    switch (op) {
      case "equals":
        if (!matchesField(value, arg)) return false;
        break;
      case "in":
        if (!(arg as unknown[]).includes(value)) return false;
        break;
      case "notIn":
        if ((arg as unknown[]).includes(value)) return false;
        break;
      case "lt":
        if (value === null || value === undefined || compare(value, arg) >= 0) return false;
        break;
      case "lte":
        if (value === null || value === undefined || compare(value, arg) > 0) return false;
        break;
      case "gt":
        if (value === null || value === undefined || compare(value, arg) <= 0) return false;
        break;
      case "gte":
        if (value === null || value === undefined || compare(value, arg) < 0) return false;
        break;
      case "not":
        if (matchesField(value, arg)) return false;
        break;
      case "startsWith":
        if (typeof value !== "string" || !value.startsWith(arg as string)) return false;
        break;
      case "endsWith":
        if (typeof value !== "string" || !value.endsWith(arg as string)) return false;
        break;
      case "contains":
        if (typeof value !== "string" || !value.includes(arg as string)) return false;
        break;
      default:
        throw new Error(`in-memory-where: unsupported operator '${op}'`);
    }
  }
  return true;
}

export function matchesWhere(record: Record<string, unknown>, where: Where | undefined): boolean {
  if (!where) return true;
  for (const [key, condition] of Object.entries(where)) {
    if (condition === undefined) continue;
    if (key === "OR") {
      if (!(condition as Where[]).some((w) => matchesWhere(record, w))) return false;
    } else if (key === "AND") {
      const parts = Array.isArray(condition) ? (condition as Where[]) : [condition as Where];
      if (!parts.every((w) => matchesWhere(record, w))) return false;
    } else if (key === "NOT") {
      const parts = Array.isArray(condition) ? (condition as Where[]) : [condition as Where];
      if (parts.some((w) => matchesWhere(record, w))) return false;
    } else if (key.includes("_") && condition && typeof condition === "object" && !Array.isArray(condition) && !(condition instanceof Date) && key.split("_").every((f) => f in (condition as Where))) {
      // Compound unique selector, e.g. { clientId_idempotencyKey: { clientId, idempotencyKey } }
      if (!matchesWhere(record, condition as Where)) return false;
    } else if (!matchesField(record[key], condition)) {
      return false;
    }
  }
  return true;
}

/** Applies a Prisma update `data` object (including { increment } / { decrement }) to a record. */
export function applyUpdate(record: Record<string, unknown>, data: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === "object" && !(value instanceof Date)) {
      const op = value as Record<string, number>;
      if ("increment" in op) {
        record[key] = ((record[key] as number) || 0) + op.increment;
        continue;
      }
      if ("decrement" in op) {
        record[key] = ((record[key] as number) || 0) - op.decrement;
        continue;
      }
    }
    record[key] = value;
  }
  record.updatedAt = new Date();
}
