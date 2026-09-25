import { NextRequest, NextResponse } from "next/server";
import { authenticateEmailApi } from "@/lib/email/api-auth-helper";
import { EmailContactService } from "@/lib/services/email-contact-service";
import { EmailContactStatus } from "@prisma/client";

export async function GET(req: NextRequest) {
  // Read-only: permitted for VIEWER and ADMIN
  const auth = await authenticateEmailApi(req, { requireAdminForMutations: false });
  if (!auth.authorized || !auth.clientId) return auth.errorResponse!;

  try {
    const { searchParams } = new URL(req.url);
    const page = parseInt(searchParams.get("page") || "1", 10);
    const limit = parseInt(searchParams.get("limit") || "50", 10);
    const search = searchParams.get("search") || undefined;
    const status = (searchParams.get("status") as EmailContactStatus) || undefined;
    const listId = searchParams.get("listId") || undefined;
    const verifiedParam = searchParams.get("verified");
    const verified = verifiedParam !== null ? verifiedParam === "true" : undefined;
    const consentParam = searchParams.get("hasMarketingConsent");
    const hasMarketingConsent = consentParam !== null ? consentParam === "true" : undefined;

    const result = await EmailContactService.listContacts(auth.clientId, {
      page,
      limit,
      search,
      status,
      listId,
      verified,
      hasMarketingConsent,
    });

    return NextResponse.json({ success: true, data: result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to list contacts";
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
      { success: false, error: { code: "VALIDATION_ERROR", message: "Valid email is required" } },
      { status: 400 }
    );
  }

  try {
    const contact = await EmailContactService.createContact(auth.clientId, {
      email: body.email,
      firstName: typeof body.firstName === "string" ? body.firstName : undefined,
      lastName: typeof body.lastName === "string" ? body.lastName : undefined,
      metadata: typeof body.metadata === "object" && body.metadata !== null ? (body.metadata as Record<string, unknown>) : undefined,
      verified: typeof body.verified === "boolean" ? body.verified : undefined,
      hasMarketingConsent: typeof body.hasMarketingConsent === "boolean" ? body.hasMarketingConsent : undefined,
      consentSource: typeof body.consentSource === "string" ? body.consentSource : undefined,
    });

    return NextResponse.json({ success: true, data: contact }, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to create contact";
    const status = msg.includes("already exists") ? 409 : 400;
    return NextResponse.json(
      { success: false, error: { code: status === 409 ? "CONFLICT" : "BAD_REQUEST", message: msg } },
      { status }
    );
  }
}
