/**
 * Unified Channel Adapter Registry
 *
 * Central registry managing channel-specific provider adapters.
 * Enables dynamic resolution, custom adapter injection, and system-wide health checks.
 */

import { ChannelType, UnifiedProviderHealthResult } from "./types";
import { ChannelProviderAdapter } from "./adapters/channel-adapter";
import { WhatsAppAdapter } from "./adapters/whatsapp-adapter";
import { EmailAdapter } from "./adapters/email-adapter";
import { SmsAdapter } from "./adapters/sms-adapter";
import { PushAdapter } from "./adapters/push-adapter";

// Re-export adapters for convenience
export { WhatsAppAdapter, EmailAdapter, SmsAdapter, PushAdapter };
export { WhatsAppAdapter as WhatsAppChannelAdapter, EmailAdapter as EmailChannelAdapter, SmsAdapter as SmsChannelAdapter, PushAdapter as PushChannelAdapter };

export class CommunicationRegistry {
  private adapters: Map<ChannelType, ChannelProviderAdapter> = new Map();

  constructor() {
    this.registerDefaults();
  }

  /**
   * Registers default adapters for WhatsApp, Email, SMS, and Push.
   */
  private registerDefaults(): void {
    this.adapters.set("WHATSAPP", new WhatsAppAdapter());
    this.adapters.set("EMAIL", new EmailAdapter());
    this.adapters.set("SMS", new SmsAdapter());
    this.adapters.set("PUSH", new PushAdapter());
  }

  /**
   * Register or override an adapter for a channel.
   */
  register(adapter: ChannelProviderAdapter): void {
    this.adapters.set(adapter.channel, adapter);
  }

  /**
   * Resolves the adapter for a specific channel.
   */
  getAdapter(channel: ChannelType): ChannelProviderAdapter {
    const adapter = this.adapters.get(channel);
    if (!adapter) {
      throw new Error(`[CommunicationRegistry] No adapter registered for channel: '${channel}'`);
    }
    return adapter;
  }

  /**
   * Returns list of currently registered channels.
   */
  getSupportedChannels(): ChannelType[] {
    return Array.from(this.adapters.keys());
  }

  /**
   * Runs diagnostic health checks across all registered channel adapters for a client.
   */
  async checkAllHealth(clientId: string = "default"): Promise<Record<ChannelType, UnifiedProviderHealthResult>> {
    const results = {} as Record<ChannelType, UnifiedProviderHealthResult>;
    for (const [channel, adapter] of this.adapters.entries()) {
      try {
        results[channel] = await adapter.checkHealth(clientId);
      } catch (err: unknown) {
        const error = err as Error;
        results[channel] = {
          providerType: channel,
          channel,
          status: "UNHEALTHY",
          latencyMs: -1,
          checkedAt: new Date(),
          message: error.message || "Failed health check",
          capabilities: {
            supportsTemplates: false,
            supportsMedia: false,
            supportsTwoWay: false,
            supportsDeliveryReceipts: false,
            supportsReadReceipts: false,
          },
        };
      }
    }
    return results;
  }
}

// Global singleton instance
export const communicationRegistry = new CommunicationRegistry();
