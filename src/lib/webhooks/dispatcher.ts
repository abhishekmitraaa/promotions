import crypto from "crypto";
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

export interface DispatchOptions {
  clientId?: string;
  eventId?: string;
  messageEventId?: string;
}

/**
 * Sanitize response body to avoid storing secrets, huge HTML error pages, or sensitive tokens.
 */
export function sanitizeResponseBody(text: string, status?: number): string {
  if (!text) return "";
  const trimmed = text.trim();

  // If HTML document detected (common for 404/500 gateway error pages), do not store raw HTML
  if (
    trimmed.startsWith("<!DOCTYPE") ||
    trimmed.startsWith("<html") ||
    trimmed.includes("<body")
  ) {
    // Extract title if present
    const titleMatch = trimmed.match(/<title>([^<]+)<\/title>/i);
    const pageTitle = titleMatch ? titleMatch[1].trim() : "HTML Error Page";
    return `[HTML Response: ${pageTitle}${status ? ` (Status ${status})` : ""}]`;
  }

  // Sanitize potential token/key patterns
  const sanitized = trimmed
    .replace(/(bearer\s+)[a-zA-Z0-9_\-\.]{15,}/gi, "$1[REDACTED]")
    .replace(/(password["']?\s*[:=]\s*["']?)[^"'\s&]+/gi, "$1[REDACTED]")
    .replace(/(secret["']?\s*[:=]\s*["']?)[^"'\s&]+/gi, "$1[REDACTED]")
    .replace(/(access_token["']?\s*[:=]\s*["']?)[^"'\s&]+/gi, "$1[REDACTED]");

  return sanitized.substring(0, 1000);
}

/**
 * Dispatch an event to all active WebhookEndpoints registered for that event type.
 * When options.clientId is provided, only endpoints belonging to that clientId are dispatched.
 * Webhook delivery records are durably written to the database BEFORE any network call.
 */
export async function dispatchOutgoingWebhooks(
  eventType: string,
  data: Record<string, unknown>,
  optionsOrClientId?: DispatchOptions | string
): Promise<void> {
  const options: DispatchOptions =
    typeof optionsOrClientId === "string"
      ? { clientId: optionsOrClientId }
      : optionsOrClientId || {};

  try {
    const whereClause: { active: boolean; clientId?: string } = { active: true };
    if (options.clientId) {
      whereClause.clientId = options.clientId;
    }

    const endpoints = await prisma.webhookEndpoint.findMany({
      where: whereClause,
    });

    if (endpoints.length === 0) return;

    // Generate cryptographically strong, collision-resistant event ID
    const eventId = options.eventId || `evt_${crypto.randomUUID()}`;
    const eventPayload: WebhookEventPayload = {
      eventId,
      eventType,
      timestamp: new Date().toISOString(),
      data,
    };

    const rawPayload = JSON.stringify(eventPayload);
    const createdDeliveries: {
      deliveryId: string;
      url: string;
      encryptedSecret: string;
    }[] = [];

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
        logger.warn(
          `Skipping invalid or unsafe webhook URL for endpoint ${endpoint.id}: ${endpoint.url} - ${staticCheck.reason}`
        );
        continue;
      }

      // Create durable PENDING delivery record in DB
      const delivery = await prisma.webhookDelivery.create({
        data: {
          endpointId: endpoint.id,
          clientId: endpoint.clientId,
          eventId,
          messageEventId: options.messageEventId || null,
          eventType,
          payload: rawPayload,
          status: DeliveryStatus.PENDING,
          attemptCount: 0,
          nextAttemptAt: new Date(),
        },
      });

      createdDeliveries.push({
        deliveryId: delivery.id,
        url: endpoint.url,
        encryptedSecret: endpoint.encryptedSecret,
      });
    }

    // Execute first delivery attempt immediately for low-latency dispatch.
    // If it fails or process terminates, the durable PENDING state with nextAttemptAt
    // ensures the background queue worker will pick it up.
    await Promise.allSettled(
      createdDeliveries.map(async ({ deliveryId, url, encryptedSecret }) => {
        let signingSecret: string;
        try {
          signingSecret = decryptWebhookSecret(encryptedSecret);
        } catch (decryptErr) {
          logger.error(`Failed to decrypt webhook secret for delivery ${deliveryId}:`, decryptErr);
          await prisma.webhookDelivery
            .update({
              where: { id: deliveryId },
              data: {
                status: DeliveryStatus.FAILED,
                errorMessage: "Failed to decrypt endpoint secret",
              },
            })
            .catch(() => {});
          return;
        }

        await executeDeliveryAttempt(deliveryId, url, signingSecret, rawPayload, eventType, 0);
      })
    );
  } catch (error) {
    logger.error("Failed to query webhook endpoints or create deliveries for dispatch:", error);
  }
}

/**
 * Execute a single delivery attempt and atomically update WebhookDelivery state in the database.
 */
export async function executeDeliveryAttempt(
  deliveryId: string,
  url: string,
  signingSecret: string,
  rawPayload: string,
  eventType: string,
  currentAttemptCount: number
): Promise<boolean> {
  const timeoutMs = env.OUTBOUND_WEBHOOK_TIMEOUT_MS;
  const maxRetries = env.OUTBOUND_WEBHOOK_MAX_RETRIES;
  const nextAttemptNum = currentAttemptCount + 1;

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
          attemptCount: nextAttemptNum,
          lastAttemptAt: new Date(),
          lockedAt: null,
          nextAttemptAt: null,
          errorMessage: reason,
        },
      })
      .catch(() => {});

    return false;
  }

  const signature = signWebhookPayload(rawPayload, signingSecret);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let success = false;
  let responseStatus: number | null = null;
  let responseBody: string | null = null;
  let errorMessage: string | null = null;
  let isRetryable = false;

  try {
    logger.info(`Webhook delivery attempt ${nextAttemptNum}/${maxRetries + 1} for delivery ${deliveryId}`);

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
    responseStatus = res.status;
    const text = await res.text();
    responseBody = sanitizeResponseBody(text, res.status);

    if (res.ok) {
      success = true;
    } else {
      errorMessage = `HTTP ${res.status}: ${res.statusText || "Request failed"}`;
      // 4xx errors (client error on destination) are NON-RETRYABLE
      // 5xx errors (server errors on destination) are RETRYABLE
      if (res.status >= 500) {
        isRetryable = true;
      }
    }
  } catch (err) {
    clearTimeout(timer);
    errorMessage = err instanceof Error ? err.message : "Network error";
    // Network errors and timeouts are RETRYABLE
    isRetryable = true;
  }

  // Calculate next state
  let nextStatus: DeliveryStatus = DeliveryStatus.FAILED;
  let nextAttemptAt: Date | null = null;

  if (success) {
    nextStatus = DeliveryStatus.SUCCESS;
  } else if (isRetryable && nextAttemptNum < maxRetries) {
    nextStatus = DeliveryStatus.PENDING;
    // Exponential backoff with jitter: 2^(attempt - 1) * 1000ms + (0-500ms jitter)
    const backoffMs = Math.pow(2, nextAttemptNum - 1) * 1000 + Math.floor(Math.random() * 500);
    nextAttemptAt = new Date(Date.now() + backoffMs);
  } else {
    nextStatus = DeliveryStatus.FAILED;
  }

  await prisma.webhookDelivery
    .update({
      where: { id: deliveryId },
      data: {
        status: nextStatus,
        attemptCount: nextAttemptNum,
        lastAttemptAt: new Date(),
        nextAttemptAt,
        lockedAt: null,
        responseStatus,
        responseBody,
        errorMessage,
      },
    })
    .catch((dbErr) => {
      logger.error(`Failed to update delivery status for ${deliveryId}:`, dbErr);
    });

  return success;
}

/**
 * Worker function: Atomically claim and process pending webhook deliveries.
 * Safe for multi-worker concurrency using PostgreSQL FOR UPDATE SKIP LOCKED.
 */
export async function processWebhookDeliveryQueue(
  options: { batchSize?: number; maxRetries?: number } = {}
): Promise<{ claimed: number; succeeded: number; failed: number }> {
  const batchSize = options.batchSize || 10;
  const maxRetries = options.maxRetries ?? env.OUTBOUND_WEBHOOK_MAX_RETRIES;

  // 1. Reclaim stale locked deliveries (worker crash recovery after 2 minutes)
  await prisma.$executeRawUnsafe(`
    UPDATE "WebhookDelivery"
    SET "status" = 'PENDING',
        "lockedAt" = NULL
    WHERE "status" = 'PROCESSING'
      AND "lockedAt" < NOW() - INTERVAL '2 minutes';
  `).catch((err) => {
    logger.warn("Failed to reclaim stale locked webhook deliveries:", err);
  });

  // 2. Atomically claim eligible PENDING deliveries using FOR UPDATE SKIP LOCKED
  const claimedJobs = ((await prisma.$queryRawUnsafe(`
    WITH claimed AS (
      SELECT d.id
      FROM "WebhookDelivery" d
      WHERE d."status" = 'PENDING'
        AND (d."nextAttemptAt" IS NULL OR d."nextAttemptAt" <= NOW())
        AND d."attemptCount" < ${maxRetries}
      ORDER BY d."createdAt" ASC
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE "WebhookDelivery" d
    SET "status" = 'PROCESSING',
        "lockedAt" = NOW()
    FROM claimed c
    JOIN "WebhookEndpoint" e ON e.id = (SELECT "endpointId" FROM "WebhookDelivery" WHERE id = c.id)
    WHERE d.id = c.id
    RETURNING d.id, d."endpointId", d.payload, d."eventType", d."attemptCount", e.url, e."encryptedSecret";
  `).catch((err) => {
    logger.error("Failed to atomically claim webhook deliveries:", err);
    return [];
  })) || []) as {
    id: string;
    endpointId: string;
    payload: string;
    eventType: string;
    attemptCount: number;
    url: string;
    encryptedSecret: string;
  }[];

  let succeeded = 0;
  let failed = 0;

  for (const job of claimedJobs) {
    let signingSecret: string;
    try {
      signingSecret = decryptWebhookSecret(job.encryptedSecret);
    } catch (decryptErr) {
      logger.error(`Failed to decrypt webhook secret for job ${job.id}:`, decryptErr);
      await prisma.webhookDelivery
        .update({
          where: { id: job.id },
          data: {
            status: DeliveryStatus.FAILED,
            lockedAt: null,
            nextAttemptAt: null,
            errorMessage: "Failed to decrypt endpoint secret",
          },
        })
        .catch(() => {});
      failed += 1;
      continue;
    }

    const success = await executeDeliveryAttempt(
      job.id,
      job.url,
      signingSecret,
      job.payload,
      job.eventType,
      job.attemptCount
    );

    if (success) {
      succeeded += 1;
    } else {
      failed += 1;
    }
  }

  return { claimed: claimedJobs.length, succeeded, failed };
}

/**
 * Backward compatibility helper for manual single delivery retries.
 */
export async function deliverWebhookPayload(
  deliveryId: string,
  url: string,
  signingSecret: string,
  rawPayload: string,
  eventType: string
): Promise<boolean> {
  const delivery = await prisma.webhookDelivery.findUnique({
    where: { id: deliveryId },
    select: { attemptCount: true },
  });
  return executeDeliveryAttempt(
    deliveryId,
    url,
    signingSecret,
    rawPayload,
    eventType,
    delivery?.attemptCount ?? 0
  );
}
