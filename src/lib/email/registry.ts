/**
 * Email Provider Registry & Resolver
 *
 * Implements provider abstraction and resolution.
 * Decouples EmailService from specific provider implementations (Gmail, SES, Mock).
 */

import { EmailProvider, EmailProviderType } from "./types";
import { GmailProvider } from "./providers/gmail/gmail-provider";
import { prisma } from "../prisma";
import { EmailProviderStatus } from "@prisma/client";

export type ProviderFactory = (config: {
  encryptedCredentials?: string;
  senderEmail?: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}) => EmailProvider;

class EmailProviderRegistry {
  private factories = new Map<EmailProviderType, ProviderFactory>();

  constructor() {
    // Register Gmail provider factory as the first provider
    this.register(EmailProviderType.GMAIL, (opts) => new GmailProvider(opts));
  }

  /**
   * Registers a provider factory for a given provider type.
   */
  register(type: EmailProviderType, factory: ProviderFactory): void {
    this.factories.set(type, factory);
  }

  /**
   * Checks if a provider type is registered.
   */
  has(type: EmailProviderType): boolean {
    return this.factories.has(type);
  }

  /**
   * Instantiates an EmailProvider adapter for a given type and configuration.
   */
  get(type: EmailProviderType, options: {
    encryptedCredentials?: string;
    senderEmail?: string;
    timeoutMs?: number;
    fetchFn?: typeof fetch;
  } = {}): EmailProvider {
    const factory = this.factories.get(type);
    if (!factory) {
      throw new Error(`Email provider '${type}' is not registered in the provider registry`);
    }
    return factory(options);
  }

  /**
   * Resolves the configured, active provider for a tenant.
   * If providerConfigId is specified, loads that configuration.
   * Otherwise, loads the tenant's default active provider configuration.
   */
  async resolveForTenant(
    clientId: string,
    providerConfigId?: string,
    overrides?: { fetchFn?: typeof fetch }
  ): Promise<{ provider: EmailProvider; configId: string; senderEmail?: string; providerType: EmailProviderType }> {
    const whereClause = providerConfigId
      ? { id: providerConfigId, clientId, status: EmailProviderStatus.ACTIVE }
      : { clientId, status: EmailProviderStatus.ACTIVE, isDefault: true };

    let config = await prisma.emailProviderConfig.findFirst({
      where: whereClause,
    });

    // If no default found, fallback to any active provider config for the tenant
    if (!config && !providerConfigId) {
      config = await prisma.emailProviderConfig.findFirst({
        where: { clientId, status: EmailProviderStatus.ACTIVE },
        orderBy: { createdAt: "desc" },
      });
    }

    if (!config) {
      throw new Error(`No active email provider configured for tenant '${clientId}'`);
    }

    if (!config.encryptedCredentials) {
      throw new Error(`Configured email provider '${config.id}' is missing credentials`);
    }

    const provider = this.get(config.providerType, {
      encryptedCredentials: config.encryptedCredentials,
      senderEmail: config.senderEmail || undefined,
      fetchFn: overrides?.fetchFn,
    });

    return {
      provider,
      configId: config.id,
      senderEmail: config.senderEmail || undefined,
      providerType: config.providerType,
    };
  }
}

export const providerRegistry = new EmailProviderRegistry();

export function getEmailProvider(type: EmailProviderType, options?: {
  encryptedCredentials?: string;
  senderEmail?: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}): EmailProvider {
  return providerRegistry.get(type, options);
}
