import { NextRequest, NextResponse } from "next/server";
import { authenticateEmailApi } from "@/lib/email/api-auth-helper";
import { EmailListService } from "@/lib/services/email-list-service";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const auth = await authenticateEmailApi(req, { requireAdminForMutations: false });
  if (!auth.authorized || !auth.clientId) return auth.errorResponse!;

  try {
    const list = await EmailListService.getListById(auth.clientId, id);
    if (!list) {
      return NextResponse.json(
        { success: false, error: { code: "NOT_FOUND", message: `List '${id}' not found` } },
        { status: 404 }
      );
    }
    return NextResponse.json({ success: true, data: list });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error retrieving list";
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
    const updated = await EmailListService.updateList(auth.clientId, id, {
      name: typeof body.name === "string" ? body.name : undefined,
      description: typeof body.description === "string" ? body.description : undefined,
      active: typeof body.active === "boolean" ? body.active : undefined,
    });

    return NextResponse.json({ success: true, data: updated });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to update list";
    const status = msg.includes("not found") ? 404 : msg.includes("already taken") ? 409 : 400;
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
    const result = await EmailListService.deleteList(auth.clientId, id);
    return NextResponse.json({ success: true, data: result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to delete list";
    const status = msg.includes("not found") ? 404 : 400;
    return NextResponse.json(
      { success: false, error: { code: status === 404 ? "NOT_FOUND" : "BAD_REQUEST", message: msg } },
      { status }
    );
  }
}
