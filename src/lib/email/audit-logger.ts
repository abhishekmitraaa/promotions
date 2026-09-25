/**
 * High-Impact Operations Audit Logger
 *
 * Implements structured security audit logging for administrative actions:
 * - Records actor (user email or API key), action, tenant ID, and timestamp.
 * - Enforces zero-credential logging: secrets, tokens, and passwords are automatically redacted.
 * - Persists audit trails to structured logs and memory ring-buffer for dashboard inspection.
 */

import { logger } from "../logger";

export type AuditAction =
  | "PROVIDER_CONNECTED"
  | "PROVIDER_REVOKED"
  | "SENDER_IDENTITY_CREATED"
  | "SENDER_IDENTITY_DELETED"
  | "CAMPAIGN_CREATED"
  | "CAMPAIGN_SCHEDULED"
  | "CAMPAIGN_CANCELLED"
  | "CAMPAIGN_PAUSED"
  | "SUPPRESSION_MANUALLY_ADDED"
  | "SUPPRESSION_MANUALLY_REMOVED"
  | "TEMPLATE_CREATED"
  | "TEMPLATE_ARCHIVED";

export interface AuditRecord {
  id: string;
  clientId: string;
  actor: string;
  action: AuditAction;
  resourceId?: string;
  details?: Record<string, unknown>;
  timestamp: Date;
}

// In-memory ring buffer of recent audit entries (keeps latest 200 entries)
const recentAudits: AuditRecord[] = [];
const MAX_AUDIT_ENTRIES = 200;

export class EmailAuditLogger {
  /**
   * Records a high-impact administrative audit event.
   * Strips all credential/secret fields from details before logging.
   */
  static log(
    clientId: string,
    actor: string,
    action: AuditAction,
    resourceId?: string,
    details?: Record<string, unknown>
  ): AuditRecord {
    const sanitizedDetails = this.sanitizeDetails(details);

    const record: AuditRecord = {
      id: `aud-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      clientId,
      actor,
      action,
      resourceId,
      details: sanitizedDetails,
      timestamp: new Date(),
    };

    recentAudits.unshift(record);
    if (recentAudits.length > MAX_AUDIT_ENTRIES) {
      recentAudits.pop();
    }

    logger.info(
      `[AUDIT] action=${action} tenant=${clientId} actor=${actor} resource=${resourceId || "none"}`
    );

    return record;
  }

  /**
   * Retrieves recent audit entries for a tenant.
   */
  static getRecent(clientId: string, limit: number = 20): AuditRecord[] {
    return recentAudits
      .filter((r) => r.clientId === clientId)
      .slice(0, limit);
  }

  /**
   * Redacts sensitive keys from audit details.
   */
  private static sanitizeDetails(
    details?: Record<string, unknown>
  ): Record<string, unknown> | undefined {
    if (!details) return undefined;

    const blockedKeys = new Set([
      "refreshtoken",
      "accesstoken",
      "clientsecret",
      "secret",
      "password",
      "credentials",
      "token",
      "auth",
      "key",
      "apikey",
    ]);

    const sanitized: Record<string, unknown> = {};

    for (const [key, val] of Object.entries(details)) {
      if (blockedKeys.has(key.toLowerCase().replace(/[^a-z]/g, ""))) {
        sanitized[key] = "[REDACTED]";
      } else if (typeof val === "object" && val !== null && !Array.isArray(val)) {
        sanitized[key] = this.sanitizeDetails(val as Record<string, unknown>);
      } else {
        sanitized[key] = val;
      }
    }

    return sanitized;
  }
}
