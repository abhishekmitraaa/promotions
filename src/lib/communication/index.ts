/**
 * Unified Communication Layer
 *
 * Entry point exposing the shared omnichannel abstractions:
 * - Domain contracts (10 shared concepts: Contact, Message, Campaign, Template, Delivery, Event, Suppression, Consent, Provider, Analytics)
 * - Monotonic delivery & campaign lifecycle state machines
 * - Multi-tenant context and isolation validation
 * - Cross-channel analytics aggregation contracts
 * - Channel provider adapter SPI & concrete adapters (WhatsApp, Email, SMS, Push)
 * - Channel adapter registry
 * - Unified message router facade
 */

export * from "./types";
export * from "./lifecycle";
export * from "./tenant";
export * from "./analytics";
export * from "./adapters/channel-adapter";
export * from "./adapters/whatsapp-adapter";
export * from "./adapters/email-adapter";
export * from "./adapters/sms-adapter";
export * from "./adapters/push-adapter";
export * from "./registry";
export * from "./router";
