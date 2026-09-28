import { NextRequest, NextResponse } from "next/server";
import { EmailProviderType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  verifyHmacWebhookSignature,
  verifyGmailPubSubWebhook,
  verifyAwsSesWebhookAsync,
} from "@/lib/email/webhooks/verifier";
import {
  normalizeGenericEvent,
  normalizeSesEvent,
  validateNormalizedEvent,
} from "@/lib/email/webhooks/normalizer";
import { EmailEventService } from "@/lib/services/email-event-service";
import { NormalizedEmailWebhookEvent } from "@/lib/email/webhooks/types";
import { logger } from "@/lib/logger";

import { checkRateLimit, getClientIp, rateLimitResponse } from "@/lib/rate-limit";

import { redactSecrets } from "@/lib/crypto";

interface RouteParams {
  params: Promise<{ provider: string }>;
}

const SUPPORTED_WEBHOOK_PROVIDERS = ["gmail", "ses", "mock", "generic"];

export async function POST(req: NextRequest, { params }: RouteParams) {
  const { provider } = await params;
  const providerLower = provider.toLowerCase();

  // Validate supported webhook endpoint provider
  if (!SUPPORTED_WEBHOOK_PROVIDERS.includes(providerLower)) {
    logger.warn(`[Webhook] Rejected unsupported provider endpoint: '${providerLower}'`);
    return NextResponse.json(
      {
        success: false,
        error: {
          code: "UNSUPPORTED_PROVIDER",
          message: `Unsupported webhook provider endpoint '${providerLower}'. Supported providers: ${SUPPORTED_WEBHOOK_PROVIDERS.join(", ")}`,
        },
      },
      { status: 400 }
    );
  }

  // MOCK provider forbidden in production environment
  if (providerLower === "mock" && process.env.NODE_ENV === "production") {
    logger.warn(`[Webhook] MOCK provider webhook rejected in production environment`);
    return NextResponse.json(
      {
        success: false,
        error: {
          code: "MOCK_PROVIDER_FORBIDDEN",
          message: "MOCK provider webhook endpoint is forbidden in production environment",
        },
      },
      { status: 400 }
    );
  }

  // Ingestion Rate Limit: 1,200 req / min per IP (protects against flood DoS while permitting batch webhook pushes)
  const clientIp = getClientIp(req);
  const webhookRl = await checkRateLimit(
    `rl:webhook:${providerLower}:${clientIp}`,
    1200,
    60000,
    { criticality: "LOW", failClosed: false }
  );
  if (!webhookRl.success) {
    return rateLimitResponse(webhookRl, "Webhook ingestion rate limit exceeded.");
  }

  const rawBody = await req.text();
  const headers = req.headers;
  const { searchParams } = new URL(req.url);

  // 1. Mandatory Provider Configuration Binding & Tenant Resolution
  // Every email webhook MUST be associated with an exact, active EmailProviderConfig.
  // Webhooks are never accepted unbound.
  const rawConfigId =
    searchParams.get("configId") ||
    searchParams.get("providerConfigId") ||
    headers.get("x-provider-config-id");
  const configId = rawConfigId?.trim();

  if (!configId || configId.length === 0) {
    logger.warn(
      `[Webhook:${providerLower}] Rejected: Missing required provider configuration binding (configId)`
    );
    return NextResponse.json(
      {
        success: false,
        error: {
          code: "MISSING_PROVIDER_CONFIG",
          message:
            "Email webhooks must be associated with an explicit EmailProviderConfig ID (?configId=... or X-Provider-Config-Id header)",
        },
      },
      { status: 400 }
    );
  }

  const providerConfig = await prisma.emailProviderConfig.findUnique({
    where: { id: configId },
    select: {
      id: true,
      clientId: true,
      status: true,
      providerType: true,
      encryptedCredentials: true,
      configMetadata: true,
    },
  });

  if (!providerConfig) {
    logger.warn(
      `[Webhook:${providerLower}] Rejected: Provider configuration '${configId}' not found`
    );
    return NextResponse.json(
      {
        success: false,
        error: {
          code: "INVALID_PROVIDER_CONFIG",
          message: "Email provider configuration not found",
        },
      },
      { status: 401 }
    );
  }

  if (providerConfig.status !== "ACTIVE") {
    logger.warn(
      `[Webhook:${providerLower}] Rejected: Provider configuration '${configId}' is inactive`
    );
    return NextResponse.json(
      {
        success: false,
        error: {
          code: "INACTIVE_PROVIDER_CONFIG",
          message: "Email provider configuration is inactive",
        },
      },
      { status: 401 }
    );
  }

  // Verify provider configuration matches endpoint provider type
  const expectedType =
    providerLower === "gmail"
      ? EmailProviderType.GMAIL
      : providerLower === "ses"
      ? EmailProviderType.SES
      : providerLower === "mock"
      ? EmailProviderType.MOCK
      : null;

  if (expectedType && providerConfig.providerType !== expectedType) {
    logger.warn(
      `[Webhook:${providerLower}] Rejected: Provider configuration '${configId}' type ${providerConfig.providerType} does not match endpoint provider ${providerLower}`
    );
    return NextResponse.json(
      {
        success: false,
        error: {
          code: "PROVIDER_TYPE_MISMATCH",
          message: `Provider configuration '${configId}' type '${providerConfig.providerType}' does not match provider endpoint '${providerLower}'`,
        },
      },
      { status: 400 }
    );
  }

  // 2. Extract tenant-configured webhook secret
  let tenantSecret: string | undefined;
  if (providerConfig.configMetadata) {
    try {
      const meta = JSON.parse(providerConfig.configMetadata);
      if (typeof meta.webhookSecret === "string" && meta.webhookSecret.trim().length > 0) {
        tenantSecret = meta.webhookSecret.trim();
      } else if (
        typeof meta.pubsubVerificationToken === "string" &&
        meta.pubsubVerificationToken.trim().length > 0
      ) {
        tenantSecret = meta.pubsubVerificationToken.trim();
      }
    } catch {
      // Ignore metadata parsing error
    }
  }

  // 3. Signature & Authenticity Verification (Fail-Closed)
  let verification: { valid: boolean; error?: string } = { valid: false };

  switch (providerLower) {
    case "gmail": {
      const tokenQuery =
        searchParams.get("token") || searchParams.get("verification_token");
      if (!tenantSecret && !process.env.GMAIL_WEBHOOK_VERIFICATION_TOKEN) {
        logger.warn(
          `[Webhook:gmail] Rejected: Provider configuration '${configId}' has no Pub/Sub verification token configured`
        );
        return NextResponse.json(
          {
            success: false,
            error: {
              code: "MISSING_WEBHOOK_SECRET",
              message: "Google Pub/Sub verification token is not configured on this provider configuration",
            },
          },
          { status: 401 }
        );
      }
      verification = verifyGmailPubSubWebhook(headers, tenantSecret, tokenQuery);
      break;
    }
    case "ses": {
      verification = await verifyAwsSesWebhookAsync(rawBody, headers, tenantSecret);
      break;
    }
    case "mock":
    case "generic":
    default: {
      if (!tenantSecret) {
        logger.warn(
          `[Webhook:${providerLower}] Rejected: Provider configuration '${configId}' has no webhook secret configured`
        );
        return NextResponse.json(
          {
            success: false,
            error: {
              code: "MISSING_WEBHOOK_SECRET",
              message: "Webhook secret is not configured on this provider configuration",
            },
          },
          { status: 401 }
        );
      }
      verification = verifyHmacWebhookSignature(rawBody, headers, tenantSecret, { requireTimestamp: true });
      break;
    }
  }

  if (!verification.valid) {
    logger.warn(
      `[Webhook:${providerLower}] Signature verification rejected for config '${configId}': ${redactSecrets(verification.error || "")}`
    );
    return NextResponse.json(
      {
        success: false,
        error: {
          code: "UNAUTHORIZED",
          message: verification.error || "Invalid webhook signature",
        },
      },
      { status: 401 }
    );
  }

  // 4. Parse JSON & Normalize Event Payload
  let normalizedEvents: NormalizedEmailWebhookEvent[] = [];
  try {
    const parsedBody = JSON.parse(rawBody);

    if (providerLower === "ses") {
      normalizedEvents = normalizeSesEvent(parsedBody);
    } else {
      const pType =
        providerLower === "gmail"
          ? EmailProviderType.GMAIL
          : providerLower === "ses"
          ? EmailProviderType.SES
          : EmailProviderType.MOCK;

      if (Array.isArray(parsedBody)) {
        for (const item of parsedBody) {
          normalizedEvents.push(...normalizeGenericEvent(item, pType));
        }
      } else {
        normalizedEvents = normalizeGenericEvent(parsedBody, pType);
      }
    }
  } catch (parseErr) {
    const msg = parseErr instanceof Error ? parseErr.message : "Malformed payload";
    return NextResponse.json(
      {
        success: false,
        error: {
          code: "INVALID_PAYLOAD",
          message: `Failed to parse or normalize webhook payload: ${redactSecrets(msg)}`,
        },
      },
      { status: 400 }
    );
  }

  // 5. Strict Payload Validation for Normalized Fields
  for (const event of normalizedEvents) {
    const validation = validateNormalizedEvent(event);
    if (!validation.valid) {
      logger.warn(
        `[Webhook:${providerLower}] Payload validation rejected for config '${configId}': ${validation.errors.join("; ")}`
      );
      return NextResponse.json(
        {
          success: false,
          error: {
            code: "INVALID_PAYLOAD",
            message: `Normalized payload validation failed: ${validation.errors.join("; ")}`,
            details: validation.errors,
          },
        },
        { status: 400 }
      );
    }
  }

  // 6. Persist authoritative EmailEvent and enqueue asynchronous processing
  const results = [];
  for (const event of normalizedEvents) {
    // Authoritatively bind event to the tenant from providerConfig
    event.clientId = providerConfig.clientId;

    try {
      const result = await EmailEventService.recordAndEnqueueEvent(
        event,
        providerConfig
      );
      results.push(result);
    } catch (procErr) {
      const rawMsg = procErr instanceof Error ? procErr.message : String(procErr);
      const msg = redactSecrets(rawMsg);
      if (msg.includes("AMBIGUOUS_TENANT_BINDING")) {
        logger.warn(`[Webhook:${providerLower}] ${msg}`);
        return NextResponse.json(
          {
            success: false,
            error: {
              code: "AMBIGUOUS_TENANT_BINDING",
              message:
                "Webhook event cannot be unambiguously associated with a tenant or provider configuration",
            },
          },
          { status: 400 }
        );
      }

      logger.error(`[Webhook:${providerLower}] Error enqueuing event: ${msg}`);
      results.push({
        success: false,
        deduplicated: false,
        error: msg,
      });
    }
  }

  const successful = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);

  // Honest queue failure reporting: if events were received but queueing failed (and 0 succeeded),
  // return HTTP 503 so upstream webhook providers know ingestion failed and retry!
  if (results.length > 0 && successful.length === 0) {
    logger.error(
      `[Webhook:${providerLower}] All ${results.length} events failed to enqueue for config '${configId}'`
    );
    return NextResponse.json(
      {
        success: false,
        error: {
          code: "QUEUE_ERROR",
          message: "Failed to enqueue webhook events for processing. Upstream retry required.",
          details: results,
        },
      },
      { status: 503 }
    );
  }

  const queuedCount = successful.filter((r) => !("deduplicated" in r && r.deduplicated)).length;
  const deduplicatedCount = successful.filter((r) => "deduplicated" in r && r.deduplicated).length;

  return NextResponse.json(
    {
      success: true,
      data: {
        queued: queuedCount,
        deduplicated: deduplicatedCount,
        failed: failed.length,
        results,
      },
    },
    { status: 202 }
  );
}
