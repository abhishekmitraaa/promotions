/**
 * Comprehensive Verification Suite: Email Provider Architecture
 *
 * Verifies:
 * 1. Provider Registry Invariants: Gmail supported; SES and SMTP explicitly unavailable; MOCK test-only.
 * 2. MOCK Test-Only Protection: MOCK forbidden in production (NODE_ENV === "production").
 * 3. No Silent Fallback Invariants: Specific ID mismatch fails closed; ambiguous multiple configs fail closed.
 * 4. Provider Health Verification: checkHealth() method, latency measurement, error classification, secret redaction.
 * 5. Admin API Endpoints:
 *    - POST /api/admin/email/providers blocks SES and SMTP with PROVIDER_UNAVAILABLE.
 *    - POST /api/admin/email/providers blocks MOCK in production with MOCK_PROVIDER_FORBIDDEN.
 *    - GET & POST /api/admin/email/providers/health executes health checks with RBAC.
 */

process.env.DATABASE_URL = "postgresql://postgres:postgres@127.0.0.1:5433/email_test";
process.env.DIRECT_URL = "postgresql://postgres:postgres@127.0.0.1:5433/email_test";
process.env.REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";
process.env.AUTH_SESSION_SECRET =
  process.env.AUTH_SESSION_SECRET || "default_dev_session_secret_32_chars_minimum_len!!";

import { prisma } from "../src/lib/prisma";
import {
  providerRegistry,
  SUPPORTED_PRODUCTION_PROVIDERS,
  UNAVAILABLE_PROVIDERS,
  ProviderUnavailableError,
  MockProviderForbiddenError,
  ProviderAmbiguityError,
  ProviderNotFoundError,
  isSupportedProviderType,
  isUnavailableProviderType,
  MockEmailProvider,
} from "../src/lib/email/registry";
import { GmailProvider } from "../src/lib/email/providers/gmail/gmail-provider";
import { EmailProviderStatus, EmailProviderType, UserRole } from "@prisma/client";
import { POST as createProviderRoute } from "../src/app/api/admin/email/providers/route";
import { GET as getProviderHealthRoute, POST as postProviderHealthRoute } from "../src/app/api/admin/email/providers/health/route";
import { createSessionToken, hashSessionToken } from "../src/lib/auth";
import { encryptProviderCredential } from "../src/lib/crypto";
import { NextRequest } from "next/server";

const testRunId = `arch_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
let passedCount = 0;
let failedCount = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    passedCount++;
    console.log(`  ✓ PASS: ${message}`);
  } else {
    failedCount++;
    console.error(`  ✗ FAIL: ${message}`);
  }
}

async function createTestAdminAndViewer() {
  const adminUser = await prisma.user.create({
    data: {
      email: `admin_${testRunId}@test.local`,
      passwordHash: "dummy_hash_for_test",
      role: UserRole.ADMIN,
      active: true,
    },
  });

  const viewerUser = await prisma.user.create({
    data: {
      email: `viewer_${testRunId}@test.local`,
      passwordHash: "dummy_hash_for_test",
      role: UserRole.VIEWER,
      active: true,
    },
  });

  const adminSession = createSessionToken({
    id: adminUser.id,
    email: adminUser.email,
    role: UserRole.ADMIN,
  });

  await prisma.userSession.create({
    data: {
      userId: adminUser.id,
      tokenHash: hashSessionToken(adminSession.token),
      expiresAt: new Date(adminSession.expiresAt),
    },
  });

  const viewerSession = createSessionToken({
    id: viewerUser.id,
    email: viewerUser.email,
    role: UserRole.VIEWER,
  });

  await prisma.userSession.create({
    data: {
      userId: viewerUser.id,
      tokenHash: hashSessionToken(viewerSession.token),
      expiresAt: new Date(viewerSession.expiresAt),
    },
  });

  return {
    adminUser,
    viewerUser,
    adminSession,
    viewerSession,
    adminCookie: `whatsapp_hub_session=${adminSession.token}`,
    viewerCookie: `whatsapp_hub_session=${viewerSession.token}`,
  };
}

function makeRequest(
  url: string,
  method: string,
  body?: unknown,
  cookie?: string
): NextRequest {
  const headers = new Headers();
  if (cookie) {
    headers.set("cookie", cookie);
  }
  if (body) {
    headers.set("content-type", "application/json");
  }

  return new NextRequest(new URL(url, "http://localhost:3000"), {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function run() {
  console.log(`\n======================================================`);
  console.log(`  Email Provider Architecture Verification (${testRunId})`);
  console.log(`======================================================\n`);

  const { adminUser, viewerUser, adminCookie, viewerCookie } = await createTestAdminAndViewer();

  const tenant = await prisma.apiClient.create({
    data: {
      name: `Tenant ${testRunId}`,
      active: true,
    },
  });

  // ---------------------------------------------------------------------------
  // [1] PROVIDER REGISTRY & CONSTANTS AUDIT
  // ---------------------------------------------------------------------------
  console.log(`\n--- [1] Provider Registry & Scope Invariants ---`);
  assert(
    SUPPORTED_PRODUCTION_PROVIDERS.includes(EmailProviderType.GMAIL) &&
      SUPPORTED_PRODUCTION_PROVIDERS.length === 1,
    "SUPPORTED_PRODUCTION_PROVIDERS is strictly Gmail-only [GMAIL]"
  );

  assert(
    UNAVAILABLE_PROVIDERS.includes(EmailProviderType.SES) &&
      UNAVAILABLE_PROVIDERS.includes(EmailProviderType.SMTP),
    "UNAVAILABLE_PROVIDERS includes SES and SMTP"
  );

  assert(
    isSupportedProviderType(EmailProviderType.GMAIL) === true,
    "isSupportedProviderType(GMAIL) returns true"
  );

  assert(
    isUnavailableProviderType(EmailProviderType.SES) === true,
    "isUnavailableProviderType(SES) returns true"
  );

  assert(
    isUnavailableProviderType(EmailProviderType.SMTP) === true,
    "isUnavailableProviderType(SMTP) returns true"
  );

  assert(
    providerRegistry.has(EmailProviderType.GMAIL) === true,
    "providerRegistry has GMAIL factory registered"
  );

  let sesErr: unknown;
  try {
    providerRegistry.get(EmailProviderType.SES);
  } catch (err) {
    sesErr = err;
  }
  assert(
    sesErr instanceof ProviderUnavailableError && (sesErr as ProviderUnavailableError).code === "PROVIDER_UNAVAILABLE",
    "providerRegistry.get(SES) throws ProviderUnavailableError"
  );

  let smtpErr: unknown;
  try {
    providerRegistry.get(EmailProviderType.SMTP);
  } catch (err) {
    smtpErr = err;
  }
  assert(
    smtpErr instanceof ProviderUnavailableError && (smtpErr as ProviderUnavailableError).code === "PROVIDER_UNAVAILABLE",
    "providerRegistry.get(SMTP) throws ProviderUnavailableError"
  );

  let registerSesErr: unknown;
  try {
    providerRegistry.register(EmailProviderType.SES, () => ({} as any));
  } catch (err) {
    registerSesErr = err;
  }
  assert(
    registerSesErr instanceof ProviderUnavailableError,
    "providerRegistry.register(SES) throws ProviderUnavailableError"
  );

  // ---------------------------------------------------------------------------
  // [2] MOCK PROVIDER TEST-ONLY INVARIANTS
  // ---------------------------------------------------------------------------
  console.log(`\n--- [2] MOCK Provider Test-Only Invariants ---`);
  const mockProvider = providerRegistry.get(EmailProviderType.MOCK);
  assert(
    mockProvider instanceof MockEmailProvider,
    "In test environment (non-production), providerRegistry provides MockEmailProvider"
  );

  const mockSendResult = await mockProvider.send({
    clientId: tenant.id,
    type: "TRANSACTIONAL" as any,
    to: "test@example.com",
    subject: "Test Mock",
  });
  assert(
    mockSendResult.accepted === true && mockSendResult.providerName === "Mock Email Provider",
    "Mock provider send returns successful result with messageId"
  );

  const mockHealth = await mockProvider.checkHealth!();
  assert(
    mockHealth.healthy === true && mockHealth.latencyMs !== undefined,
    "Mock provider checkHealth returns healthy: true with latencyMs"
  );

  // Simulate production environment
  const originalEnv = process.env.NODE_ENV;
  try {
    (process.env as any).NODE_ENV = "production";

    let prodMockGetErr: unknown;
    try {
      providerRegistry.get(EmailProviderType.MOCK);
    } catch (err) {
      prodMockGetErr = err;
    }
    assert(
      prodMockGetErr instanceof MockProviderForbiddenError &&
        (prodMockGetErr as MockProviderForbiddenError).code === "MOCK_PROVIDER_FORBIDDEN",
      "In production (NODE_ENV=production), providerRegistry.get(MOCK) throws MockProviderForbiddenError"
    );

    let prodMockRegErr: unknown;
    try {
      providerRegistry.register(EmailProviderType.MOCK, () => ({} as any));
    } catch (err) {
      prodMockRegErr = err;
    }
    assert(
      prodMockRegErr instanceof MockProviderForbiddenError,
      "In production (NODE_ENV=production), providerRegistry.register(MOCK) throws MockProviderForbiddenError"
    );
  } finally {
    (process.env as any).NODE_ENV = originalEnv;
  }

  // ---------------------------------------------------------------------------
  // [3] NO SILENT FALLBACK INVARIANTS
  // ---------------------------------------------------------------------------
  console.log(`\n--- [3] No Silent Fallback Invariants ---`);

  // 3a. Tenant with no providers
  let noProvErr: unknown;
  try {
    await providerRegistry.resolveForTenant(tenant.id);
  } catch (err) {
    noProvErr = err;
  }
  assert(
    noProvErr instanceof ProviderNotFoundError && (noProvErr as ProviderNotFoundError).code === "PROVIDER_NOT_FOUND",
    "resolveForTenant throws ProviderNotFoundError when tenant has 0 providers"
  );

  // 3b. Request non-existent or inactive providerConfigId
  let idMismatchErr: unknown;
  try {
    await providerRegistry.resolveForTenant(tenant.id, "non_existent_provider_id");
  } catch (err) {
    idMismatchErr = err;
  }
  assert(
    idMismatchErr instanceof ProviderNotFoundError &&
      (idMismatchErr as Error).message.includes("Silent fallback across providers is prohibited"),
    "resolveForTenant with invalid providerConfigId throws without falling back to other providers"
  );

  // 3c. Create single provider without isDefault: true
  const credsA = { clientId: "g_client_a", clientSecret: "g_secret_a", refreshToken: "g_refresh_a" };
  const provA = await prisma.emailProviderConfig.create({
    data: {
      clientId: tenant.id,
      name: "Gmail Provider Single",
      providerType: EmailProviderType.GMAIL,
      status: EmailProviderStatus.ACTIVE,
      isDefault: false,
      senderEmail: "single@domain.test",
      encryptedCredentials: encryptProviderCredential(JSON.stringify(credsA)),
    },
  });

  const resolvedSingle = await providerRegistry.resolveForTenant(tenant.id);
  assert(
    resolvedSingle.configId === provA.id && resolvedSingle.senderEmail === "single@domain.test",
    "When exactly 1 active provider exists without isDefault, resolves that single provider cleanly"
  );

  // 3d. Create second active provider without isDefault: true -> AMBIGUITY! Prohibit silent fallback.
  const credsB = { clientId: "g_client_b", clientSecret: "g_secret_b", refreshToken: "g_refresh_b" };
  const provB = await prisma.emailProviderConfig.create({
    data: {
      clientId: tenant.id,
      name: "Gmail Provider Secondary",
      providerType: EmailProviderType.GMAIL,
      status: EmailProviderStatus.ACTIVE,
      isDefault: false,
      senderEmail: "second@domain.test",
      encryptedCredentials: encryptProviderCredential(JSON.stringify(credsB)),
    },
  });

  let ambiguityErr: unknown;
  try {
    await providerRegistry.resolveForTenant(tenant.id);
  } catch (err) {
    ambiguityErr = err;
  }
  assert(
    ambiguityErr instanceof ProviderAmbiguityError &&
      (ambiguityErr as ProviderAmbiguityError).code === "PROVIDER_AMBIGUOUS",
    "When multiple active providers exist with no default, resolveForTenant throws ProviderAmbiguityError (no silent fallback)"
  );

  // 3e. Set isDefault on provB -> resolves default cleanly
  await prisma.emailProviderConfig.update({
    where: { id: provB.id },
    data: { isDefault: true },
  });

  const resolvedDefault = await providerRegistry.resolveForTenant(tenant.id);
  assert(
    resolvedDefault.configId === provB.id && resolvedDefault.senderEmail === "second@domain.test",
    "When isDefault is set, resolveForTenant resolves the designated default provider"
  );

  // 3f. Request provA explicitly by providerConfigId -> resolves provA exactly, not default
  const resolvedExplicit = await providerRegistry.resolveForTenant(tenant.id, provA.id);
  assert(
    resolvedExplicit.configId === provA.id && resolvedExplicit.senderEmail === "single@domain.test",
    "When providerConfigId is specified, resolves that exact provider configuration"
  );

  // ---------------------------------------------------------------------------
  // [4] PROVIDER HEALTH VERIFICATION
  // ---------------------------------------------------------------------------
  console.log(`\n--- [4] Provider Health Verification ---`);

  // 4a. GmailProvider with missing credentials
  const emptyGmail = new GmailProvider();
  const emptyHealth = await emptyGmail.checkHealth();
  assert(
    emptyHealth.healthy === false && emptyHealth.error?.includes("Missing required Gmail credentials"),
    "GmailProvider.checkHealth() detects missing credentials and returns healthy: false"
  );

  // 4b. GmailProvider with mock fetch returning valid token
  const validFetch: typeof fetch = async (url) => {
    if (url.toString().includes("oauth2.googleapis.com/token")) {
      return new Response(JSON.stringify({ access_token: "ya29.test_valid_access_token", expires_in: 3600 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(null, { status: 404 });
  };

  const healthyGmail = new GmailProvider({
    credentials: {
      clientId: "test_client_id",
      clientSecret: "test_client_secret_super_secret",
      refreshToken: "test_refresh_token_very_secret",
      senderEmail: "verified@company.test",
    },
    fetchFn: validFetch,
  });

  const healthyRes = await healthyGmail.checkHealth();
  assert(
    healthyRes.healthy === true &&
      healthyRes.latencyMs !== undefined &&
      healthyRes.message?.includes("Google Workspace / Gmail OAuth connection verified"),
    "GmailProvider.checkHealth() verifies token exchange with latency measurement"
  );

  // 4c. GmailProvider with mock fetch returning 401 error and secret redaction
  const failingFetch: typeof fetch = async (url) => {
    if (url.toString().includes("oauth2.googleapis.com/token")) {
      return new Response(
        JSON.stringify({
          error: "invalid_grant",
          error_description: "Bad client secret test_client_secret_super_secret or token test_refresh_token_very_secret",
        }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response(null, { status: 500 });
  };

  const failingGmail = new GmailProvider({
    credentials: {
      clientId: "test_client_id",
      clientSecret: "test_client_secret_super_secret",
      refreshToken: "test_refresh_token_very_secret",
    },
    fetchFn: failingFetch,
  });

  const failingHealth = await failingGmail.checkHealth();
  assert(
    failingHealth.healthy === false &&
      !failingHealth.error?.includes("test_client_secret_super_secret") &&
      !failingHealth.error?.includes("test_refresh_token_very_secret") &&
      failingHealth.error?.includes("[REDACTED_CLIENT_SECRET]"),
    "GmailProvider.checkHealth() redacts clientSecret and refreshToken from error messages"
  );

  // ---------------------------------------------------------------------------
  // [5] ADMIN API ROUTES (REJECTION OF UNAVAILABLE PROVIDERS & HEALTH CHECKS)
  // ---------------------------------------------------------------------------
  console.log(`\n--- [5] Admin API Routes Invariants ---`);

  // 5a. POST /api/admin/email/providers with SES -> rejected with 400 PROVIDER_UNAVAILABLE
  const sesPostReq = makeRequest("/api/admin/email/providers", "POST", {
    clientId: tenant.id,
    name: "AWS SES Provider",
    providerType: "SES",
  }, adminCookie);

  const sesPostRes = await createProviderRoute(sesPostReq);
  const sesPostJson = await sesPostRes.json();
  assert(
    sesPostRes.status === 400 && sesPostJson.code === "PROVIDER_UNAVAILABLE",
    "POST /api/admin/email/providers with SES returns HTTP 400 PROVIDER_UNAVAILABLE"
  );

  // 5b. POST /api/admin/email/providers with SMTP -> rejected with 400 PROVIDER_UNAVAILABLE
  const smtpPostReq = makeRequest("/api/admin/email/providers", "POST", {
    clientId: tenant.id,
    name: "Custom SMTP Provider",
    providerType: "SMTP",
  }, adminCookie);

  const smtpPostRes = await createProviderRoute(smtpPostReq);
  const smtpPostJson = await smtpPostRes.json();
  assert(
    smtpPostRes.status === 400 && smtpPostJson.code === "PROVIDER_UNAVAILABLE",
    "POST /api/admin/email/providers with SMTP returns HTTP 400 PROVIDER_UNAVAILABLE"
  );

  // 5c. POST /api/admin/email/providers with MOCK in production -> rejected with 400 MOCK_PROVIDER_FORBIDDEN
  try {
    (process.env as any).NODE_ENV = "production";
    const mockPostReq = makeRequest("/api/admin/email/providers", "POST", {
      clientId: tenant.id,
      name: "Mock In Production",
      providerType: "MOCK",
    }, adminCookie);

    const mockPostRes = await createProviderRoute(mockPostReq);
    const mockPostJson = await mockPostRes.json();
    assert(
      mockPostRes.status === 400 && mockPostJson.code === "MOCK_PROVIDER_FORBIDDEN",
      "POST /api/admin/email/providers with MOCK in production returns HTTP 400 MOCK_PROVIDER_FORBIDDEN"
    );
  } finally {
    (process.env as any).NODE_ENV = originalEnv;
  }

  // 5d. GET /api/admin/email/providers/health RBAC check
  const unauthHealthReq = makeRequest("/api/admin/email/providers/health", "GET");
  const unauthHealthRes = await getProviderHealthRoute(unauthHealthReq);
  assert(
    unauthHealthRes.status === 401,
    "GET /api/admin/email/providers/health unauthenticated returns HTTP 401"
  );

  const viewerHealthReq = makeRequest("/api/admin/email/providers/health", "GET", undefined, viewerCookie);
  const viewerHealthRes = await getProviderHealthRoute(viewerHealthReq);
  assert(
    viewerHealthRes.status === 403,
    "GET /api/admin/email/providers/health with VIEWER role returns HTTP 403"
  );

  // 5e. GET /api/admin/email/providers/health?id=... with ADMIN
  const adminHealthReq = makeRequest(`/api/admin/email/providers/health?id=${provB.id}`, "GET", undefined, adminCookie);
  const adminHealthRes = await getProviderHealthRoute(adminHealthReq);
  const adminHealthJson = await adminHealthRes.json();
  assert(
    adminHealthRes.status === 200 && adminHealthJson.success === true && adminHealthJson.data.id === provB.id,
    "GET /api/admin/email/providers/health with ADMIN returns health result for provider"
  );

  // Verify DB record updated
  const updatedProvB = await prisma.emailProviderConfig.findUnique({ where: { id: provB.id } });
  assert(
    Boolean(updatedProvB?.lastVerifiedAt || updatedProvB?.errorMessage),
    "Health verification persisted verification status or error in database"
  );

  // 5f. POST /api/admin/email/providers/health with body
  const postHealthReq = makeRequest("/api/admin/email/providers/health", "POST", { id: provA.id }, adminCookie);
  const postHealthRes = await postProviderHealthRoute(postHealthReq);
  const postHealthJson = await postHealthRes.json();
  assert(
    postHealthRes.status === 200 && postHealthJson.data.id === provA.id,
    "POST /api/admin/email/providers/health executes verification via POST body"
  );

  // ---------------------------------------------------------------------------
  // CLEANUP
  // ---------------------------------------------------------------------------
  await prisma.emailProviderConfig.deleteMany({ where: { clientId: tenant.id } });
  await prisma.apiClient.delete({ where: { id: tenant.id } });
  await prisma.userSession.deleteMany({ where: { userId: { in: [adminUser.id, viewerUser.id] } } });
  await prisma.user.deleteMany({ where: { id: { in: [adminUser.id, viewerUser.id] } } });

  console.log(`\n======================================================`);
  console.log(`  Verification Summary: ${passedCount} PASSED, ${failedCount} FAILED`);
  console.log(`======================================================\n`);

  if (failedCount > 0) {
    process.exit(1);
  }
}

run().catch((err) => {
  console.error("Fatal error during provider architecture verification:", err);
  process.exit(1);
});
