/**
 * Google Workspace / Gmail API Provider Implementation
 *
 * Implements EmailProvider interface using server-side Google OAuth 2.0
 * and the Gmail REST API (users.messages.send).
 *
 * Key Constraints:
 * - Uses narrowest sending permission: https://www.googleapis.com/auth/gmail.send
 * - Never logs credentials or secrets.
 * - Categorizes errors into retryable vs non-retryable.
 * - Returns normalized EmailSendResult, hiding provider-specific payload schemas.
 */

import {
  EmailProvider,
  EmailProviderType,
  EmailSendRequest,
  EmailSendResult,
  EmailSendError,
} from "../../types";
import { buildGmailMime, base64UrlEncode } from "./mime";
import { decryptProviderCredential } from "../../../crypto";

export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const GMAIL_SEND_ENDPOINT = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

export interface GmailProviderCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  senderEmail?: string;
}

export interface GmailProviderOptions {
  credentials?: GmailProviderCredentials;
  encryptedCredentials?: string;
  senderEmail?: string;
  timeoutMs?: number;
  /** Optional custom fetch implementation for unit testing / mocking */
  fetchFn?: typeof fetch;
}

export class GmailProvider implements EmailProvider {
  readonly id = "gmail";
  readonly name = "Google Workspace / Gmail";
  readonly providerType = EmailProviderType.GMAIL;

  private credentials?: GmailProviderCredentials;
  private cachedAccessToken: string | null = null;
  private tokenExpiresAt: number = 0;
  private timeoutMs: number;
  private fetchFn: typeof fetch;

  constructor(options?: GmailProviderOptions) {
    this.timeoutMs = options?.timeoutMs || 10000;
    this.fetchFn = options?.fetchFn || fetch;

    if (options?.credentials) {
      this.credentials = { ...options.credentials };
    } else if (options?.encryptedCredentials) {
      try {
        const decryptedJson = decryptProviderCredential(options.encryptedCredentials);
        this.credentials = JSON.parse(decryptedJson);
      } catch (err) {
        throw new Error(
          `Failed to decrypt Gmail provider credentials: ${err instanceof Error ? err.message : "unknown error"}`
        );
      }
    }

    if (options?.senderEmail && this.credentials) {
      this.credentials.senderEmail = options.senderEmail;
    }
  }

  /**
   * Dispatches an email request using Gmail messages.send.
   */
  async send(request: EmailSendRequest): Promise<EmailSendResult> {
    if (!this.credentials || !this.credentials.refreshToken) {
      return {
        accepted: false,
        success: false,
        providerName: this.name,
        providerType: this.providerType,
        providerStatus: "REJECTED",
        error: {
          code: "MISSING_CREDENTIALS",
          message: "Gmail credentials or refresh token missing from provider configuration",
          retryable: false,
          statusCode: 400,
        },
      };
    }

    const resolvedFrom =
      (typeof request.from === "string" ? request.from : request.from?.email) ||
      this.credentials.senderEmail;

    if (!resolvedFrom) {
      return {
        accepted: false,
        success: false,
        providerName: this.name,
        providerType: this.providerType,
        providerStatus: "REJECTED",
        error: {
          code: "MISSING_SENDER",
          message: "No verified sender identity specified or configured for Gmail provider",
          retryable: false,
          statusCode: 400,
        },
      };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      // 1. Obtain fresh or cached access token
      const accessToken = await this.getAccessToken();

      // 2. Build standards-compliant RFC 2822 MIME message & Base64url encode
      const mime = buildGmailMime(request, resolvedFrom);
      const rawBase64Url = base64UrlEncode(mime);

      // 3. Post to Gmail API
      const response = await this.fetchFn(GMAIL_SEND_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ raw: rawBase64Url }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        const classified = this.classifyHttpError(response.status, errorText);
        return {
          accepted: false,
          success: false,
          providerName: this.name,
          providerType: this.providerType,
          providerStatus: "REJECTED",
          error: classified,
        };
      }

      const data = (await response.json()) as { id: string; threadId?: string };

      return {
        accepted: true,
        success: true,
        providerName: this.name,
        providerType: this.providerType,
        providerMessageId: data.id,
        providerStatus: "SENT",
        sentAt: new Date(),
      };
    } catch (err: unknown) {
      clearTimeout(timeout);

      if (err instanceof Error && err.name === "AbortError") {
        return {
          accepted: false,
          success: false,
          providerName: this.name,
          providerType: this.providerType,
          providerStatus: "FAILED",
          error: {
            code: "NETWORK_TIMEOUT",
            message: `Gmail API send timed out after ${this.timeoutMs}ms`,
            retryable: true,
            statusCode: 408,
          },
        };
      }

      const rawMsg = err instanceof Error ? err.message : "Unknown error while sending through Gmail";
      const safeMsg = this.redactSecrets(rawMsg);

      return {
        accepted: false,
        success: false,
        providerName: this.name,
        providerType: this.providerType,
        providerStatus: "FAILED",
        error: {
          code: "PROVIDER_ERROR",
          message: safeMsg,
          retryable: true,
        },
      };
    }
  }

  /**
   * Verifies that credentials are functional by acquiring an access token.
   */
  async verifyCredentials(): Promise<{ valid: boolean; error?: string }> {
    if (!this.credentials || !this.credentials.clientId || !this.credentials.refreshToken) {
      return { valid: false, error: "Missing required Gmail credentials (clientId or refreshToken)" };
    }
    try {
      await this.getAccessToken(true);
      return { valid: true };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Credential verification failed";
      return { valid: false, error: this.redactSecrets(msg) };
    }
  }

  /**
   * Exchanges refresh token for an access token via Google OAuth 2.0 token endpoint.
   */
  async getAccessToken(forceRefresh = false): Promise<string> {
    const now = Date.now();
    // Cache valid for at least 60 seconds
    if (!forceRefresh && this.cachedAccessToken && this.tokenExpiresAt > now + 60000) {
      return this.cachedAccessToken;
    }

    if (!this.credentials?.clientId || !this.credentials?.clientSecret || !this.credentials?.refreshToken) {
      throw new Error("Missing OAuth credentials: clientId, clientSecret, or refreshToken is not defined");
    }

    const params = new URLSearchParams({
      client_id: this.credentials.clientId,
      client_secret: this.credentials.clientSecret,
      refresh_token: this.credentials.refreshToken,
      grant_type: "refresh_token",
    });

    const response = await this.fetchFn(GOOGLE_TOKEN_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(
        `Failed to refresh Google OAuth token (${response.status}): ${this.redactSecrets(errText)}`
      );
    }

    const data = (await response.json()) as { access_token: string; expires_in: number };
    if (!data.access_token) {
      throw new Error("Google OAuth token response missing access_token");
    }

    this.cachedAccessToken = data.access_token;
    this.tokenExpiresAt = now + (data.expires_in || 3600) * 1000;

    return this.cachedAccessToken;
  }

  /**
   * Classifies Gmail HTTP responses into structured retryable/permanent errors.
   */
  classifyHttpError(status: number, rawBody: string): EmailSendError {
    const safeBody = this.redactSecrets(rawBody);

    if (status === 429) {
      return {
        code: "RATE_LIMIT_EXCEEDED",
        message: "Gmail rate limit exceeded",
        retryable: true,
        statusCode: 429,
      };
    }

    if (status >= 500 && status < 600) {
      return {
        code: "SERVICE_UNAVAILABLE",
        message: `Gmail service error (${status})`,
        retryable: true,
        statusCode: status,
      };
    }

    if (status === 401) {
      return {
        code: "AUTHENTICATION_FAILED",
        message: "Gmail OAuth token rejected or revoked",
        retryable: false,
        statusCode: 401,
      };
    }

    if (status === 403) {
      const isQuota = safeBody.toLowerCase().includes("quota");
      return {
        code: isQuota ? "QUOTA_EXCEEDED" : "PERMISSION_DENIED",
        message: isQuota
          ? "Gmail sending quota exceeded for account"
          : "Gmail API permission denied (check scopes and API enablement)",
        retryable: false,
        statusCode: 403,
      };
    }

    if (status === 400) {
      return {
        code: "INVALID_REQUEST",
        message: `Gmail rejected payload format: ${safeBody.substring(0, 200)}`,
        retryable: false,
        statusCode: 400,
      };
    }

    return {
      code: `HTTP_ERROR_${status}`,
      message: `Gmail API request failed with status ${status}`,
      retryable: false,
      statusCode: status,
    };
  }

  /**
   * Redacts sensitive tokens and secrets before error logs or strings are created.
   */
  redactSecrets(text: string): string {
    if (!text) return "";
    let clean = text;
    if (this.credentials?.clientSecret) {
      clean = clean.split(this.credentials.clientSecret).join("[REDACTED_CLIENT_SECRET]");
    }
    if (this.credentials?.refreshToken) {
      clean = clean.split(this.credentials.refreshToken).join("[REDACTED_REFRESH_TOKEN]");
    }
    if (this.cachedAccessToken) {
      clean = clean.split(this.cachedAccessToken).join("[REDACTED_ACCESS_TOKEN]");
    }
    return clean;
  }
}
