import { prisma } from "../prisma";
import { signWebhookPayload } from "./signature";
import { logger } from "../logger";
import { env } from "../env";
import { DeliveryStatus } from "@prisma/client";

export interface WebhookEventPayload {
  eventId: string;
  eventType: string;
  timestamp: string;
  data: Record<string, unknown>;
}

/**
 * Validate outgoing webhook URL to mitigate basic SSRF risks.
 */
function isValidWebhookUrl(urlString: string): boolean {
  try {
    const parsed = new URL(urlString);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return false;
    }
    // In production mode, block local IP addresses
    if (env.NODE_ENV === "production") {
      const hostname = parsed.hostname.toLowerCase();
      if (
        hostname === "localhost" ||
        hostname === "127.0.0.1" ||
        hostname === "::1" ||
        hostname.startsWith("192.168.") ||
        hostname.startsWith("10.") ||
        hostname.startsWith("172.16.")
      ) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Dispatch an event to all active WebhookEndpoints registered for that event type.
 */
export async function dispatchOutgoingWebhooks(
  eventType: string,
  data: Record<string, unknown>
): Promise<void> {
  try {
    const endpoints = await prisma.webhookEndpoint.findMany({
      where: { active: true },
    });

    if (endpoints.length === 0) return;

    const eventId = `evt_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const eventPayload: WebhookEventPayload = {
      eventId,
      eventType,
      timestamp: new Date().toISOString(),
      data,
    };

    const rawPayload = JSON.stringify(eventPayload);

    for (const endpoint of endpoints) {
      let subscribedList: string[] = [];
      try {
        subscribedList = JSON.parse(endpoint.subscribedEvents);
      } catch {
        subscribedList = [];
      }

      // Check if endpoint is subscribed to this event or wildcard "*"
      if (!subscribedList.includes("*") && !subscribedList.includes(eventType)) {
        continue;
      }

      if (!isValidWebhookUrl(endpoint.url)) {
        logger.warn(`Skipping invalid or unsafe webhook URL: ${endpoint.url}`);
        continue;
      }

      // Create PENDING delivery record
      const delivery = await prisma.webhookDelivery.create({
        data: {
          endpointId: endpoint.id,
          eventId,
          eventType,
          payload: rawPayload,
          status: DeliveryStatus.PENDING,
          attemptCount: 0,
        },
      });

      // Deliver asynchronously
      deliverWebhookPayload(delivery.id, endpoint.url, endpoint.secretHash, rawPayload, eventType).catch((err) => {
        logger.error(`Webhook delivery execution error for delivery ${delivery.id}:`, err);
      });
    }
  } catch (error) {
    logger.error("Failed to query webhook endpoints for dispatch:", error);
  }
}

/**
 * Deliver payload over HTTP POST with retries.
 */
export async function deliverWebhookPayload(
  deliveryId: string,
  url: string,
  secretHash: string,
  rawPayload: string,
  eventType: string
): Promise<boolean> {
  const timeoutMs = env.OUTBOUND_WEBHOOK_TIMEOUT_MS;
  const maxRetries = env.OUTBOUND_WEBHOOK_MAX_RETRIES;
  const signature = signWebhookPayload(rawPayload, secretHash);

  let attempt = 0;
  let success = false;
  let lastResponseStatus: number | null = null;
  let lastResponseBody: string | null = null;
  let lastErrorMessage: string | null = null;

  while (attempt <= maxRetries && !success) {
    attempt += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      logger.info(`Webhook delivery attempt ${attempt}/${maxRetries + 1} to ${url}`);

      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Webhook-Signature": signature,
          "X-Webhook-Event": eventType,
          "User-Agent": "WhatsApp-Messaging-Service/1.0",
        },
        body: rawPayload,
        signal: controller.signal,
      });

      clearTimeout(timer);

      lastResponseStatus = res.status;
      const text = await res.text();
      lastResponseBody = text.substring(0, 1000); // cap body size

      if (res.ok) {
        success = true;
      } else {
        lastErrorMessage = `HTTP ${res.status}: ${res.statusText}`;
        // Do not retry 4xx errors (client errors)
        if (res.status >= 400 && res.status < 500) {
          break;
        }
      }
    } catch (err) {
      clearTimeout(timer);
      lastErrorMessage = err instanceof Error ? err.message : "Network error";
    }

    if (!success && attempt <= maxRetries) {
      // Exponential backoff wait: 1s, 2s, 4s, 8s...
      const backoffMs = Math.pow(2, attempt - 1) * 1000;
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }

  // Update WebhookDelivery audit record
  await prisma.webhookDelivery
    .update({
      where: { id: deliveryId },
      data: {
        status: success ? DeliveryStatus.SUCCESS : DeliveryStatus.FAILED,
        attemptCount: attempt,
        lastAttemptAt: new Date(),
        responseStatus: lastResponseStatus,
        responseBody: lastResponseBody,
        errorMessage: lastErrorMessage,
      },
    })
    .catch(() => {});

  return success;
}
