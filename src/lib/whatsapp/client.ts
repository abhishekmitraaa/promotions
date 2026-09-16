import { env, isMetaConfigured } from "../env";
import { logger } from "../logger";
import { WhatsAppApiError } from "./errors";
import {
  MetaOutboundPayload,
  MetaSuccessResponse,
  MetaErrorResponse,
} from "./types";

export interface SendMessageOptions {
  timeoutMs?: number;
}

/**
 * Server-only client to dispatch messages directly to Meta's WhatsApp Cloud API endpoint.
 * URL: https://graph.facebook.com/{GRAPH_API_VERSION}/{PHONE_NUMBER_ID}/messages
 */
export async function sendWhatsAppMessage(
  payload: MetaOutboundPayload,
  options?: SendMessageOptions
): Promise<MetaSuccessResponse> {
  const timeoutMs = options?.timeoutMs ?? 10000;

  // Local development check
  if (!isMetaConfigured()) {
    if (env.DEV_ALLOW_UNCONFIGURED_META && process.env.NODE_ENV !== "production") {
      logger.warn(
        `[Dev Mode] META credentials missing. Simulating send for recipient ${payload.to}`
      );
      const mockProviderId = `wamid.dev_mock_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
      return {
        messaging_product: "whatsapp",
        contacts: [{ input: payload.to, wa_id: payload.to }],
        messages: [{ id: mockProviderId }],
      };
    }

    throw new WhatsAppApiError(
      process.env.NODE_ENV === "production"
        ? "Meta WhatsApp Cloud API credentials are not configured on this server."
        : "Meta WhatsApp Cloud API credentials (META_ACCESS_TOKEN and META_PHONE_NUMBER_ID) are missing or invalid in environment configuration.",
      400
    );
  }

  const endpointUrl = `https://graph.facebook.com/${env.META_GRAPH_API_VERSION}/${env.META_PHONE_NUMBER_ID}/messages`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    logger.info(`Sending WhatsApp message of type '${payload.type}' to recipient '${payload.to}'`);

    const response = await fetch(endpointUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.META_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timer);

    let rawText = "";
    try {
      rawText = await response.text();
    } catch {
      throw new WhatsAppApiError(
        "Failed to read response body from Meta WhatsApp API",
        response.status,
        undefined,
        undefined,
        undefined,
        undefined,
        true
      );
    }

    let json: unknown;
    try {
      json = JSON.parse(rawText);
    } catch {
      const sanitizedText = rawText.substring(0, 250);
      throw new WhatsAppApiError(
        `Meta API returned non-JSON response (HTTP ${response.status}): ${sanitizedText}`,
        response.status,
        undefined,
        undefined,
        undefined,
        undefined,
        response.status >= 500
      );
    }

    if (!response.ok) {
      const errResponse = json as MetaErrorResponse;
      const metaErr = errResponse.error || {};
      logger.error(`Meta API returned HTTP ${response.status} (code ${metaErr.code || "unknown"}):`, metaErr.message);

      throw new WhatsAppApiError(
        metaErr.message || `Meta Graph API request failed with status ${response.status}`,
        response.status,
        metaErr.code,
        metaErr.error_subcode,
        metaErr.fbtrace_id,
        metaErr.error_data,
        response.status >= 500 || response.status === 408
      );
    }

    return json as MetaSuccessResponse;
  } catch (error) {
    clearTimeout(timer);

    if (error instanceof WhatsAppApiError) {
      throw error;
    }

    if ((error as { name?: string }).name === "AbortError") {
      throw new WhatsAppApiError(
        `Meta WhatsApp Cloud API request timed out after ${timeoutMs}ms`,
        504,
        undefined,
        undefined,
        undefined,
        undefined,
        true
      );
    }

    const message = error instanceof Error ? error.message : "Unknown Meta API client error";
    logger.error("Meta API Client network/runtime error:", message);
    throw new WhatsAppApiError(message, 500, undefined, undefined, undefined, undefined, true);
  }
}
