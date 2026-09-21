import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

/**
 * Safety gate to prevent destructive test suites from accidentally running against
 * a remote or production database.
 */
export function assertDestructiveTestAllowed(suiteName: string): void {
  // 1. Absolute refusal in NODE_ENV=production
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      `\n⛔ [SAFETY GATE TRIGGERED] Refusing to execute destructive test suite '${suiteName}' with NODE_ENV=production.\n`
    );
  }

  const dbUrl = process.env.DATABASE_URL || "";
  if (!dbUrl) {
    throw new Error(
      `\n⛔ [SAFETY GATE TRIGGERED] DATABASE_URL is not set for test suite '${suiteName}'.\n`
    );
  }

  // 2. Local disposable database identification
  const isLocalHost =
    dbUrl.includes("localhost") ||
    dbUrl.includes("127.0.0.1") ||
    dbUrl.includes("host.docker.internal") ||
    dbUrl.startsWith("file:");

  // 3. Remote / production Supabase database fingerprints
  const isRemoteSupabase =
    dbUrl.includes("peqynzeioiauynfpdsdv") ||
    dbUrl.includes(".pooler.supabase.com") ||
    dbUrl.includes(".supabase.co") ||
    dbUrl.includes(".supabase.net");

  // If the target database is remote or has a production fingerprint:
  if (!isLocalHost || isRemoteSupabase) {
    if (process.env.ALLOW_DESTRUCTIVE_TESTS !== "true") {
      const sanitizedUrl = dbUrl.replace(/:[^:@]+@/, ":****@");
      throw new Error(
        `\n⛔ [SAFETY GATE TRIGGERED]\n` +
        `Refusing to run destructive test suite '${suiteName}' against remote database:\n` +
        `  Target DB: ${sanitizedUrl}\n\n` +
        `Destructive integration tests must only run against a local disposable database (e.g. Docker / CI service).\n` +
        `To override for an isolated disposable test database, set ALLOW_DESTRUCTIVE_TESTS=true explicitly.\n` +
        `Do NOT set this flag in production environments!\n`
      );
    }
  }
}
