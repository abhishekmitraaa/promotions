/**
 * Gmail MIME Message Builder & Base64URL Encoder
 *
 * Implements RFC 2822 / MIME message construction specifically for the Gmail API.
 * Encapsulated within the Gmail provider implementation.
 */

import crypto from "crypto";
import { EmailSendRequest, EmailRecipientInput } from "../../types";
import { sanitizeHeader } from "../../normalization";

/**
 * Encodes a buffer or string into RFC 4648 URL-safe base64 without padding.
 * Required for the Gmail API `raw` field.
 */
export function base64UrlEncode(input: Buffer | string): string {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input, "utf8");
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Decodes a base64url encoded string into a Buffer.
 */
export function base64UrlDecode(input: string): Buffer {
  let base64 = input.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4 !== 0) {
    base64 += "=";
  }
  return Buffer.from(base64, "base64");
}

/**
 * Encodes non-ASCII header text using RFC 2047 encoded-word syntax (=?UTF-8?B?...?=).
 */
export function encodeMimeHeader(text: string): string {
  const clean = sanitizeHeader(text);
  if (/^[\x20-\x7E]*$/.test(clean)) {
    return clean;
  }
  const base64 = Buffer.from(clean, "utf8").toString("base64");
  return `=?UTF-8?B?${base64}?=`;
}

/**
 * Formats a recipient into a sanitized address string.
 */
export function formatRecipient(recipient: EmailRecipientInput): string {
  if (typeof recipient === "string") {
    return sanitizeHeader(recipient);
  }
  const email = sanitizeHeader(recipient.email);
  if (recipient.name) {
    const safeName = sanitizeHeader(recipient.name).replace(/"/g, '\\"');
    return `"${safeName}" <${email}>`;
  }
  return email;
}

/**
 * Generates an RFC 2822 Message-ID header value.
 */
export function generateMessageId(domain: string = "hub.local"): string {
  const random = crypto.randomBytes(16).toString("hex");
  const timestamp = Date.now();
  return `<${timestamp}.${random}@${domain}>`;
}

/**
 * Splits base64 string into 76-character chunks per RFC 2045.
 */
function chunkBase64(data: string, chunkSize: number = 76): string {
  const chunks: string[] = [];
  for (let i = 0; i < data.length; i += chunkSize) {
    chunks.push(data.slice(i, i + chunkSize));
  }
  return chunks.join("\r\n");
}

/**
 * Builds an RFC 2822 MIME message string from EmailSendRequest.
 */
export function buildGmailMime(request: EmailSendRequest, resolvedFrom: string): string {
  const lines: string[] = [];

  // 1. Mandatory Headers
  lines.push(`From: ${formatRecipient(request.from || resolvedFrom)}`);

  const toList = Array.isArray(request.to) ? request.to : [request.to];
  if (toList.length === 0) {
    throw new Error("Missing recipient 'to' address");
  }
  lines.push(`To: ${toList.map(formatRecipient).join(", ")}`);

  if (request.cc) {
    const ccList = Array.isArray(request.cc) ? request.cc : [request.cc];
    if (ccList.length > 0) {
      lines.push(`Cc: ${ccList.map(formatRecipient).join(", ")}`);
    }
  }

  if (request.replyTo) {
    lines.push(`Reply-To: ${formatRecipient(request.replyTo)}`);
  }

  lines.push(`Subject: ${encodeMimeHeader(request.subject)}`);
  lines.push(`Date: ${new Date().toUTCString()}`);
  lines.push(`Message-ID: ${generateMessageId()}`);
  lines.push("MIME-Version: 1.0");

  // 2. Category-Specific Headers
  if (request.type === "PROMOTIONAL") {
    lines.push("Precedence: bulk");
    if (request.headers?.["List-Unsubscribe"]) {
      lines.push(`List-Unsubscribe: ${sanitizeHeader(request.headers["List-Unsubscribe"])}`);
    }
    if (request.headers?.["List-Unsubscribe-Post"]) {
      lines.push(`List-Unsubscribe-Post: ${sanitizeHeader(request.headers["List-Unsubscribe-Post"])}`);
    }
  } else {
    lines.push("Auto-Submitted: auto-generated");
    lines.push("X-Auto-Response-Suppress: All");
  }

  // 3. Custom Headers (filtering reserved header names)
  if (request.headers) {
    const reserved = new Set([
      "from", "to", "cc", "bcc", "subject", "date",
      "message-id", "mime-version", "content-type",
      "list-unsubscribe", "list-unsubscribe-post"
    ]);
    for (const [key, val] of Object.entries(request.headers)) {
      if (!reserved.has(key.toLowerCase())) {
        lines.push(`${sanitizeHeader(key)}: ${sanitizeHeader(val)}`);
      }
    }
  }

  const hasAttachments = request.attachments && request.attachments.length > 0;
  const textBody = request.text || "";
  const htmlBody = request.html || "";
  const hasText = textBody.trim().length > 0;
  const hasHtml = htmlBody.trim().length > 0;

  // 4. MIME Body Construction
  if (!hasAttachments) {
    if (hasHtml && hasText) {
      const altBoundary = `----=_Part_Alt_${crypto.randomBytes(12).toString("hex")}`;
      lines.push(`Content-Type: multipart/alternative; boundary="${altBoundary}"`);
      lines.push("");

      lines.push(`--${altBoundary}`);
      lines.push("Content-Type: text/plain; charset=UTF-8");
      lines.push("Content-Transfer-Encoding: base64");
      lines.push("");
      lines.push(chunkBase64(Buffer.from(textBody, "utf8").toString("base64")));

      lines.push(`--${altBoundary}`);
      lines.push("Content-Type: text/html; charset=UTF-8");
      lines.push("Content-Transfer-Encoding: base64");
      lines.push("");
      lines.push(chunkBase64(Buffer.from(htmlBody, "utf8").toString("base64")));

      lines.push(`--${altBoundary}--`);
    } else if (hasHtml) {
      lines.push("Content-Type: text/html; charset=UTF-8");
      lines.push("Content-Transfer-Encoding: base64");
      lines.push("");
      lines.push(chunkBase64(Buffer.from(htmlBody, "utf8").toString("base64")));
    } else {
      lines.push("Content-Type: text/plain; charset=UTF-8");
      lines.push("Content-Transfer-Encoding: base64");
      lines.push("");
      lines.push(chunkBase64(Buffer.from(textBody, "utf8").toString("base64")));
    }
  } else {
    const mixedBoundary = `----=_Part_Mixed_${crypto.randomBytes(12).toString("hex")}`;
    lines.push(`Content-Type: multipart/mixed; boundary="${mixedBoundary}"`);
    lines.push("");

    if (hasHtml && hasText) {
      const altBoundary = `----=_Part_Alt_${crypto.randomBytes(12).toString("hex")}`;
      lines.push(`--${mixedBoundary}`);
      lines.push(`Content-Type: multipart/alternative; boundary="${altBoundary}"`);
      lines.push("");

      lines.push(`--${altBoundary}`);
      lines.push("Content-Type: text/plain; charset=UTF-8");
      lines.push("Content-Transfer-Encoding: base64");
      lines.push("");
      lines.push(chunkBase64(Buffer.from(textBody, "utf8").toString("base64")));

      lines.push(`--${altBoundary}`);
      lines.push("Content-Type: text/html; charset=UTF-8");
      lines.push("Content-Transfer-Encoding: base64");
      lines.push("");
      lines.push(chunkBase64(Buffer.from(htmlBody, "utf8").toString("base64")));

      lines.push(`--${altBoundary}--`);
    } else {
      const contentType = hasHtml ? "text/html" : "text/plain";
      const bodyContent = hasHtml ? htmlBody : textBody;
      lines.push(`--${mixedBoundary}`);
      lines.push(`Content-Type: ${contentType}; charset=UTF-8`);
      lines.push("Content-Transfer-Encoding: base64");
      lines.push("");
      lines.push(chunkBase64(Buffer.from(bodyContent, "utf8").toString("base64")));
    }

    for (const attachment of request.attachments!) {
      lines.push(`--${mixedBoundary}`);
      const filename = sanitizeHeader(attachment.filename);
      const disposition = attachment.disposition || "attachment";
      const contentType = attachment.contentType || "application/octet-stream";

      lines.push(`Content-Type: ${contentType}; name="${filename}"`);
      if (disposition === "inline" && attachment.contentId) {
        lines.push(`Content-Disposition: inline; filename="${filename}"`);
        lines.push(`Content-ID: <${sanitizeHeader(attachment.contentId)}>`);
      } else {
        lines.push(`Content-Disposition: attachment; filename="${filename}"`);
      }
      lines.push("Content-Transfer-Encoding: base64");
      lines.push("");

      const contentBuf = Buffer.isBuffer(attachment.content)
        ? attachment.content
        : Buffer.from(attachment.content, typeof attachment.content === "string" ? "utf8" : undefined);
      lines.push(chunkBase64(contentBuf.toString("base64")));
    }

    lines.push(`--${mixedBoundary}--`);
  }

  return lines.join("\r\n");
}
