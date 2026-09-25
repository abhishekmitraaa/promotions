import { NextRequest, NextResponse } from "next/server";
import { authenticateEmailApi } from "@/lib/email/api-auth-helper";
import { EmailListService } from "@/lib/services/email-list-service";
import { EmailSubscriptionStatus } from "@prisma/client";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const auth = await authenticateEmailApi(req, { requireAdminForMutations: false });
  if (!auth.authorized || !auth.clientId) return auth.errorResponse!;

  try {
    const { searchParams } = new URL(req.url);
    const page = parseInt(searchParams.get("page") || "1", 10);
    const limit = parseInt(searchParams.get("limit") || "50", 10);
    const status = (searchParams.get("status") as EmailSubscriptionStatus) || undefined;

    const result = await EmailListService.getListMembers(auth.clientId, id, {
      page,
      limit,
      status,
    });

    return NextResponse.json({ success: true, data: result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error retrieving list members";
    return NextResponse.json(
      { success: false, error: { code: "SERVER_ERROR", message: msg } },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest, { params }: RouteParams) {
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

  if (!body.contactId || typeof body.contactId !== "string") {
    return NextResponse.json(
      { success: false, error: { code: "VALIDATION_ERROR", message: "'contactId' is required" } },
      { status: 400 }
    );
  }

  try {
    const member = await EmailListService.addMember(auth.clientId, id, body.contactId);
    return NextResponse.json({ success: true, data: member }, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to add member to list";
    return NextResponse.json(
      { success: false, error: { code: "BAD_REQUEST", message: msg } },
      { status: 400 }
    );
  }
}

export async function DELETE(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  // Mutations strictly require ADMIN
  const auth = await authenticateEmailApi(req, { requireAdminForMutations: true });
  if (!auth.authorized || !auth.clientId) return auth.errorResponse!;

  const { searchParams } = new URL(req.url);
  const contactId = searchParams.get("contactId");

  if (!contactId) {
    return NextResponse.json(
      { success: false, error: { code: "VALIDATION_ERROR", message: "'contactId' query parameter is required" } },
      { status: 400 }
    );
  }

  try {
    const member = await EmailListService.removeMember(auth.clientId, id, contactId);
    return NextResponse.json({ success: true, data: member });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to remove member from list";
    return NextResponse.json(
      { success: false, error: { code: "BAD_REQUEST", message: msg } },
      { status: 400 }
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
    const addContactIds = Array.isArray(body.addContactIds)
      ? (body.addContactIds as string[])
      : undefined;
    const removeContactIds = Array.isArray(body.removeContactIds)
      ? (body.removeContactIds as string[])
      : undefined;

    const result = await EmailListService.bulkUpdateMembers(auth.clientId, id, {
      addContactIds,
      removeContactIds,
    });

    return NextResponse.json({ success: true, data: result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to bulk update members";
    return NextResponse.json(
      { success: false, error: { code: "BAD_REQUEST", message: msg } },
      { status: 400 }
    );
  }
}
