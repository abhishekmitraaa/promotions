import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

/**
 * Hardcoded reference for the production Supabase project.
 * Destructive tests targeting this project must be rejected unconditionally,
 * regardless of any environment variables, CI flags, or overrides.
 */
export const PRODUCTION_SUPABASE_PROJECT_REF = "peqynzeioiauynfpdsdv";

export interface GuardEnv {
  NODE_ENV?: string;
  DATABASE_URL?: string;
  DIRECT_URL?: string;
  ALLOW_DESTRUCTIVE_TESTS?: string;
  ALLOW_REMOTE_DISPOSABLE_TEST_DB?: string;
  CI?: string;
}

export type GuardEvaluationCode =
  | "ALLOWED_LOCAL_DISPOSABLE"
  | "ALLOWED_CI_DISPOSABLE"
  | "ALLOWED_REMOTE_DISPOSABLE"
  | "ALLOWED_SQLITE_FILE"
  | "DENIED_PRODUCTION_NODE_ENV"
  | "DENIED_MISSING_DATABASE_URL"
  | "DENIED_MALFORMED_URL"
  | "DENIED_PRODUCTION_SUPABASE"
  | "DENIED_LOCAL_MISSING_OPT_IN"
  | "DENIED_REMOTE_NOT_DISPOSABLE"
  | "DENIED_UNKNOWN_TARGET";

export interface GuardEvaluationResult {
  allowed: boolean;
  code: GuardEvaluationCode;
  reason: string;
}

const LOCAL_HOSTNAMES = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
  "host.docker.internal",
]);

/**
 * Pure evaluation function for the destructive test safety gate.
 * Can evaluate the live process.env or an explicitly supplied environment override.
 *
 * SAFETY RULES:
 * 1. NODE_ENV === "production" => ALWAYS DENY
 * 2. DATABASE_URL contains production Supabase project ref => ALWAYS DENY (No override possible)
 * 3. Local disposable DB (localhost, 127.0.0.1, ::1, host.docker.internal, or CI container host) =>
 *    ALLOW only with explicit opt-in (ALLOW_DESTRUCTIVE_TESTS="true")
 * 4. SQLite file: target => ALLOW only with explicit opt-in (ALLOW_DESTRUCTIVE_TESTS="true")
 * 5. Arbitrary remote DB => DENIED BY DEFAULT even with ALLOW_DESTRUCTIVE_TESTS="true".
 *    To target a confirmed disposable remote test database, BOTH ALLOW_DESTRUCTIVE_TESTS="true"
 *    AND ALLOW_REMOTE_DISPOSABLE_TEST_DB="true" are strictly required (and must not be production).
 * 6. Malformed, unparseable, or missing DATABASE_URL => ALWAYS DENY
 * 7. Logs and errors NEVER print database passwords, credentials, or full connection strings.
 */
export function evaluateDestructiveTestAllowed(
  suiteName: string,
  envOverride?: GuardEnv
): GuardEvaluationResult {
  const env: GuardEnv = envOverride || process.env;

  // 1. Hard refusal in NODE_ENV=production
  if (env.NODE_ENV === "production") {
    return {
      allowed: false,
      code: "DENIED_PRODUCTION_NODE_ENV",
      reason: `Refusing to execute destructive test suite '${suiteName}' with NODE_ENV=production.`,
    };
  }

  // 2. Database URL extraction
  const rawDbUrl = env.DATABASE_URL || env.DIRECT_URL || "";
  if (!rawDbUrl || typeof rawDbUrl !== "string" || rawDbUrl.trim() === "") {
    return {
      allowed: false,
      code: "DENIED_MISSING_DATABASE_URL",
      reason: `DATABASE_URL is not set for test suite '${suiteName}'. Destructive tests require an explicitly configured database target.`,
    };
  }

  const trimmed = rawDbUrl.trim();

  // 3. SQLite file: target
  if (trimmed.startsWith("file:")) {
    if (env.ALLOW_DESTRUCTIVE_TESTS !== "true") {
      return {
        allowed: false,
        code: "DENIED_LOCAL_MISSING_OPT_IN",
        reason: `Destructive test suite '${suiteName}' targeting SQLite file database requires explicit opt-in. Set ALLOW_DESTRUCTIVE_TESTS=true.`,
      };
    }
    return {
      allowed: true,
      code: "ALLOWED_SQLITE_FILE",
      reason: `Allowed: Target is a local SQLite file database with explicit test opt-in.`,
    };
  }

  // 4. URL parsing & protocol verification
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(trimmed);
  } catch {
    return {
      allowed: false,
      code: "DENIED_MALFORMED_URL",
      reason: `Malformed or unparseable DATABASE_URL for test suite '${suiteName}'. Destructive tests are denied by default.`,
    };
  }

  if (parsedUrl.protocol !== "postgresql:" && parsedUrl.protocol !== "postgres:") {
    return {
      allowed: false,
      code: "DENIED_UNKNOWN_TARGET",
      reason: `Unsupported database protocol '${parsedUrl.protocol}' for test suite '${suiteName}'. Destructive tests are denied.`,
    };
  }

  // 5. HARD PRODUCTION BLOCK (Unconditional Deny)
  // Check raw string, hostname, username, and path for production Supabase project ref
  const lowerUrl = trimmed.toLowerCase();
  const lowerHost = parsedUrl.hostname.toLowerCase();
  const lowerUser = parsedUrl.username.toLowerCase();
  const lowerPath = parsedUrl.pathname.toLowerCase();

  const isProductionSupabase =
    lowerUrl.includes(PRODUCTION_SUPABASE_PROJECT_REF) ||
    lowerHost.includes(PRODUCTION_SUPABASE_PROJECT_REF) ||
    lowerUser.includes(PRODUCTION_SUPABASE_PROJECT_REF) ||
    lowerPath.includes(PRODUCTION_SUPABASE_PROJECT_REF);

  if (isProductionSupabase) {
    return {
      allowed: false,
      code: "DENIED_PRODUCTION_SUPABASE",
      reason: `HARD BLOCK: Refusing to run destructive test suite '${suiteName}' against production Supabase database (project ref: ${PRODUCTION_SUPABASE_PROJECT_REF}). This production database is permanently protected against destructive operations and cannot be overridden by ALLOW_DESTRUCTIVE_TESTS, CI=true, ALLOW_REMOTE_DISPOSABLE_TEST_DB, or any other flag.`,
    };
  }

  // 6. Local / CI Disposable Database Identification
  const isLocalHost = LOCAL_HOSTNAMES.has(lowerHost);
  const isCiDockerService =
    env.CI === "true" && (lowerHost === "postgres" || lowerHost === "db");

  if (isLocalHost || isCiDockerService) {
    if (env.ALLOW_DESTRUCTIVE_TESTS !== "true") {
      return {
        allowed: false,
        code: "DENIED_LOCAL_MISSING_OPT_IN",
        reason: `Refusing to run destructive test suite '${suiteName}' against local database (host: ${parsedUrl.hostname}) without explicit confirmation. Set ALLOW_DESTRUCTIVE_TESTS=true to confirm execution on this disposable local database.`,
      };
    }
    return {
      allowed: true,
      code: isCiDockerService ? "ALLOWED_CI_DISPOSABLE" : "ALLOWED_LOCAL_DISPOSABLE",
      reason: `Allowed: Target database (host: ${parsedUrl.hostname}) is a disposable local/CI database with explicit test opt-in.`,
    };
  }

  // 7. Remote Database Handling
  // Destructive operations against remote databases are DENIED by default.
  // ALLOW_DESTRUCTIVE_TESTS=true ALONE is insufficient.
  // Only allowed if BOTH ALLOW_DESTRUCTIVE_TESTS=true AND ALLOW_REMOTE_DISPOSABLE_TEST_DB=true are set.
  if (
    env.ALLOW_REMOTE_DISPOSABLE_TEST_DB === "true" &&
    env.ALLOW_DESTRUCTIVE_TESTS === "true"
  ) {
    return {
      allowed: true,
      code: "ALLOWED_REMOTE_DISPOSABLE",
      reason: `Allowed: Target remote database (host: ${parsedUrl.hostname}) is explicitly confirmed as a disposable test database.`,
    };
  }

  return {
    allowed: false,
    code: "DENIED_REMOTE_NOT_DISPOSABLE",
    reason: `Refusing to run destructive test suite '${suiteName}' against remote database (host: ${parsedUrl.hostname}). Destructive tests against remote databases are denied by default. Local disposable databases (localhost, 127.0.0.1) are the supported path. To explicitly target a confirmed disposable remote test database, both ALLOW_DESTRUCTIVE_TESTS=true and ALLOW_REMOTE_DISPOSABLE_TEST_DB=true must be set.`,
  };
}

/**
 * Asserts that destructive operations are permitted for the specified suite.
 * Throws an Error if not allowed.
 */
export function assertDestructiveTestAllowed(suiteName: string): void {
  const result = evaluateDestructiveTestAllowed(suiteName);
  if (!result.allowed) {
    throw new Error(`\n⛔ [SAFETY GATE TRIGGERED]\n${result.reason}\n`);
  }
}
