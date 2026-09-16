import { prisma } from "../prisma";
import { signWebhookPayload } from "./signature";
import { logger } from "../logger";
import { env } from "../env";
import { DeliveryStatus } from "@prisma/client";
import { decryptWebhookSecret } from "../crypto";
import { validateWebhookUrlSync, validateWebhookUrlForDelivery } from "./ssrf";

export interface WebhookEventPayload {
  eventId: string;
  eventType: string;
  timestamp: string;
  data: Record<string, unknown>;
}

/**
 * Dispatch an event to all active WebhookEndpoints registered for that event type.
 * When clientId is provided, only endpoints belonging to that clientId are dispatched.
 */
export async function dispatchOutgoingWebhooks(
  eventType: string,
  data: Record<string, unknown>,
  clientId?: string
): Promise<void> {
  try {
    const whereClause: { active: boolean; clientId?: string } = { active: true };
    if (clientId) {
      whereClause.clientId = clientId;
    }

    const endpoints = await prisma.webhookEndpoint.findMany({
      where: whereClause,
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

      // Static URL validation
      const staticCheck = validateWebhookUrlSync(endpoint.url);
      if (!staticCheck.valid) {
        logger.warn(`Skipping invalid or unsafe webhook URL: ${endpoint.url} - ${staticCheck.reason}`);
        continue;
      }

      // Decrypt stored webhook signing secret
      let signingSecret: string;
      try {
        signingSecret = decryptWebhookSecret(endpoint.encryptedSecret);
      } catch (decryptErr) {
        logger.error(`Failed to decrypt webhook secret for endpoint ${endpoint.id}:`, decryptErr);
        continue;
      }

      // Create PENDING delivery record with tenant clientId
      const delivery = await prisma.webhookDelivery.create({
        data: {
          endpointId: endpoint.id,
          clientId: endpoint.clientId,
          eventId,
          eventType,
          payload: rawPayload,
          status: DeliveryStatus.PENDING,
          attemptCount: 0,
        },
      });

      // Deliver asynchronously
      deliverWebhookPayload(delivery.id, endpoint.url, signingSecret, rawPayload, eventType).catch((err) => {
        logger.error(`Webhook delivery execution error for delivery ${delivery.id}:`, err);
      });
    }
  } catch (error) {
    logger.error("Failed to query webhook endpoints for dispatch:", error);
  }
}

/**
 * Deliver payload over HTTP POST with SSRF revalidation and retries.
 */
export async function deliverWebhookPayload(
  deliveryId: string,
  url: string,
  signingSecret: string,
  rawPayload: string,
  eventType: string
): Promise<boolean> {
  const timeoutMs = env.OUTBOUND_WEBHOOK_TIMEOUT_MS;
  const maxRetries = env.OUTBOUND_WEBHOOK_MAX_RETRIES;

  // SSRF Revalidation at delivery time (DNS resolution check)
  const ssrfCheck = await validateWebhookUrlForDelivery(url);
  if (!ssrfCheck.safe) {
    const reason = `SSRF protection blocked webhook delivery: ${ssrfCheck.reason}`;
    logger.error(`[SSRF Blocked] Delivery ${deliveryId} to ${url}: ${reason}`);

    await prisma.webhookDelivery
      .update({
        where: { id: deliveryId },
        data: {
          status: DeliveryStatus.FAILED,
          attemptCount: 1,
          lastAttemptAt: new Date(),
          errorMessage: reason,
        },
      })
      .catch(() => {});

    return false;
  }

  const signature = signWebhookPayload(rawPayload, signingSecret);

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
