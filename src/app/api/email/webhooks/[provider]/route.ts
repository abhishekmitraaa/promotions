import { NextRequest, NextResponse } from "next/server";
import { EmailProviderType } from "@prisma/client";
import {
  verifyHmacWebhookSignature,
  verifyGmailPubSubWebhook,
  verifyAwsSesWebhook,
} from "@/lib/email/webhooks/verifier";
import {
  normalizeGenericEvent,
  normalizeSesEvent,
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

  // 1. Signature Verification according to provider
  let verification: { valid: boolean; error?: string } = { valid: false };

  switch (providerLower) {
    case "gmail": {
      const { searchParams } = new URL(req.url);
      const tokenQuery = searchParams.get("token");
      verification = verifyGmailPubSubWebhook(headers, undefined, tokenQuery);
      break;
    }
    case "ses": {
      verification = verifyAwsSesWebhook(rawBody, headers);
      break;
    }
    case "mock":
    case "generic":
    default: {
      const secret = process.env.EMAIL_WEBHOOK_SECRET || process.env.AUTH_SESSION_SECRET || "dev-webhook-secret";
      verification = verifyHmacWebhookSignature(rawBody, headers, secret);
      break;
    }
  }

  if (!verification.valid) {
    logger.warn(`[Webhook:${providerLower}] Signature verification rejected: ${verification.error}`);
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

  // 2. Normalize Event Payload
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

      // Handle array or single event
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

  // 3. Process normalized events through common pipeline
  const results = [];
  for (const event of normalizedEvents) {
    try {
      const result = await EmailEventService.enqueueOrProcess(event);
      results.push(result);
    } catch (procErr) {
      logger.error(`[Webhook:${providerLower}] Error processing event:`, procErr);
      results.push({
        success: false,
        error: procErr instanceof Error ? procErr.message : "Processing error",
      });
    }
  }

  return NextResponse.json({
    success: true,
    data: {
      processed: results.length,
      results,
    },
  });
}
