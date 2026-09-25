import { NextRequest, NextResponse } from "next/server";
import { authenticateEmailApi } from "@/lib/email/api-auth-helper";
import { EmailContactService } from "@/lib/services/email-contact-service";
import { EmailContactStatus } from "@prisma/client";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const auth = await authenticateEmailApi(req, { requireAdminForMutations: false });
  if (!auth.authorized || !auth.clientId) return auth.errorResponse!;

  try {
    const contact = await EmailContactService.getContactById(auth.clientId, id);
    if (!contact) {
      return NextResponse.json(
        { success: false, error: { code: "NOT_FOUND", message: `Contact '${id}' not found` } },
        { status: 404 }
      );
    }
    return NextResponse.json({ success: true, data: contact });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error retrieving contact";
    return NextResponse.json(
      { success: false, error: { code: "SERVER_ERROR", message: msg } },
      { status: 500 }
    );
  }
}

export async function PATCH(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  // Mutations strictly require ADMIN
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

  try {
    const updated = await EmailContactService.updateContact(auth.clientId, id, {
      firstName: typeof body.firstName === "string" ? body.firstName : undefined,
      lastName: typeof body.lastName === "string" ? body.lastName : undefined,
      metadata: typeof body.metadata === "object" && body.metadata !== null ? (body.metadata as Record<string, unknown>) : undefined,
      verified: typeof body.verified === "boolean" ? body.verified : undefined,
      hasMarketingConsent: typeof body.hasMarketingConsent === "boolean" ? body.hasMarketingConsent : undefined,
      consentSource: typeof body.consentSource === "string" ? body.consentSource : undefined,
      status: typeof body.status === "string" ? (body.status as EmailContactStatus) : undefined,
    });

    return NextResponse.json({ success: true, data: updated });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to update contact";
    const status = msg.includes("not found") ? 404 : 400;
    return NextResponse.json(
      { success: false, error: { code: status === 404 ? "NOT_FOUND" : "BAD_REQUEST", message: msg } },
      { status }
    );
  }
}

export async function DELETE(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  // Mutations strictly require ADMIN
  const auth = await authenticateEmailApi(req, { requireAdminForMutations: true });
  if (!auth.authorized || !auth.clientId) return auth.errorResponse!;

  try {
    const result = await EmailContactService.deleteContact(auth.clientId, id);
    return NextResponse.json({ success: true, data: result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to delete contact";
    const status = msg.includes("not found") ? 404 : 400;
    return NextResponse.json(
      { success: false, error: { code: status === 404 ? "NOT_FOUND" : "BAD_REQUEST", message: msg } },
      { status }
    );
  }
}
