import { NextRequest, NextResponse } from "next/server";
import { authenticateApiKey } from "@/lib/api-auth";
import { checkRateLimit, getClientIp, rateLimitResponse } from "@/lib/rate-limit";
import { publicEmailSendSchema } from "@/lib/validation/email";
import { EmailTemplateService } from "@/lib/services/email-template-service";
import { TemplateEngine } from "@/lib/email/template-engine";
import { EmailSuppressionService } from "@/lib/services/email-suppression-service";
import { prisma } from "@/lib/prisma";
import { normalizeEmail } from "@/lib/email/normalization";
import { EmailDeliveryStatus, EmailProviderType, EmailType } from "@prisma/client";
import { providerRegistry } from "@/lib/email/registry";
import { getTransactionalQueue, getCampaignQueue } from "@/lib/email/queue/queues";
import {
  JOB_NAMES,
  getTransactionalJobId,
  getPromotionalJobId,
  TransactionalJobData,
  PromotionalJobData,
} from "@/lib/email/queue/types";

export async function POST(req: NextRequest) {
  // 1. Authenticate API Key & Resolve Tenant
  const auth = await authenticateApiKey(req);
  if (!auth.authenticated || !auth.clientId) {
    return auth.errorResponse || NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const clientId = auth.clientId;

  // 2. Distributed Multi-Dimensional Rate Limiting
  const clientIp = getClientIp(req);

  // Tenant / API Key Limit: 60 requests per minute
  const tenantLimit = await checkRateLimit(
    `email_send_key_${auth.keyId || clientId}`,
    60,
    60000,
    { criticality: "HIGH", syncToDb: true }
  );
  if (!tenantLimit.success) {
    return rateLimitResponse(
      tenantLimit,
      `Too many email dispatch requests for tenant. Retry in ${tenantLimit.resetSeconds} seconds.`,
      "RATE_LIMITED"
    );
  }

  // IP Limit: 60 requests per minute per IP (prevents instance-hopping floods)
  const ipLimit = await checkRateLimit(
    `rl:ip:${clientIp}:email_send`,
    60,
    60000,
    { criticality: "HIGH" }
  );
  if (!ipLimit.success) {
    return rateLimitResponse(
      ipLimit,
      `Too many email dispatch requests from IP address. Retry in ${ipLimit.resetSeconds} seconds.`,
      "IP_RATE_LIMITED"
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

  // Per-Recipient Abuse Protection: 10 requests per minute per recipient
  const recipientLimit = await checkRateLimit(
    `rl:rcpt:${clientId}:${normalizedTo}:email_send`,
    10,
    60000,
    { criticality: "HIGH" }
  );
  if (!recipientLimit.success) {
    return rateLimitResponse(
      recipientLimit,
      `Too many email dispatch requests to recipient '${recipientEmail}'. Abuse protection limit reached. Retry in ${recipientLimit.resetSeconds} seconds.`,
      "RECIPIENT_RATE_LIMITED"
    );
  }

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
  let finalSubject = input.subject || "";
  let finalHtml = input.html;
  let finalText = input.text;
  let resolvedTemplateId: string | undefined = input.templateId;
  let resolvedTemplateVersionId: string | undefined = input.templateVersionId;

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
    finalSubject = rendered.subject;
    finalHtml = rendered.html;
    finalText = rendered.text;
    resolvedTemplateId = template.id;
    resolvedTemplateVersionId = version.id;
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

  // 8. Create Authoritative Delivery Record
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
        replyTo: input.replyTo || null,
        subject: finalSubject,
        htmlContent: finalHtml || null,
        textContent: finalText || null,
        templateId: resolvedTemplateId || null,
        templateVersionId: resolvedTemplateVersionId || null,
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
    const msg = err instanceof Error ? err.message : "Database failure";
    return NextResponse.json(
      {
        success: false,
        error: {
          code: "DATABASE_ERROR",
          message: `Database error while creating delivery record: ${msg}`,
        },
      },
      { status: 500 }
    );
  }

  // 9. Queue Asynchronously (Honest Queue Failure Contract)
  try {
    if (input.type === "TRANSACTIONAL") {
      const queue = getTransactionalQueue();
      const jobData: TransactionalJobData = {
        deliveryId: delivery.id,
        clientId,
        category: "TRANSACTIONAL",
      };
      await queue.add(JOB_NAMES.SEND_TRANSACTIONAL, jobData, {
        jobId: getTransactionalJobId(delivery.id),
      });
    } else {
      const queue = getCampaignQueue();
      const jobData: PromotionalJobData = {
        deliveryId: delivery.id,
        clientId,
        category: "PROMOTIONAL",
      };
      await queue.add(JOB_NAMES.SEND_PROMOTIONAL, jobData, {
        jobId: getPromotionalJobId(delivery.id),
      });
    }
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : "Failed to enqueue delivery job";
    await prisma.emailDelivery.updateMany({
      where: { id: delivery.id },
      data: {
        status: EmailDeliveryStatus.FAILED,
        errorCode: "QUEUE_ENQUEUE_FAILED",
        errorMessage: errorMsg,
        failedAt: new Date(),
      },
    });

    return NextResponse.json(
      {
        success: false,
        error: {
          code: "QUEUE_ERROR",
          message: "Failed to enqueue email dispatch job. Durable delivery marked as failed.",
        },
      },
      { status: 500 }
    );
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
