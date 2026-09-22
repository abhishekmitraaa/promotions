/**
 * Timing-safe string comparison using Web Crypto SHA-256 digests.
 *
 * Compatible with Edge Runtime (middleware), Node.js, and browser environments.
 * By hashing both inputs to 32-byte SHA-256 digests first:
 * 1. Constant-time byte-by-byte comparison is performed on fixed 32-byte arrays.
 * 2. Secret length is NEVER leaked via execution time.
 * 3. Individual character equality is NEVER leaked via early termination.
 */
export async function timingSafeEqualSecret(
  provided: string | null | undefined,
  expectedSecret: string | null | undefined
): Promise<boolean> {
  if (
    !provided ||
    !expectedSecret ||
    typeof provided !== "string" ||
    typeof expectedSecret !== "string"
  ) {
    return false;
  }

  const encoder = new TextEncoder();
  const [digestA, digestB] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expectedSecret)),
  ]);

  const bufA = new Uint8Array(digestA);
  const bufB = new Uint8Array(digestB);

  let mismatch = 0;
  for (let i = 0; i < 32; i++) {
    mismatch |= bufA[i] ^ bufB[i];
  }

  return mismatch === 0;
}
