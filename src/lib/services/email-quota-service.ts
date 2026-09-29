import { prisma } from "../prisma";
import { EmailDeliveryStatus, EmailProviderType } from "@prisma/client";

export type QuotaStatus = "NORMAL" | "WARNING" | "CRITICAL" | "EXHAUSTED";

export interface ProviderQuotaInfo {
  providerConfigId: string;
  providerName: string;
  providerType: EmailProviderType;
  senderEmail: string | null;
  dailyLimit: number;
  sentToday: number;
  remaining: number;
  percentUsed: number;
  hourlyRate: number;
  status: QuotaStatus;
  resetAt: string; // ISO date string
}

export class EmailQuotaService {
  /**
   * Default daily limits based on industry standards & provider policies
   */
  getDefaultDailyLimit(providerType: EmailProviderType, metadata?: string | null): number {
    if (metadata) {
      try {
        const parsed = JSON.parse(metadata);
        if (typeof parsed.dailyQuota === "number" && parsed.dailyQuota > 0) {
          return parsed.dailyQuota;
        }
      } catch {
        // Fall back to default
      }
    }

    switch (providerType) {
      case EmailProviderType.GMAIL:
        // Standard Google Workspace limit (2,000/day) vs Consumer (500/day)
        return 2000;
      case EmailProviderType.SES:
        return 50000;
      case EmailProviderType.SMTP:
        return 10000;
      case EmailProviderType.MOCK:
      default:
        return 100000;
    }
  }

  /**
   * Retrieves quota consumption for all active providers under a tenant
   */
  async getTenantQuotas(clientId: string): Promise<ProviderQuotaInfo[]> {
    const providers = await prisma.emailProviderConfig.findMany({
      where: { clientId },
      orderBy: { isDefault: "desc" },
    });

    const now = new Date();
    const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0));
    const nextReset = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000);
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

    const quotas: ProviderQuotaInfo[] = [];

    for (const provider of providers) {
      const dailyLimit = this.getDefaultDailyLimit(provider.providerType, provider.configMetadata);

      // Count sent deliveries today for this provider
      const [sentToday, sentLastHour] = await Promise.all([
        prisma.emailDelivery.count({
          where: {
            clientId,
            providerType: provider.providerType,
            sentAt: { gte: startOfDay },
            status: { in: [EmailDeliveryStatus.SENT, EmailDeliveryStatus.DELIVERED, EmailDeliveryStatus.PROCESSING] },
          },
        }),
        prisma.emailDelivery.count({
          where: {
            clientId,
            providerType: provider.providerType,
            sentAt: { gte: oneHourAgo },
            status: { in: [EmailDeliveryStatus.SENT, EmailDeliveryStatus.DELIVERED, EmailDeliveryStatus.PROCESSING] },
          },
        }),
      ]);

      const percentUsed = Math.min(100, parseFloat(((sentToday / dailyLimit) * 100).toFixed(1)));
      const remaining = Math.max(0, dailyLimit - sentToday);

      let status: QuotaStatus = "NORMAL";
      if (percentUsed >= 100) status = "EXHAUSTED";
      else if (percentUsed >= 95) status = "CRITICAL";
      else if (percentUsed >= 80) status = "WARNING";

      quotas.push({
        providerConfigId: provider.id,
        providerName: provider.name,
        providerType: provider.providerType,
        senderEmail: provider.senderEmail,
        dailyLimit,
        sentToday,
        remaining,
        percentUsed,
        hourlyRate: sentLastHour,
        status,
        resetAt: nextReset.toISOString(),
      });
    }

    return quotas;
  }

  /**
   * Pre-flight quota check before dispatching an email
   */
  async checkQuotaAvailable(
    clientId: string,
    providerType: EmailProviderType
  ): Promise<{ allowed: boolean; remaining: number; resetAt: string; reason?: string }> {
    const now = new Date();
    const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0));
    const nextReset = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000);

    const providerConfig = await prisma.emailProviderConfig.findFirst({
      where: { clientId, providerType, status: "ACTIVE" },
    });

    const dailyLimit = this.getDefaultDailyLimit(providerType, providerConfig?.configMetadata);

    const sentToday = await prisma.emailDelivery.count({
      where: {
        clientId,
        providerType,
        sentAt: { gte: startOfDay },
        status: { in: [EmailDeliveryStatus.SENT, EmailDeliveryStatus.DELIVERED, EmailDeliveryStatus.PROCESSING] },
      },
    });

    const remaining = dailyLimit - sentToday;
    if (remaining <= 0) {
      return {
        allowed: false,
        remaining: 0,
        resetAt: nextReset.toISOString(),
        reason: `Daily provider quota of ${dailyLimit} emails has been exhausted for ${providerType}. Quota resets at 00:00 UTC.`,
      };
    }

    return {
      allowed: true,
      remaining,
      resetAt: nextReset.toISOString(),
    };
  }
}

export const emailQuotaService = new EmailQuotaService();
