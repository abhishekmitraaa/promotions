/**
 * Unified Tenant Isolation & Boundary Security
 *
 * Enforces multi-tenant perimeter controls across all channels:
 * - Every request, contact, suppression, campaign, and template must carry a valid clientId.
 * - Prevents cross-tenant data leaks and verifies boundary compliance.
 */

import { ChannelType } from "./types";

export class TenantBoundaryViolationError extends Error {
  constructor(message: string, public readonly clientId?: string) {
    super(`[TenantBoundaryViolation] ${message}`);
    this.name = "TenantBoundaryViolationError";
  }
}

/**
 * Validates that an entity possesses a non-empty, valid clientId.
 */
export function assertTenantContext<T extends { clientId: string }>(
  entity: T,
  contextName = "Entity"
): asserts entity is T & { clientId: string } {
  if (!entity || !entity.clientId || typeof entity.clientId !== "string" || entity.clientId.trim() === "") {
    throw new TenantBoundaryViolationError(
      `${contextName} is missing a required clientId. Multi-tenant isolation violation.`,
      entity?.clientId
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
    // Default to true if enabledChannels not explicitly restricted
    return true;
  }
  // If string clientId provided, valid non-empty ID is enabled
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
