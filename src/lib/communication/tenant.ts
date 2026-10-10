/**
 * Unified Tenant Isolation & Boundary Security
 *
 * Enforces multi-tenant perimeter controls across all channels:
 * - Every request, contact, suppression, campaign, and template must carry a valid clientId.
 * - Prevents cross-tenant data leaks and verifies boundary compliance.
 */

import { ChannelType } from "./types";

export interface TenantContext {
  clientId: string;
  name?: string;
  enabledChannels?: ChannelType[];
  rateLimits?: Partial<Record<ChannelType, { maxPerSecond: number; maxPerDay: number }>>;
  metadata?: Record<string, unknown>;
}

export class TenantBoundaryViolationError extends Error {
  constructor(message: string, public readonly clientId?: string) {
    super(`[TenantBoundaryViolation] ${message}`);
    this.name = "TenantBoundaryViolationError";
  }
}

export class TenantIsolationViolationError extends TenantBoundaryViolationError {
  constructor(message: string, clientId?: string) {
    super(`[TenantIsolationViolationError] ${message}`, clientId);
    this.name = "TenantIsolationViolationError";
  }
}

export class TenantMissingError extends TenantBoundaryViolationError {
  constructor(message: string = "clientId is required for all communication operations", clientId?: string) {
    super(`[TenantMissingError] ${message}`, clientId);
    this.name = "TenantMissingError";
  }
}

/**
 * Validates and standardizes a tenant context or clientId string.
 */
export function assertTenantContext(
  context: TenantContext | { clientId: string } | string | undefined | null,
  contextName = "Entity"
): TenantContext {
  if (!context) {
    throw new TenantMissingError(`${contextName} is missing a required clientId.`);
  }

  const clientId = typeof context === "string" ? context.trim() : context.clientId?.trim();

  if (!clientId || clientId.length === 0) {
    throw new TenantMissingError(
      `${contextName} is missing a required clientId. Multi-tenant isolation violation.`
    );
  }

  if (typeof context === "string") {
    return { clientId };
  }

  return {
    ...context,
    clientId,
  };
}

/**
 * Enforces that an entity's clientId matches the execution context clientId.
 * Prevents horizontal privilege escalation and cross-tenant data leakage.
 */
export function assertTenantBoundary<T extends { clientId?: string | null }>(
  entity: T,
  expectedClientId: string,
  entityName = "Entity"
): void {
  if (!expectedClientId || expectedClientId.trim() === "") {
    throw new TenantMissingError(`Expected clientId is required to assert ${entityName} boundary`);
  }

  if (!entity.clientId || entity.clientId !== expectedClientId) {
    throw new TenantIsolationViolationError(
      `Cross-tenant access prohibited for ${entityName}: entity belongs to '${entity.clientId || "UNBOUND"}', but caller is '${expectedClientId}'`,
      entity.clientId || undefined
    );
  }
}

/**
 * Checks whether a given communication channel is permitted/enabled for a tenant.
 */
export function isChannelEnabledForTenant(
  clientOrId: string | { clientId: string; enabledChannels?: ChannelType[] },
  channel: ChannelType
): boolean {
  if (typeof clientOrId === "object" && clientOrId !== null) {
    if (clientOrId.enabledChannels && Array.isArray(clientOrId.enabledChannels)) {
      return clientOrId.enabledChannels.includes(channel);
    }
    return true;
  }
  return typeof clientOrId === "string" && clientOrId.trim().length > 0;
}

/**
 * Validates that two entities belong to the exact same tenant.
 */
export function assertSameTenant(
  entityA: { clientId: string },
  entityB: { clientId: string },
  contextDescription = "Cross-entity operation"
): void {
  assertTenantContext(entityA, "Entity A");
  assertTenantContext(entityB, "Entity B");

  if (entityA.clientId !== entityB.clientId) {
    throw new TenantBoundaryViolationError(
      `${contextDescription}: Mismatched clientIds detected (${entityA.clientId} vs ${entityB.clientId}). Isolation breach prevented.`,
      entityA.clientId
    );
  }
}

/**
 * Helper to wrap Prisma queries with explicit tenant scoping.
 */
export function scopeToTenant<T extends Record<string, unknown>>(
  clientId: string,
  filter: T = {} as T
): T & { clientId: string } {
  if (!clientId || typeof clientId !== "string" || clientId.trim() === "") {
    throw new TenantBoundaryViolationError("Cannot scope query without a valid clientId.");
  }
  return {
    ...filter,
    clientId,
  };
}
