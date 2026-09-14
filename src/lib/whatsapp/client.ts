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
    if (env.DEV_ALLOW_UNCONFIGURED_META) {
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
      "Meta WhatsApp Cloud API credentials (META_ACCESS_TOKEN and META_PHONE_NUMBER_ID) are missing or invalid in environment configuration.",
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

    const json = await response.json();

    if (!response.ok) {
      const errResponse = json as MetaErrorResponse;
      const metaErr = errResponse.error || {};
      logger.error(`Meta API returned HTTP ${response.status}:`, metaErr);

      throw new WhatsAppApiError(
        metaErr.message || `Meta Graph API request failed with status ${response.status}`,
        response.status,
        metaErr.code,
        metaErr.error_subcode,
        metaErr.fbtrace_id,
        metaErr.error_data
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
        504
      );
    }

    const message = error instanceof Error ? error.message : "Unknown Meta API client error";
    logger.error("Meta API Client error:", message);
    throw new WhatsAppApiError(message, 500);
  }
}
