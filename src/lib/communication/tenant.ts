/**
 * Shared Tenant Isolation & Boundary Model
 *
 * Provides multi-tenant guarantees across all communication channels.
 * Every cross-channel operation (send, fetch, campaign, suppression, consent, analytics)
 * MUST be scoped strictly to a verified `clientId`.
 */

import { ChannelType } from "./types";

export interface TenantContext {
  clientId: string;
  name?: string;
  enabledChannels?: ChannelType[];
  rateLimits?: Partial<Record<ChannelType, { maxPerSecond: number; maxPerDay: number }>>;
  metadata?: Record<string, unknown>;
}

export class TenantIsolationViolationError extends Error {
  constructor(message: string) {
    super(`[TenantIsolationViolationError] ${message}`);
    this.name = "TenantIsolationViolationError";
  }
}

export class TenantMissingError extends Error {
  constructor(message: string = "clientId is required for all communication operations") {
    super(`[TenantMissingError] ${message}`);
    this.name = "TenantMissingError";
  }
}

/**
 * Validates and standardizes a tenant context or clientId string.
 */
export function assertTenantContext(context: TenantContext | string | undefined | null): TenantContext {
  if (!context) {
    throw new TenantMissingError();
  }

  const clientId = typeof context === "string" ? context.trim() : context.clientId?.trim();

  if (!clientId || clientId.length === 0) {
    throw new TenantMissingError();
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
  entityName: string = "Entity"
): void {
  if (!expectedClientId) {
    throw new TenantMissingError(`Expected clientId is required to assert ${entityName} boundary`);
  }

  if (!entity.clientId || entity.clientId !== expectedClientId) {
    throw new TenantIsolationViolationError(
      `Cross-tenant access prohibited for ${entityName}: entity belongs to '${entity.clientId || "UNBOUND"}', but caller is '${expectedClientId}'`
    );
  }
}

/**
 * Checks whether the given tenant context is permitted to use the specified channel.
 */
export function isChannelEnabledForTenant(
  context: TenantContext,
  channel: ChannelType
): boolean {
  if (!context.enabledChannels || context.enabledChannels.length === 0) {
    // By default, WhatsApp and Email are standard channels; SMS and PUSH can be enabled
    return true;
  }
  return context.enabledChannels.includes(channel);
}
