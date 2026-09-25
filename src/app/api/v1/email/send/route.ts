import { NextRequest, NextResponse } from "next/server";
import { authenticateApiKey } from "@/lib/api-auth";
import { checkRateLimit } from "@/lib/rate-limit";
import { publicEmailSendSchema } from "@/lib/validation/email";
import { EmailTemplateService } from "@/lib/services/email-template-service";
import { TemplateEngine } from "@/lib/email/template-engine";
import { EmailSuppressionService } from "@/lib/services/email-suppression-service";
import { prisma } from "@/lib/prisma";
import { normalizeEmail } from "@/lib/email/normalization";
import { EmailDeliveryStatus, EmailProviderType, EmailType } from "@prisma/client";
import { providerRegistry } from "@/lib/email/registry";
import { getTransactionalQueue, getCampaignQueue } from "@/lib/email/queue/queues";
import { JOB_NAMES, getTransactionalJobId, getCampaignJobId, CampaignJobData } from "@/lib/email/queue/types";

export async function POST(req: NextRequest) {
  // 1. Authenticate API Key & Resolve Tenant
  const auth = await authenticateApiKey(req);
  if (!auth.authenticated || !auth.clientId) {
    return auth.errorResponse || NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const clientId = auth.clientId;

  // 2. Distributed Rate Limiting (60 requests per minute per API key)
  const rateLimit = await checkRateLimit(`email_send_key_${auth.keyId || clientId}`, 60, 60000);
  if (!rateLimit.success) {
    return NextResponse.json(
      {
        success: false,
        error: {
          code: "RATE_LIMITED",
          message: `Too many email dispatch requests. Retry in ${rateLimit.resetSeconds} seconds.`,
        },
      },
      {
        status: 429,
        headers: {
          "Retry-After": String(rateLimit.resetSeconds),
        },
      }
    );
  }

  // 3. Parse JSON Body
  let bodyJson: unknown;
  try {
    bodyJson = await req.json();
  } catch {
    return NextResponse.json(
      {
        success: false,
        error: { code: "BAD_REQUEST", message: "Invalid JSON request body" },
      },
      { status: 400 }
    );
  }

  // 4. Validate Schema (Requires explicit TRANSACTIONAL or PROMOTIONAL type)
  const parseResult = publicEmailSendSchema.safeParse(bodyJson);
  if (!parseResult.success) {
    return NextResponse.json(
      {
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "Request payload validation failed",
          details: parseResult.error.format(),
        },
      },
      { status: 400 }
    );
  }

  const input = parseResult.data;
  const recipientEmail = typeof input.to === "string" ? input.to : input.to.email;
  const recipientName = typeof input.to === "object" ? input.to.name : undefined;
  const normalizedTo = normalizeEmail(recipientEmail);

  // 5. Marketing Safety Enforcement for PROMOTIONAL Emails
  if (input.type === "PROMOTIONAL") {
    // Check suppression list
    const isSuppressed = await EmailSuppressionService.isSuppressed(clientId, normalizedTo);
    if (isSuppressed.suppressed) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: "RECIPIENT_SUPPRESSED",
            message: `Recipient '${recipientEmail}' is on the tenant suppression list and cannot receive promotional mail.`,
          },
        },
        { status: 400 }
      );
    }

    // Check contact consent if contact exists
    const contact = await prisma.emailContact.findFirst({
      where: { clientId, normalizedEmail: normalizedTo },
    });

    if (contact && (!contact.hasMarketingConsent || contact.status !== "SUBSCRIBED")) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: "MARKETING_CONSENT_REQUIRED",
            message: `Recipient '${recipientEmail}' has not granted explicit marketing consent or is unsubscribed.`,
          },
        },
        { status: 400 }
      );
    }
  }

  // 6. Template Resolution or Direct Content Rendering
  let subject = input.subject || "";

  if (input.templateId) {
    const template = await EmailTemplateService.getTemplateById(clientId, input.templateId);
    if (!template) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: "TEMPLATE_NOT_FOUND",
            message: `Template '${input.templateId}' not found for tenant '${clientId}'.`,
          },
        },
        { status: 404 }
      );
    }

    // Select version: explicit version or active version
    const version = input.templateVersionId
      ? template.versions.find((v) => v.id === input.templateVersionId)
      : template.versions.find((v) => v.status === "ACTIVE") || template.versions[0];

    if (!version) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: "TEMPLATE_VERSION_NOT_FOUND",
            message: "No active template version found.",
          },
        },
        { status: 404 }
      );
    }

    const variables = {
      email: recipientEmail,
      firstName: recipientName || "",
      ...input.variables,
    };

    const rendered = TemplateEngine.renderTemplate(version, variables);
    subject = rendered.subject;
  }

  // 7. Resolve Tenant Provider & Sender
  let providerType: EmailProviderType = EmailProviderType.MOCK;
  let fromAddress = input.from || "notifications@whatsapphub.internal";

  try {
    const resolved = await providerRegistry.resolveForTenant(clientId);
    providerType = resolved.providerType;
    if (!input.from && resolved.senderEmail) {
      fromAddress = resolved.senderEmail;
    }
  } catch {
    // Falls back to mock provider in testing/development
  }

  // 8. Create Delivery Record
  const idempotencyKey = req.headers.get("idempotency-key") || undefined;

  let delivery;
  try {
    delivery = await prisma.emailDelivery.create({
      data: {
        clientId,
        category: input.type as EmailType,
        providerType,
        from: fromAddress,
        to: recipientEmail,
        subject,
        status: EmailDeliveryStatus.QUEUED,
        idempotencyKey,
      },
    });
  } catch (err: unknown) {
    if (typeof err === "object" && err !== null && "code" in err && (err as { code: string }).code === "P2002") {
      // Idempotency conflict
      const existing = await prisma.emailDelivery.findFirst({
        where: { clientId, idempotencyKey },
      });
      return NextResponse.json({
        success: true,
        data: {
          deliveryId: existing?.id,
          status: existing?.status,
          recipient: recipientEmail,
          category: input.type,
          deduplicated: true,
        },
      });
    }
    throw err;
  }

  // 9. Queue Asynchronously
  try {
    if (input.type === "TRANSACTIONAL") {
      const queue = getTransactionalQueue();
      await queue.add(
        JOB_NAMES.SEND_TRANSACTIONAL,
        {
          deliveryId: delivery.id,
          clientId,
          category: "TRANSACTIONAL",
        },
        { jobId: getTransactionalJobId(delivery.id) }
      );
    } else {
      const queue = getCampaignQueue();
      const jobData: CampaignJobData = {
        campaignId: `api-campaign-${delivery.id}`,
        clientId,
        category: "PROMOTIONAL",
      };
      await queue.add(JOB_NAMES.SEND_CAMPAIGN_RECIPIENT, jobData, {
        jobId: getCampaignJobId(`del-${delivery.id}`),
      });
    }
  } catch {
    // Non-fatal if queue is offline during local test
  }

  return NextResponse.json(
    {
      success: true,
      data: {
        deliveryId: delivery.id,
        status: delivery.status,
        recipient: recipientEmail,
        category: input.type,
      },
    },
    { status: 202 }
  );
}
