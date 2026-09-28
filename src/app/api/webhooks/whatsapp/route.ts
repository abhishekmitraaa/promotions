import { NextRequest, NextResponse } from "next/server";
import { WebhookService } from "@/lib/services/webhook-service";
import { WebhookPayload } from "@/lib/whatsapp/types";
import { checkRateLimit, getClientIp, rateLimitResponse } from "@/lib/rate-limit";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);

  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");

  const verification = WebhookService.verifyChallenge(mode, token, challenge);

  if (!verification.success) {
    return new NextResponse(verification.message || "Forbidden", {
      status: verification.status,
    });
  }

  return new NextResponse(verification.challenge, {
    status: 200,
    headers: { "Content-Type": "text/plain" },
  });
}

export async function POST(req: NextRequest) {
  const clientIp = getClientIp(req);
  const rl = await checkRateLimit(`rl:webhook:whatsapp:${clientIp}`, 1200, 60000, {
    criticality: "LOW",
    failClosed: false,
  });
  if (!rl.success) {
    return rateLimitResponse(rl, "WhatsApp webhook rate limit exceeded.");
  }

  let rawBody = "";
  try {
    rawBody = await req.text();
  } catch {
    return NextResponse.json(
      { error: "Failed to read raw request body" },
      { status: 400 }
    );
  }

  const signatureHeader = req.headers.get("x-hub-signature-256");

  const isValidSignature = WebhookService.validateSignature(rawBody, signatureHeader);
  if (!isValidSignature) {
    return NextResponse.json(
      { error: "Invalid X-Hub-Signature-256 signature" },
      { status: 401 }
    );
  }

  let payload: WebhookPayload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json(
      { error: "Malformed JSON payload" },
      { status: 400 }
    );
  }

  try {
    await WebhookService.processPayload(payload);
  } catch (err: unknown) {
    console.error("Unhandled error processing Meta webhook payload:", err);
  }

  return NextResponse.json({ status: "EVENT_RECEIVED" }, { status: 200 });
}
