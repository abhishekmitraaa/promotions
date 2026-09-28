/**
 * Email Provider Registry & Resolver
 *
 * Implements provider abstraction, resolution, and health verification.
 * Decouples EmailService from specific provider implementations.
 *
 * Near-Term Production Strategy: Gmail-only
 * - Google Workspace / Gmail API via OAuth 2.0 is the active supported provider.
 * - SES and SMTP adapters are not in near-term scope and are explicitly unavailable.
 * - MOCK provider is strictly restricted to test/dev environments and forbidden in production.
 * - Silent fallback across providers is strictly prohibited.
 */

import {
  EmailProvider,
  EmailProviderType,
  EmailSendRequest,
  EmailSendResult,
  EmailProviderHealthResult,
} from "./types";
import { GmailProvider } from "./providers/gmail/gmail-provider";
import { prisma } from "../prisma";
import { EmailProviderStatus } from "@prisma/client";

/**
 * Supported Email Providers for Production.
 * Based on architectural audit, the active production strategy is Gmail-only.
 */
export const SUPPORTED_PRODUCTION_PROVIDERS: readonly EmailProviderType[] = [
  EmailProviderType.GMAIL,
] as const;

/**
 * Providers currently out of operational scope.
 */
export const UNAVAILABLE_PROVIDERS: readonly EmailProviderType[] = [
  EmailProviderType.SES,
  EmailProviderType.SMTP,
] as const;

export class ProviderUnavailableError extends Error {
  readonly code = "PROVIDER_UNAVAILABLE";
  readonly providerType: EmailProviderType;

  constructor(providerType: EmailProviderType) {
    super(
      `Email provider '${providerType}' is currently unavailable. The near-term production strategy is Gmail-only. Operational adapters for '${providerType}' are not implemented.`
    );
    this.name = "ProviderUnavailableError";
    this.providerType = providerType;
  }
}

export class MockProviderForbiddenError extends Error {
  readonly code = "MOCK_PROVIDER_FORBIDDEN";

  constructor() {
    super(
      "MOCK email provider is strictly restricted to test environments and is forbidden in production (NODE_ENV === 'production')."
    );
    this.name = "MockProviderForbiddenError";
  }
}

export class ProviderAmbiguityError extends Error {
  readonly code = "PROVIDER_AMBIGUOUS";

  constructor(clientId: string, count: number) {
    super(
      `Multiple (${count}) active email providers found for tenant '${clientId}', but none is designated as default (isDefault: true). Silent fallback across providers is prohibited. Please explicitly designate a default provider.`
    );
    this.name = "ProviderAmbiguityError";
  }
}

export class ProviderNotFoundError extends Error {
  readonly code = "PROVIDER_NOT_FOUND";

  constructor(message: string) {
    super(message);
    this.name = "ProviderNotFoundError";
  }
}

/**
 * In-memory test provider for CI and unit test execution.
 * Strictly forbidden in production.
 */
export class MockEmailProvider implements EmailProvider {
  readonly id = "mock";
  readonly name = "Mock Email Provider";
  readonly providerType = EmailProviderType.MOCK;

  async send(_request: EmailSendRequest): Promise<EmailSendResult> {
    void _request;
    return {
      accepted: true,
      success: true,
      providerName: this.name,
      providerType: this.providerType,
      providerMessageId: `mock-msg-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
      providerStatus: "SENT",
      sentAt: new Date(),
    };
  }

  async verifyCredentials(): Promise<{ valid: boolean; error?: string }> {
    return { valid: true };
  }

  async checkHealth(): Promise<EmailProviderHealthResult> {
    return {
      healthy: true,
      latencyMs: 1,
      message: "Mock provider is healthy (test environment only)",
      checkedAt: new Date(),
    };
  }
}

export type ProviderFactory = (config: {
  encryptedCredentials?: string;
  senderEmail?: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}) => EmailProvider;

class EmailProviderRegistry {
  private factories = new Map<EmailProviderType, ProviderFactory>();

  constructor() {
    // 1. Register Gmail provider factory as the primary production provider
    this.register(EmailProviderType.GMAIL, (opts) => new GmailProvider(opts));

    // 2. Register Mock provider factory exclusively in non-production environments
    if (process.env.NODE_ENV !== "production") {
      this.register(EmailProviderType.MOCK, () => new MockEmailProvider());
    }
  }

  /**
   * Registers a provider factory for a given provider type.
   */
  register(type: EmailProviderType, factory: ProviderFactory): void {
    if (type === EmailProviderType.MOCK && process.env.NODE_ENV === "production") {
      throw new MockProviderForbiddenError();
    }
    if (type === EmailProviderType.SES || type === EmailProviderType.SMTP) {
      throw new ProviderUnavailableError(type);
    }
    this.factories.set(type, factory);
  }

  /**
   * Checks if a provider type is registered and available.
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
    if (type === EmailProviderType.SES || type === EmailProviderType.SMTP) {
      throw new ProviderUnavailableError(type);
    }
    if (type === EmailProviderType.MOCK && process.env.NODE_ENV === "production") {
      throw new MockProviderForbiddenError();
    }

    const factory = this.factories.get(type);
    if (!factory) {
      throw new Error(`Email provider '${type}' is not registered in the provider registry`);
    }
    return factory(options);
  }

  /**
   * Resolves the configured, active provider for a tenant.
   * If providerConfigId is specified, loads that exact configuration without falling back.
   * Otherwise, loads the tenant's default active provider configuration.
   * Prohibits silent fallback across providers.
   */
  async resolveForTenant(
    clientId: string,
    providerConfigId?: string,
    overrides?: { fetchFn?: typeof fetch }
  ): Promise<{ provider: EmailProvider; configId: string; senderEmail?: string; providerType: EmailProviderType }> {
    let config;

    if (providerConfigId) {
      // 1. Explicit provider configuration requested - must match exactly
      config = await prisma.emailProviderConfig.findFirst({
        where: { id: providerConfigId, clientId, status: EmailProviderStatus.ACTIVE },
      });

      if (!config) {
        throw new ProviderNotFoundError(
          `Requested email provider configuration '${providerConfigId}' not found or inactive for tenant '${clientId}'. Silent fallback across providers is prohibited.`
        );
      }
    } else {
      // 2. Default provider requested
      config = await prisma.emailProviderConfig.findFirst({
        where: { clientId, status: EmailProviderStatus.ACTIVE, isDefault: true },
      });

      if (!config) {
        // Inspect active providers for this tenant
        const activeConfigs = await prisma.emailProviderConfig.findMany({
          where: { clientId, status: EmailProviderStatus.ACTIVE },
          take: 2,
        });

        if (activeConfigs.length === 0) {
          throw new ProviderNotFoundError(
            `No active email provider configured for tenant '${clientId}'. Please configure Google Workspace / Gmail.`
          );
        }

        if (activeConfigs.length > 1) {
          // Multiple active providers without an explicit default -> fail to prevent silent fallback!
          throw new ProviderAmbiguityError(clientId, activeConfigs.length);
        }

        // Exactly 1 active provider exists for this tenant
        config = activeConfigs[0];
      }
    }

    if (!config) {
      throw new ProviderNotFoundError(`No active email provider configured for tenant '${clientId}'`);
    }

    // Invariant: MOCK provider is strictly forbidden in production
    if (config.providerType === EmailProviderType.MOCK && process.env.NODE_ENV === "production") {
      throw new MockProviderForbiddenError();
    }

    // Invariant: SES and SMTP are not implemented
    if (config.providerType === EmailProviderType.SES || config.providerType === EmailProviderType.SMTP) {
      throw new ProviderUnavailableError(config.providerType);
    }

    if (!config.encryptedCredentials && config.providerType !== EmailProviderType.MOCK) {
      throw new Error(`Configured email provider '${config.id}' is missing credentials`);
    }

    const provider = this.get(config.providerType, {
      encryptedCredentials: config.encryptedCredentials || undefined,
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

/**
 * Checks if a provider type is supported in the current environment.
 */
export function isSupportedProviderType(type: unknown): type is EmailProviderType {
  if (type === EmailProviderType.GMAIL) return true;
  if (type === EmailProviderType.MOCK && process.env.NODE_ENV !== "production") return true;
  return false;
}

/**
 * Checks if a provider type is declared in the schema but currently unavailable.
 */
export function isUnavailableProviderType(type: unknown): type is EmailProviderType {
  return type === EmailProviderType.SES || type === EmailProviderType.SMTP;
}
