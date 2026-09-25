/**
 * Email Subsystem Layer
 *
 * Exposes core domain models, enums, normalization, sanitization,
 * provider abstraction, Gmail provider implementation, and registry.
 */

export * from "./types";
export * from "./normalization";
export * from "./sanitization";
export * from "./registry";
export * from "./providers/gmail/gmail-provider";
export * from "./providers/gmail/mime";
export * from "./providers/gmail/oauth";
export * from "./templates";
export * from "./queue";
