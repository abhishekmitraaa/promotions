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
  CI?: string;
}

export type DatabaseTargetClassification =
  | "PRODUCTION"
  | "LOCAL_DISPOSABLE"
  | "CI_DISPOSABLE"
  | "REMOTE_UNKNOWN"
  | "UNSUPPORTED_PROTOCOL"
  | "MALFORMED"
  | "MISSING";

export type GuardEvaluationCode =
  | "ALLOWED_LOCAL_DISPOSABLE"
  | "ALLOWED_CI_DISPOSABLE"
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

interface TargetClassified {
  classification: DatabaseTargetClassification;
  hostname?: string;
  detail?: string;
}

/**
 * Classifies an individual connection string target.
 * Sanitizes all output to ensure credentials and full URLs are never exposed.
 */
export function classifyDatabaseTarget(
  rawUrl: string | undefined,
  isCi: boolean
): TargetClassified {
  if (!rawUrl || typeof rawUrl !== "string" || rawUrl.trim() === "") {
    return { classification: "MISSING", detail: "Target URL is not configured." };
  }

  const trimmed = rawUrl.trim();

  // SQLite / file: targets are unsupported for this PostgreSQL architecture
  if (trimmed.startsWith("file:")) {
    return {
      classification: "UNSUPPORTED_PROTOCOL",
      detail: "file: protocol is unsupported for PostgreSQL database architecture.",
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      classification: "MALFORMED",
      detail: "DATABASE_URL is malformed or cannot be parsed as a valid URL.",
    };
  }

  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    return {
      classification: "UNSUPPORTED_PROTOCOL",
      detail: `Protocol '${parsed.protocol}' is unsupported. Only postgresql: / postgres: are allowed.`,
    };
  }

  const lowerUrl = trimmed.toLowerCase();
  const lowerHost = parsed.hostname.toLowerCase();
  const lowerUser = parsed.username.toLowerCase();
  const lowerPath = parsed.pathname.toLowerCase();

  // Hard production identification: check raw string, host, username, and path
  if (
    lowerUrl.includes(PRODUCTION_SUPABASE_PROJECT_REF) ||
    lowerHost.includes(PRODUCTION_SUPABASE_PROJECT_REF) ||
    lowerUser.includes(PRODUCTION_SUPABASE_PROJECT_REF) ||
    lowerPath.includes(PRODUCTION_SUPABASE_PROJECT_REF)
  ) {
    return {
      classification: "PRODUCTION",
      hostname: parsed.hostname,
      detail: `Matches production Supabase project ref (${PRODUCTION_SUPABASE_PROJECT_REF}).`,
    };
  }

  // CI disposable service identification
  if (isCi && (lowerHost === "postgres" || lowerHost === "db" || lowerHost === "localhost" || lowerHost === "127.0.0.1")) {
    return {
      classification: "CI_DISPOSABLE",
      hostname: parsed.hostname,
      detail: `CI disposable container service (host: ${parsed.hostname}).`,
    };
  }

  // Local disposable identification
  if (LOCAL_HOSTNAMES.has(lowerHost)) {
    return {
      classification: "LOCAL_DISPOSABLE",
      hostname: parsed.hostname,
      detail: `Local disposable database (host: ${parsed.hostname}).`,
    };
  }

  // Any other database is an arbitrary remote target
  return {
    classification: "REMOTE_UNKNOWN",
    hostname: parsed.hostname,
    detail: `Remote database (host: ${parsed.hostname}).`,
  };
}

/**
 * Pure evaluation function for the destructive test safety gate.
 *
 * FAIL-CLOSED SAFETY MODEL:
 * 1. NODE_ENV === "production" => ALWAYS DENY
 * 2. If neither DATABASE_URL nor DIRECT_URL is configured => ALWAYS DENY
 * 3. Both DATABASE_URL and DIRECT_URL are evaluated if present.
 * 4. If either target matches the production Supabase project ref => UNCONDITIONAL HARD BLOCK (no overrides)
 * 5. If either target is malformed or uses an unsupported protocol => ALWAYS DENY
 * 6. If either target is remote/non-local => ALWAYS DENY (remote destructive tests are not supported)
 * 7. Both targets must be positively identified as local/CI disposable AND ALLOW_DESTRUCTIVE_TESTS="true"
 * 8. Never exposes credentials, tokens, or full connection strings in logs or reasons.
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

  const rawDbUrl = env.DATABASE_URL;
  const rawDirectUrl = env.DIRECT_URL;

  // 2. Both missing check
  if ((!rawDbUrl || rawDbUrl.trim() === "") && (!rawDirectUrl || rawDirectUrl.trim() === "")) {
    return {
      allowed: false,
      code: "DENIED_MISSING_DATABASE_URL",
      reason: `DATABASE_URL is not set for test suite '${suiteName}'. Destructive tests require an explicitly configured database target.`,
    };
  }

  const isCi = env.CI === "true";
  const targetsToEvaluate: Array<{ label: string; raw: string }> = [];
  if (rawDbUrl && rawDbUrl.trim() !== "") {
    targetsToEvaluate.push({ label: "DATABASE_URL", raw: rawDbUrl });
  }
  if (rawDirectUrl && rawDirectUrl.trim() !== "") {
    targetsToEvaluate.push({ label: "DIRECT_URL", raw: rawDirectUrl });
  }

  const classifiedTargets = targetsToEvaluate.map((t) => ({
    label: t.label,
    ...classifyDatabaseTarget(t.raw, isCi),
  }));

  // 3. HARD PRODUCTION BLOCK: If ANY configured URL targets production Supabase, reject immediately
  const prodTarget = classifiedTargets.find((t) => t.classification === "PRODUCTION");
  if (prodTarget) {
    return {
      allowed: false,
      code: "DENIED_PRODUCTION_SUPABASE",
      reason: `HARD BLOCK: Refusing to run destructive test suite '${suiteName}' against production Supabase database (${prodTarget.label} matches project ref: ${PRODUCTION_SUPABASE_PROJECT_REF}). This production database is permanently protected against destructive operations and cannot be overridden by ALLOW_DESTRUCTIVE_TESTS, CI=true, or any other flag.`,
    };
  }

  // 4. MALFORMED TARGET CHECK
  const malformedTarget = classifiedTargets.find((t) => t.classification === "MALFORMED");
  if (malformedTarget) {
    return {
      allowed: false,
      code: "DENIED_MALFORMED_URL",
      reason: `Malformed or unparseable ${malformedTarget.label} for test suite '${suiteName}'. Destructive tests are denied by default.`,
    };
  }

  // 5. UNSUPPORTED PROTOCOL CHECK
  const unsupportedTarget = classifiedTargets.find((t) => t.classification === "UNSUPPORTED_PROTOCOL");
  if (unsupportedTarget) {
    return {
      allowed: false,
      code: "DENIED_UNKNOWN_TARGET",
      reason: `Unsupported database target in ${unsupportedTarget.label} for test suite '${suiteName}'. ${unsupportedTarget.detail}`,
    };
  }

  // 6. REMOTE TARGET CHECK: Remote destructive tests are strictly denied
  const remoteTarget = classifiedTargets.find((t) => t.classification === "REMOTE_UNKNOWN");
  if (remoteTarget) {
    return {
      allowed: false,
      code: "DENIED_REMOTE_NOT_DISPOSABLE",
      reason: `Refusing to run destructive test suite '${suiteName}' against remote database (${remoteTarget.label} host: ${remoteTarget.hostname || "unknown"}). Destructive tests against remote databases are denied by default. Only local disposable databases (localhost, 127.0.0.1, Docker/CI service) are supported.`,
    };
  }

  // 7. LOCAL / CI DISPOSABLE CHECK: Must have explicit opt-in
  const allDisposable = classifiedTargets.every(
    (t) => t.classification === "LOCAL_DISPOSABLE" || t.classification === "CI_DISPOSABLE"
  );

  if (!allDisposable) {
    return {
      allowed: false,
      code: "DENIED_UNKNOWN_TARGET",
      reason: `Refusing to run destructive test suite '${suiteName}': database targets could not be positively verified as disposable.`,
    };
  }

  if (env.ALLOW_DESTRUCTIVE_TESTS !== "true") {
    const hostnames = classifiedTargets.map((t) => t.hostname || "unknown").join(", ");
    return {
      allowed: false,
      code: "DENIED_LOCAL_MISSING_OPT_IN",
      reason: `Refusing to run destructive test suite '${suiteName}' against local database (host: ${hostnames}) without explicit confirmation. Set ALLOW_DESTRUCTIVE_TESTS=true to confirm execution on this disposable local database.`,
    };
  }

  const isCiRun = classifiedTargets.some((t) => t.classification === "CI_DISPOSABLE");
  const hostnames = classifiedTargets.map((t) => t.hostname || "localhost").join(", ");
  return {
    allowed: true,
    code: isCiRun ? "ALLOWED_CI_DISPOSABLE" : "ALLOWED_LOCAL_DISPOSABLE",
    reason: `Allowed: Target database (${hostnames}) is a disposable local/CI database with explicit test opt-in.`,
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
