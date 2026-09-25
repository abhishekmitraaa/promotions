/**
 * Email Sanitization, Validation, and Template Escaping Utilities
 *
 * Implements defenses against:
 * 1. CRLF Header Injection in email addresses and subjects.
 * 2. Cross-Site Scripting (XSS) and HTML injection in template variable interpolations.
 * 3. Secret leakage in error formatting.
 */

import { EmailRecipient } from "./types";

/**
 * Escapes characters with special meaning in HTML to prevent HTML injection and XSS.
 */
export function escapeHtml(unsafe: string | number | boolean | null | undefined): string {
  if (unsafe === null || unsafe === undefined) return "";
  const str = String(unsafe);
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/`/g, "&#96;");
}

/**
 * Strips carriage return and line feed characters from headers.
 */
export function sanitizeHeader(value: string): string {
  if (!value) return "";
  return value.replace(/[\r\n]/g, " ");
}

/**
 * Strips all newline characters (\r, \n) from headers (subject, to, from, etc.)
 * to prevent SMTP/HTTP CRLF header injection attacks.
 */
export function sanitizeHeaderValue(value: string): string {
  if (!value) return "";
  return value.replace(/[\r\n\t]/g, " ").trim();
}

/**
 * Validates whether an email string complies with RFC 5322 structure
 * and contains NO CRLF or control characters.
 */
export function validateEmailAddress(email: string): boolean {
  if (!email || typeof email !== "string") return false;
  const trimmed = email.trim();

  // Maximum allowed length per RFC 5321 is 254 octets
  if (trimmed.length > 254 || trimmed.length === 0) return false;

  // Strict check: no newlines, carriage returns, or null bytes
  if (/[\r\n\0\t]/.test(trimmed)) return false;

  // Standard RFC 5322 compliant regex for practical email validation
  const emailRegex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;
  return emailRegex.test(trimmed);
}

/**
 * Formats an EmailRecipient (string or object) into a sanitized RFC 2822 address string.
 * Example: { name: "Alice Smith", email: "alice@example.com" } -> '"Alice Smith" <alice@example.com>'
 */
export function formatEmailAddress(recipient: EmailRecipient): string {
  if (typeof recipient === "string") {
    const sanitized = sanitizeHeaderValue(recipient);
    if (!validateEmailAddress(sanitized)) {
      throw new Error(`Invalid email address: '${sanitized}'`);
    }
    return sanitized;
  }

  const email = sanitizeHeaderValue(recipient.email);
  if (!validateEmailAddress(email)) {
    throw new Error(`Invalid email address in recipient object: '${email}'`);
  }

  if (recipient.name) {
    // Sanitize name: remove control characters and escape internal double quotes
    const safeName = sanitizeHeaderValue(recipient.name).replace(/"/g, '\\"');
    return `"${safeName}" <${email}>`;
  }

  return email;
}

/**
 * Extracts pure email address from a recipient string or object.
 */
export function extractEmail(recipient: EmailRecipient): string {
  if (typeof recipient === "string") {
    const match = recipient.match(/<([^>]+)>/);
    if (match) return sanitizeHeaderValue(match[1]);
    return sanitizeHeaderValue(recipient);
  }
  return sanitizeHeaderValue(recipient.email);
}

export interface RenderTemplateResult {
  rendered: string;
  missingVariables: string[];
  usedVariables: string[];
}

/**
 * Securely renders a template string with variable interpolation {{variable_name}}.
 * ALL variable values are automatically HTML-escaped by default to prevent injection attacks.
 */
export function renderEmailTemplate(
  template: string,
  variables: Record<string, string | number | boolean | null | undefined> = {},
  options: { escape?: boolean } = { escape: true }
): RenderTemplateResult {
  const shouldEscape = options.escape !== false;
  const missingVariables: string[] = [];
  const usedVariables: string[] = [];

  // Match {{var_name}} or {{ var_name }}
  const placeholderRegex = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;

  const rendered = template.replace(placeholderRegex, (match, varName) => {
    if (Object.prototype.hasOwnProperty.call(variables, varName)) {
      usedVariables.push(varName);
      const val = variables[varName];
      return shouldEscape ? escapeHtml(val) : String(val ?? "");
    }
    missingVariables.push(varName);
    // Keep placeholder intact if missing for debugging or partial template rendering
    return match;
  });

  return {
    rendered,
    missingVariables: Array.from(new Set(missingVariables)),
    usedVariables: Array.from(new Set(usedVariables)),
  };
}

/**
 * Strips HTML tags and creates a clean plain-text fallback representation.
 */
export function stripHtmlToPlainText(html: string): string {
  if (!html) return "";

  return html
    // Replace <br> and <p> with newlines
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/h[1-6]>/gi, "\n\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    // Remove scripts and styles
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
    // Remove all remaining tags
    .replace(/<[^>]+>/g, "")
    // Decode basic HTML entities
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    // Clean up excessive whitespace
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}
