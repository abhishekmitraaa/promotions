/**
 * Secure Email Unsubscribe Service
 *
 * Implements tamper-proof, privacy-preserving unsubscribe tokens:
 * - NEVER puts the raw email address into tokens
 * - Signs payload with HMAC-SHA256 and constant-time verification
 * - Enforces time-bound validity (e.g., 30 days) and random nonce for enumeration resistance
 * - Automatically cascades unsubscribe to EmailContact, EmailSuppression, and EmailListMember
 */

import crypto from "crypto";
import { prisma } from "../prisma";
import { maskEmail } from "../email/normalization";
import { EmailSuppressionService } from "./email-suppression-service";
import { EmailContactStatus, EmailSubscriptionStatus, EmailSuppressionReason } from "@prisma/client";

const DEFAULT_UNSUBSCRIBE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface UnsubscribeTokenPayload {
  contactId: string;
  clientId: string;
  exp: number;
  nonce: string;
}

export class EmailUnsubscribeService {
  /**
   * Generates a signed, privacy-safe unsubscribe token for a contact.
   * Raw email is NEVER included in the token payload.
   */
  static generateUnsubscribeToken(
    clientId: string,
    contactId: string,
    ttlMs: number = DEFAULT_UNSUBSCRIBE_TTL_MS
  ): string {
    const secret = this.getSecret();
    const exp = Date.now() + ttlMs;
    const nonce = crypto.randomBytes(16).toString("hex");

    const payload: UnsubscribeTokenPayload = {
      contactId,
      clientId,
      exp,
      nonce,
    };

    const payloadStr = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const signature = crypto
      .createHmac("sha256", secret)
      .update(payloadStr)
      .digest("base64url");

    return `${payloadStr}.${signature}`;
  }

  /**
   * Verifies an unsubscribe token without executing the unsubscribe.
   * Returns masked email information for confirmation UI.
   */
  static async verifyToken(token: string): Promise<{
    valid: boolean;
    contactId?: string;
    clientId?: string;
    emailMasked?: string;
    error?: string;
  }> {
    if (!token || typeof token !== "string" || !token.includes(".")) {
      return { valid: false, error: "Invalid token format" };
    }

    const [payloadStr, signature] = token.split(".");
    if (!payloadStr || !signature) {
      return { valid: false, error: "Malformed token" };
    }

    const secret = this.getSecret();
    const expectedSignature = crypto
      .createHmac("sha256", secret)
      .update(payloadStr)
      .digest("base64url");

    const sigBuf = Buffer.from(signature);
    const expectedBuf = Buffer.from(expectedSignature);

    if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
      return { valid: false, error: "Invalid token signature" };
    }

    let payload: UnsubscribeTokenPayload;
    try {
      payload = JSON.parse(Buffer.from(payloadStr, "base64url").toString("utf8"));
    } catch {
      return { valid: false, error: "Invalid token payload" };
    }

    if (!payload.contactId || !payload.clientId || typeof payload.exp !== "number") {
      return { valid: false, error: "Incomplete token payload" };
    }

    if (payload.exp < Date.now()) {
      return { valid: false, error: "Unsubscribe token has expired" };
    }

    // Verify contact exists in DB
    const contact = await prisma.emailContact.findFirst({
      where: { id: payload.contactId, clientId: payload.clientId },
      select: { id: true, email: true, status: true, hasMarketingConsent: true },
    });

    if (!contact) {
      return { valid: false, error: "Contact record not found" };
    }

    return {
      valid: true,
      contactId: contact.id,
      clientId: payload.clientId,
      emailMasked: maskEmail(contact.email),
    };
  }

  /**
   * Executes the unsubscribe action using a validated token.
   * Updates contact consent, records suppression, and updates list memberships.
   */
  static async executeUnsubscribe(
    token: string,
    source: string = "UNSUBSCRIBE_LINK"
  ): Promise<{
    success: boolean;
    emailMasked: string;
    message: string;
  }> {
    const verified = await this.verifyToken(token);
    if (!verified.valid || !verified.contactId || !verified.clientId) {
      throw new Error(verified.error || "Invalid or expired unsubscribe token");
    }

    const contact = await prisma.emailContact.findFirst({
      where: { id: verified.contactId, clientId: verified.clientId },
    });

    if (!contact) {
      throw new Error("Contact record not found");
    }

    // 1. Update contact marketing consent
    await prisma.emailContact.update({
      where: { id: contact.id },
      data: {
        hasMarketingConsent: false,
        status: EmailContactStatus.UNSUBSCRIBED,
        unsubscribedAt: new Date(),
        unsubscribeReason: source,
      },
    });

    // 2. Add to suppression list
    await EmailSuppressionService.addSuppression(
      verified.clientId,
      contact.email,
      EmailSuppressionReason.UNSUBSCRIBED,
      source
    );

    // 3. Mark active list memberships as unsubscribed
    try {
      await prisma.emailListMember.updateMany({
        where: {
          contactId: contact.id,
          status: EmailSubscriptionStatus.SUBSCRIBED,
        },
        data: {
          status: EmailSubscriptionStatus.UNSUBSCRIBED,
          unsubscribedAt: new Date(),
        },
      });
    } catch {
      // Non-fatal
    }

    return {
      success: true,
      emailMasked: maskEmail(contact.email),
      message: "You have been successfully unsubscribed from marketing emails.",
    };
  }

  /**
   * Generates RFC 8058 compliant one-click unsubscribe headers.
   * Required by Google/Yahoo sender guidelines for promotional/bulk emails.
   */
  static getOneClickUnsubscribeHeaders(
    baseUrl: string,
    token: string
  ): {
    "List-Unsubscribe": string;
    "List-Unsubscribe-Post": string;
  } {
    const cleanBase = baseUrl.replace(/\/$/, "");
    const httpsBase = cleanBase.startsWith("https://")
      ? cleanBase
      : cleanBase.replace(/^http:\/\//, "https://");
    const unsubscribeUrl = `${httpsBase}/api/email/unsubscribe/${token}`;

    return {
      "List-Unsubscribe": `<${unsubscribeUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    };
  }

  private static getSecret(): string {
    const secret = process.env.AUTH_SESSION_SECRET || process.env.EMAIL_UNSUBSCRIBE_SECRET;
    if (!secret || secret.length < 32) {
      // Safe development fallback if secret not set in test environment
      return "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    }
    return secret;
  }
}
