/**
 * Channel Provider Adapter Service Provider Interface (SPI)
 *
 * Defines the contract that every channel-specific implementation must fulfill.
 * Enables the unified platform to route messages, check provider health,
 * normalize inbound webhooks, and validate destination reachability uniformly.
 */

import {
  ChannelType,
  UnifiedMessageRequest,
  UnifiedSendResult,
  UnifiedProviderHealthResult,
  UnifiedNormalizedEvent,
} from "../types";

export interface ChannelReachabilityCheck {
  valid: boolean;
  normalizedDestination?: string;
  reason?: string;
}

export interface ChannelProviderAdapter {
  /**
   * The channel supported by this adapter.
   */
  readonly channel: ChannelType;

  /**
   * Dispatches a message request through the channel-specific delivery pipeline.
   */
  send(request: UnifiedMessageRequest): Promise<UnifiedSendResult>;

  /**
   * Alias for send() for backward/forward compatibility.
   */
  sendMessage(request: UnifiedMessageRequest): Promise<UnifiedSendResult>;

  /**
   * Performs an active health check on the underlying provider configuration for a tenant.
   */
  checkHealth(clientId: string): Promise<UnifiedProviderHealthResult>;

  /**
   * Normalizes incoming raw webhook payloads from the provider into the unified event structure.
   */
  normalizeWebhookEvent(rawPayload: Record<string, unknown>): UnifiedNormalizedEvent[];

  /**
   * Validates whether a destination (e.g. phone number, email address, push token) is syntactically
   * valid and reachable according to channel rules.
   */
  checkReachability(destination: string): Promise<ChannelReachabilityCheck>;

  /**
   * Synchronous destination syntax validation.
   */
  validateDestination(destination: string): ChannelReachabilityCheck;
}
