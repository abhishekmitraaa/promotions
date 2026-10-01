/**
 * Channel Provider Adapter Service Provider Interface (SPI)
 *
 * Defines the contract that every channel-specific adapter (WhatsApp, Email, SMS, Push)
 * must implement to plug into the Unified Multi-Channel Communication Platform.
 *
 * Principles:
 * 1. Strict Typing: Every adapter consumes `UnifiedMessageRequest` and emits `UnifiedSendResult`.
 * 2. Event Normalization: Each adapter is responsible for parsing its provider's raw webhook
 *    payloads into `UnifiedNormalizedEvent`.
 * 3. Health & Capabilities: Each adapter declares provider health status, latencies, and features.
 */

import {
  ChannelType,
  UnifiedMessageRequest,
  UnifiedNormalizedEvent,
  UnifiedProviderHealthResult,
  UnifiedSendResult,
} from "../types";

export interface ChannelProviderAdapter {
  /**
   * The communication channel this adapter handles.
   */
  readonly channel: ChannelType;

  /**
   * Distinct provider identifier (e.g. 'META_CLOUD_API', 'SMTP', 'RESEND', 'TWILIO', 'FCM').
   */
  readonly providerName: string;

  /**
   * Dispatches a message to the target channel.
   */
  sendMessage(request: UnifiedMessageRequest): Promise<UnifiedSendResult>;

  /**
   * Parses and normalizes incoming provider webhook payloads into standard domain events.
   */
  normalizeEvent(rawPayload: unknown): UnifiedNormalizedEvent | null;

  /**
   * Checks real-time connectivity, latency, and credentials for the provider.
   */
  checkHealth(): Promise<UnifiedProviderHealthResult>;

  /**
   * Optional destination reachability or format validator (e.g., E.164 phone check, RFC 5322 email syntax).
   */
  validateDestination?(destination: string): { valid: boolean; normalized?: string; error?: string };
}
