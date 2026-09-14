import { signHmacSha256 } from "../crypto";

/**
 * Sign an outgoing webhook JSON payload string with endpoint secret.
 * Returns `sha256=<hex_signature>`.
 */
export function signWebhookPayload(rawPayload: string, secret: string): string {
  const signature = signHmacSha256(rawPayload, secret);
  return `sha256=${signature}`;
}
