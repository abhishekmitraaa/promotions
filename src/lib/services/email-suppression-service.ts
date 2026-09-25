/**
 * Email Suppression Management Service
 *
 * Implements tenant-scoped suppression list enforcement:
 * - Checks suppression prior to marketing email queueing
 * - Validates suppression at worker dispatch time
 * - Supports reasons: HARD_BOUNCE, COMPLAINT, UNSUBSCRIBED, MANUAL, INVALID
 * - Automatically cascades suppression status to tenant EmailContact records
 */

import { prisma } from "../prisma";
import { normalizeEmail } from "../email/normalization";
import { EmailSuppression, EmailSuppressionReason, EmailContactStatus } from "@prisma/client";

export class EmailSuppressionService {
  /**
   * Adds an email address to a tenant's suppression list.
   * Also updates any matching EmailContact record to prevent future marketing emails.
   */
  static async addSuppression(
    clientId: string,
    email: string,
    reason: EmailSuppressionReason,
    source?: string | null,
    metadata?: Record<string, unknown> | null
  ): Promise<EmailSuppression> {
    if (!clientId) throw new Error("clientId is required");
    const normalized = normalizeEmail(email);

    // Upsert suppression entry
    const suppression = await prisma.emailSuppression.upsert({
      where: {
        clientId_normalizedEmail: {
          clientId,
          normalizedEmail: normalized,
        },
      },
      create: {
        clientId,
        email: email.trim(),
        normalizedEmail: normalized,
        reason,
        source: source?.trim() || null,
        metadata: metadata ? JSON.stringify(metadata) : null,
      },
      update: {
        reason,
        source: source?.trim() || null,
        metadata: metadata ? JSON.stringify(metadata) : null,
        updatedAt: new Date(),
      },
    });

    // Cascade to contact record if it exists in the tenant
    try {
      const contactStatus =
        reason === EmailSuppressionReason.UNSUBSCRIBED
          ? EmailContactStatus.UNSUBSCRIBED
          : EmailContactStatus.SUPPRESSED;

      await prisma.emailContact.updateMany({
        where: { clientId, normalizedEmail: normalized },
        data: {
          hasMarketingConsent: false,
          status: contactStatus,
          unsubscribedAt: new Date(),
          unsubscribeReason: source || `SUPPRESSION_${reason}`,
        },
      });
    } catch {
      // Non-fatal if contact does not exist
    }

    return suppression;
  }

  /**
   * Checks whether an email address is currently suppressed for a tenant.
   */
  static async isSuppressed(
    clientId: string,
    email: string
  ): Promise<{ suppressed: boolean; reason?: EmailSuppressionReason; createdAt?: Date }> {
    if (!clientId || !email) return { suppressed: false };

    try {
      const normalized = normalizeEmail(email);
      const record = await prisma.emailSuppression.findUnique({
        where: {
          clientId_normalizedEmail: {
            clientId,
            normalizedEmail: normalized,
          },
        },
      });

      if (record) {
        return {
          suppressed: true,
          reason: record.reason,
          createdAt: record.createdAt,
        };
      }
    } catch {
      return { suppressed: false };
    }

    return { suppressed: false };
  }

  /**
   * Removes an email from the suppression list (admin override / rehabilitation).
   */
  static async removeSuppression(clientId: string, email: string): Promise<{ removed: boolean }> {
    if (!clientId) throw new Error("clientId is required");
    const normalized = normalizeEmail(email);

    try {
      await prisma.emailSuppression.delete({
        where: {
          clientId_normalizedEmail: {
            clientId,
            normalizedEmail: normalized,
          },
        },
      });
      return { removed: true };
    } catch {
      return { removed: false };
    }
  }

  /**
   * Lists suppressions for a tenant with pagination.
   */
  static async listSuppressions(
    clientId: string,
    options: {
      page?: number;
      limit?: number;
      reason?: EmailSuppressionReason;
    } = {}
  ): Promise<{
    suppressions: EmailSuppression[];
    total: number;
    page: number;
    limit: number;
  }> {
    if (!clientId) throw new Error("clientId is required");

    const page = Math.max(1, options.page || 1);
    const limit = Math.min(100, Math.max(1, options.limit || 50));
    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = { clientId };
    if (options.reason) {
      where.reason = options.reason;
    }

    const [suppressions, total] = await Promise.all([
      prisma.emailSuppression.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
      }),
      prisma.emailSuppression.count({ where }),
    ]);

    return { suppressions, total, page, limit };
  }
}
