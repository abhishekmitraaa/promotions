/**
 * Unified Channel Adapter Registry
 *
 * Central registry managing channel-specific provider adapters.
 * Enables dynamic resolution, custom adapter injection, and system-wide health checks.
 */

import { ChannelType } from "./types";
import { ChannelProviderAdapter } from "./adapters/channel-adapter";
import { WhatsAppChannelAdapter } from "./adapters/whatsapp-adapter";
import { EmailChannelAdapter } from "./adapters/email-adapter";
import { SmsChannelAdapter } from "./adapters/sms-adapter";
import { PushChannelAdapter } from "./adapters/push-adapter";

export class CommunicationRegistry {
  private adapters: Map<ChannelType, ChannelProviderAdapter> = new Map();

  constructor() {
    this.registerDefaults();
  }

  /**
   * Registers default adapters for WhatsApp, Email, SMS, and Push.
   */
  private registerDefaults(): void {
    this.adapters.set("WHATSAPP", new WhatsAppChannelAdapter());
    this.adapters.set("EMAIL", new EmailChannelAdapter());
    this.adapters.set("SMS", new SmsChannelAdapter());
    this.adapters.set("PUSH", new PushChannelAdapter());
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
   * Runs diagnostic health checks across all registered channel adapters.
   */
  async checkAllHealth() {
    const results: Record<string, any> = {};
    for (const [channel, adapter] of this.adapters.entries()) {
      try {
        results[channel] = await adapter.checkHealth();
      } catch (err: any) {
        results[channel] = {
          providerType: adapter.providerName,
          channel,
          status: "UNHEALTHY",
          latencyMs: -1,
          checkedAt: new Date(),
          message: err.message || "Failed health check",
          capabilities: {},
        };
      }
    }
    return results;
  }
}

// Global singleton instance
export const communicationRegistry = new CommunicationRegistry();
