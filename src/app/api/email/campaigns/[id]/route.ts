import { NextRequest, NextResponse } from "next/server";
import { authenticateEmailApi } from "@/lib/email/api-auth-helper";
import { EmailCampaignService } from "@/lib/services/email-campaign-service";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
  const auth = await authenticateEmailApi(req, { requireAdminForMutations: false });
  if (!auth.authorized || !auth.clientId) return auth.errorResponse!;

  try {
    const campaign = await EmailCampaignService.getCampaignById(auth.clientId, id);
    if (!campaign) {
      return NextResponse.json(
        { success: false, error: { code: "NOT_FOUND", message: `Campaign '${id}' not found` } },
        { status: 404 }
      );
    }
    return NextResponse.json({ success: true, data: campaign });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error retrieving campaign";
    return NextResponse.json(
      { success: false, error: { code: "SERVER_ERROR", message: msg } },
      { status: 500 }
    );
  }
}

export async function PATCH(req: NextRequest, { params }: RouteParams) {
  const { id } = await params;
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

  try {
    const scheduledAt =
      typeof body.scheduledAt === "string"
        ? new Date(body.scheduledAt)
        : body.scheduledAt === null
        ? null
        : undefined;

    const updated = await EmailCampaignService.updateCampaign(auth.clientId, id, {
      name: typeof body.name === "string" ? body.name : undefined,
      description: typeof body.description === "string" ? body.description : undefined,
      templateVersionId: typeof body.templateVersionId === "string" ? body.templateVersionId : undefined,
      listId: typeof body.listId === "string" ? body.listId : undefined,
      segmentId: typeof body.segmentId === "string" ? body.segmentId : undefined,
      senderIdentityId: typeof body.senderIdentityId === "string" ? body.senderIdentityId : undefined,
      scheduledAt,
    });

    return NextResponse.json({ success: true, data: updated });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to update campaign";
    const status = msg.includes("not found") ? 404 : 400;
    return NextResponse.json(
      { success: false, error: { code: status === 404 ? "NOT_FOUND" : "BAD_REQUEST", message: msg } },
      { status }
    );
  }
}
