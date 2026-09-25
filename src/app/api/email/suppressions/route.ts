import { NextRequest, NextResponse } from "next/server";
import { authenticateEmailApi } from "@/lib/email/api-auth-helper";
import { EmailSuppressionService } from "@/lib/services/email-suppression-service";
import { EmailSuppressionReason } from "@prisma/client";
import { EmailAuditLogger } from "@/lib/email/audit-logger";

export async function GET(req: NextRequest) {
  // Read-only: permitted for VIEWER and ADMIN
  const auth = await authenticateEmailApi(req, { requireAdminForMutations: false });
  if (!auth.authorized || !auth.clientId) return auth.errorResponse!;

  try {
    const { searchParams } = new URL(req.url);
    const page = parseInt(searchParams.get("page") || "1", 10);
    const limit = parseInt(searchParams.get("limit") || "50", 10);
    const reason = (searchParams.get("reason") as EmailSuppressionReason) || undefined;
    const email = searchParams.get("email");

    if (email) {
      const isSupp = await EmailSuppressionService.isSuppressed(auth.clientId, email);
      return NextResponse.json({ success: true, data: isSupp });
    }

    const result = await EmailSuppressionService.listSuppressions(auth.clientId, {
      page,
      limit,
      reason,
    });

    return NextResponse.json({ success: true, data: result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error listing suppressions";
    return NextResponse.json(
      { success: false, error: { code: "SERVER_ERROR", message: msg } },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  // Mutation: strictly ADMIN only (VIEWER denied)
  const auth = await authenticateEmailApi(req, { requireAdminForMutations: true });
  if (!auth.authorized || !auth.clientId) return auth.errorResponse!;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { success: false, error: { code: "BAD_REQUEST", message: "Invalid JSON body" } },
      { status: 400 }
    );
  }

  if (!body.email || typeof body.email !== "string") {
    return NextResponse.json(
      { success: false, error: { code: "VALIDATION_ERROR", message: "'email' is required" } },
      { status: 400 }
    );
  }

  const reason = (body.reason as EmailSuppressionReason) || EmailSuppressionReason.MANUAL;
  if (!Object.values(EmailSuppressionReason).includes(reason)) {
    return NextResponse.json(
      {
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message: `Invalid reason. Allowed: ${Object.values(EmailSuppressionReason).join(", ")}`,
        },
      },
      { status: 400 }
    );
  }

  try {
    const suppression = await EmailSuppressionService.addSuppression(
      auth.clientId,
      body.email,
      reason,
      typeof body.source === "string" ? body.source : "MANUAL_API",
      typeof body.metadata === "object" && body.metadata !== null ? (body.metadata as Record<string, unknown>) : null
    );

    EmailAuditLogger.log(
      auth.clientId,
      auth.role || "ADMIN",
      "SUPPRESSION_MANUALLY_ADDED",
      suppression.id,
      { email: body.email, reason }
    );

    return NextResponse.json({ success: true, data: suppression }, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to add suppression";
    return NextResponse.json(
      { success: false, error: { code: "BAD_REQUEST", message: msg } },
      { status: 400 }
    );
  }
}

export async function DELETE(req: NextRequest) {
  // Mutation: strictly ADMIN only (VIEWER denied)
  const auth = await authenticateEmailApi(req, { requireAdminForMutations: true });
  if (!auth.authorized || !auth.clientId) return auth.errorResponse!;

  const { searchParams } = new URL(req.url);
  const email = searchParams.get("email");

  if (!email) {
    return NextResponse.json(
      { success: false, error: { code: "VALIDATION_ERROR", message: "'email' query parameter is required" } },
      { status: 400 }
    );
  }

  try {
    const result = await EmailSuppressionService.removeSuppression(auth.clientId, email);

    EmailAuditLogger.log(
      auth.clientId,
      auth.role || "ADMIN",
      "SUPPRESSION_MANUALLY_REMOVED",
      undefined,
      { email }
    );

    return NextResponse.json({ success: true, data: result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to remove suppression";
    return NextResponse.json(
      { success: false, error: { code: "BAD_REQUEST", message: msg } },
      { status: 400 }
    );
  }
}
