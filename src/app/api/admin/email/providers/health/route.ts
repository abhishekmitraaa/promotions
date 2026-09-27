import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { providerRegistry, ProviderUnavailableError, MockProviderForbiddenError } from "@/lib/email/registry";
import { EmailProviderStatus, EmailProviderType } from "@prisma/client";

/**
 * GET /api/admin/email/providers/health
 *
 * Authenticated health verification endpoint for email providers.
 * Requires ADMIN role.
 * Queries:
 * - ?id=<providerConfigId> (verify specific provider)
 * - ?clientId=<clientId> (verify default or all active providers for tenant)
 */
export async function GET(req: NextRequest) {
  const auth = await requireUser(req, "ADMIN");
  if (auth.response) return auth.response;

  try {
    const { searchParams } = new URL(req.url);
    const providerId = searchParams.get("id");
    const clientId = searchParams.get("clientId");

    if (providerId) {
      const config = await prisma.emailProviderConfig.findUnique({
        where: { id: providerId },
      });

      if (!config) {
        return NextResponse.json(
          { success: false, error: "Email provider configuration not found" },
          { status: 404 }
        );
      }

      const healthResult = await verifyConfigHealth(config);
      return NextResponse.json({ success: true, data: healthResult });
    }

    // Verify all active providers for the tenant (or all active if no clientId)
    const configs = await prisma.emailProviderConfig.findMany({
      where: {
        clientId: clientId || undefined,
        status: EmailProviderStatus.ACTIVE,
      },
      orderBy: { createdAt: "desc" },
    });

    const results = await Promise.all(configs.map((c) => verifyConfigHealth(c)));
    return NextResponse.json({
      success: true,
      data: results,
      totalChecked: results.length,
      allHealthy: results.every((r) => r.healthy),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error performing provider health verification";
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}

/**
 * POST /api/admin/email/providers/health
 * Allows triggering a health verification via POST body.
 */
export async function POST(req: NextRequest) {
  const auth = await requireUser(req, "ADMIN");
  if (auth.response) return auth.response;

  try {
    const body = await req.json().catch(() => ({}));
    const providerId = body.id || body.providerConfigId;

    if (!providerId) {
      return NextResponse.json(
        { success: false, error: "Provider 'id' is required" },
        { status: 400 }
      );
    }

    const config = await prisma.emailProviderConfig.findUnique({
      where: { id: providerId },
    });

    if (!config) {
      return NextResponse.json(
        { success: false, error: "Email provider configuration not found" },
        { status: 404 }
      );
    }

    const healthResult = await verifyConfigHealth(config);
    return NextResponse.json({ success: true, data: healthResult });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error performing provider health verification";
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}

interface ProviderHealthResponse {
  id: string;
  clientId: string;
  name: string;
  providerType: EmailProviderType;
  healthy: boolean;
  latencyMs?: number;
  message?: string;
  error?: string;
  lastVerifiedAt: Date;
  status: EmailProviderStatus;
}

async function verifyConfigHealth(config: {
  id: string;
  clientId: string;
  name: string;
  providerType: EmailProviderType;
  status: EmailProviderStatus;
  encryptedCredentials?: string | null;
  senderEmail?: string | null;
}): Promise<ProviderHealthResponse> {
  const checkedAt = new Date();

  // 1. Guard against unsupported providers
  if (config.providerType === EmailProviderType.SES || config.providerType === EmailProviderType.SMTP) {
    const err = `Email provider '${config.providerType}' is unavailable (operational adapter not implemented).`;
    await prisma.emailProviderConfig.update({
      where: { id: config.id },
      data: { errorMessage: err },
    });
    return {
      id: config.id,
      clientId: config.clientId,
      name: config.name,
      providerType: config.providerType,
      healthy: false,
      error: err,
      lastVerifiedAt: checkedAt,
      status: config.status,
    };
  }

  // 2. Guard against MOCK in production
  if (config.providerType === EmailProviderType.MOCK && process.env.NODE_ENV === "production") {
    const err = "MOCK provider is forbidden in production environments.";
    await prisma.emailProviderConfig.update({
      where: { id: config.id },
      data: { errorMessage: err },
    });
    return {
      id: config.id,
      clientId: config.clientId,
      name: config.name,
      providerType: config.providerType,
      healthy: false,
      error: err,
      lastVerifiedAt: checkedAt,
      status: config.status,
    };
  }

  // 3. Guard against missing credentials
  if (!config.encryptedCredentials && config.providerType !== EmailProviderType.MOCK) {
    const err = "Provider configuration is missing encrypted credentials.";
    await prisma.emailProviderConfig.update({
      where: { id: config.id },
      data: { errorMessage: err },
    });
    return {
      id: config.id,
      clientId: config.clientId,
      name: config.name,
      providerType: config.providerType,
      healthy: false,
      error: err,
      lastVerifiedAt: checkedAt,
      status: config.status,
    };
  }

  try {
    const provider = providerRegistry.get(config.providerType, {
      encryptedCredentials: config.encryptedCredentials || undefined,
      senderEmail: config.senderEmail || undefined,
    });

    let healthy = false;
    let latencyMs: number | undefined;
    let message: string | undefined;
    let error: string | undefined;

    if (typeof provider.checkHealth === "function") {
      const result = await provider.checkHealth();
      healthy = result.healthy;
      latencyMs = result.latencyMs;
      message = result.message;
      error = result.error;
    } else if (typeof provider.verifyCredentials === "function") {
      const start = performance.now();
      const result = await provider.verifyCredentials();
      latencyMs = Math.round(performance.now() - start);
      healthy = result.valid;
      error = result.error;
      message = result.valid ? "Credentials verified successfully" : undefined;
    } else {
      healthy = true;
      message = "Provider adapter active";
    }

    // Persist verified state
    await prisma.emailProviderConfig.update({
      where: { id: config.id },
      data: {
        lastVerifiedAt: healthy ? checkedAt : undefined,
        errorMessage: healthy ? null : error || "Health check failed",
      },
    });

    return {
      id: config.id,
      clientId: config.clientId,
      name: config.name,
      providerType: config.providerType,
      healthy,
      latencyMs,
      message,
      error: error || undefined,
      lastVerifiedAt: checkedAt,
      status: config.status,
    };
  } catch (err: unknown) {
    let safeErr = "Failed to instantiate or verify provider";
    if (err instanceof ProviderUnavailableError || err instanceof MockProviderForbiddenError) {
      safeErr = err.message;
    } else if (err instanceof Error) {
      safeErr = err.message;
    }

    await prisma.emailProviderConfig.update({
      where: { id: config.id },
      data: { errorMessage: safeErr },
    });

    return {
      id: config.id,
      clientId: config.clientId,
      name: config.name,
      providerType: config.providerType,
      healthy: false,
      error: safeErr,
      lastVerifiedAt: checkedAt,
      status: config.status,
    };
  }
}
