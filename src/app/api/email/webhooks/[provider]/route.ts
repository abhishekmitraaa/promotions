import { NextRequest, NextResponse } from "next/server";
import { EmailProviderType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  verifyHmacWebhookSignature,
  verifyGmailPubSubWebhook,
  verifyAwsSesWebhook,
} from "@/lib/email/webhooks/verifier";
import {
  normalizeGenericEvent,
  normalizeSesEvent,
  validateNormalizedEvent,
} from "@/lib/email/webhooks/normalizer";
import { EmailEventService } from "@/lib/services/email-event-service";
import { NormalizedEmailWebhookEvent } from "@/lib/email/webhooks/types";
import { logger } from "@/lib/logger";

interface RouteParams {
  params: Promise<{ provider: string }>;
}

export async function POST(req: NextRequest, { params }: RouteParams) {
  const { provider } = await params;
  const providerLower = provider.toLowerCase();

  const rawBody = await req.text();
  const headers = req.headers;
  const { searchParams } = new URL(req.url);

  // 1. Mandatory Provider Configuration Binding & Tenant Resolution
  // Every email webhook MUST be associated with an exact, active EmailProviderConfig.
  // Webhooks are never accepted unbound.
  const configId =
    searchParams.get("configId") ||
    searchParams.get("providerConfigId") ||
    headers.get("x-provider-config-id");

  if (!configId) {
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

  if (!providerConfig || providerConfig.status !== "ACTIVE") {
    logger.warn(
      `[Webhook:${providerLower}] Rejected: Provider configuration '${configId}' not found or inactive`
    );
    return NextResponse.json(
      {
        success: false,
        error: {
          code: "INVALID_PROVIDER_CONFIG",
          message: "Email provider configuration not found or inactive",
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
      : EmailProviderType.MOCK;

  if (providerLower !== "generic" && providerConfig.providerType !== expectedType) {
    logger.warn(
      `[Webhook:${providerLower}] Rejected: Provider configuration '${configId}' type ${providerConfig.providerType} does not match endpoint provider ${providerLower}`
    );
    return NextResponse.json(
      {
        success: false,
        error: {
          code: "PROVIDER_TYPE_MISMATCH",
          message: `Provider configuration '${configId}' type does not match provider endpoint '${providerLower}'`,
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
      verification = verifyGmailPubSubWebhook(headers, tenantSecret, tokenQuery);
      break;
    }
    case "ses": {
      verification = verifyAwsSesWebhook(rawBody, headers, tenantSecret);
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
      verification = verifyHmacWebhookSignature(rawBody, headers, tenantSecret);
      break;
    }
  }

  if (!verification.valid) {
    logger.warn(
      `[Webhook:${providerLower}] Signature verification rejected for config '${configId}': ${verification.error}`
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
          code: "BAD_REQUEST",
          message: `Failed to parse or normalize webhook payload: ${msg}`,
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
      const msg = procErr instanceof Error ? procErr.message : String(procErr);
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

      logger.error(`[Webhook:${providerLower}] Error enqueuing event:`, procErr);
      results.push({
        success: false,
        error: msg,
      });
    }
  }

  return NextResponse.json(
    {
      success: true,
      data: {
        queued: results.length,
        results,
      },
    },
    { status: 202 }
  );
}
