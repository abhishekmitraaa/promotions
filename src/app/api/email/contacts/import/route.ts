import { NextRequest, NextResponse } from "next/server";
import { authenticateEmailApi } from "@/lib/email/api-auth-helper";
import { EmailContactService, CreateContactInput } from "@/lib/services/email-contact-service";

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

  const contacts = body.contacts;
  if (!Array.isArray(contacts) || contacts.length === 0) {
    return NextResponse.json(
      {
        success: false,
        error: { code: "VALIDATION_ERROR", message: "An array of 'contacts' is required." },
      },
      { status: 400 }
    );
  }

  try {
    const importPayload: CreateContactInput[] = contacts.map((item) => {
      const rec = typeof item === "object" && item !== null ? (item as Record<string, unknown>) : {};
      return {
        email: String(rec.email || ""),
        firstName: typeof rec.firstName === "string" ? rec.firstName : undefined,
        lastName: typeof rec.lastName === "string" ? rec.lastName : undefined,
        metadata: typeof rec.metadata === "object" && rec.metadata !== null ? (rec.metadata as Record<string, unknown>) : undefined,
        verified: typeof rec.verified === "boolean" ? rec.verified : undefined,
        hasMarketingConsent: typeof rec.hasMarketingConsent === "boolean" ? rec.hasMarketingConsent : undefined,
        consentSource: typeof rec.consentSource === "string" ? rec.consentSource : "BULK_IMPORT",
      };
    });

    const result = await EmailContactService.importContacts(auth.clientId, importPayload);

    return NextResponse.json({ success: true, data: result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to import contacts";
    return NextResponse.json(
      { success: false, error: { code: "SERVER_ERROR", message: msg } },
      { status: 500 }
    );
  }
}
