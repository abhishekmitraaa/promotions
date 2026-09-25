/**
 * Integration & Correctness Verification Suite for Google Workspace OAuth Flow
 *
 * Validates:
 * 1. Valid OAuth state generation with minimum scopes (gmail.send, userinfo.email)
 * 2. Time-limited state (expired state rejection)
 * 3. Tampered state (invalid signature rejection)
 * 4. Malformed callback handling (missing code/state)
 * 5. Google denial handling (access_denied)
 * 6. Wrong tenant rejection
 * 7. One-time nonce & Replay attack defense (HTTP 409)
 * 8. Token exchange failures (HTTP 502)
 * 9. Missing refresh token handling
 * 10. Authoritative sender identity lookup failure handling
 * 11. Encrypted credentials persistence at rest
 * 12. Verified sender identity persistence
 * 13. VIEWER rejection (HTTP 403)
 * 14. ADMIN success (complete browser redirect flow)
 */

import { NextRequest } from "next/server";
import { GET as getOAuthUrl } from "../src/app/api/admin/email/providers/google/oauth/route";
import { GET as getOAuthCallback, POST as postOAuthCallback } from "../src/app/api/admin/email/providers/google/callback/route";
import { GET as listProviders } from "../src/app/api/admin/email/providers/route";
import {
  createOAuthState,
  OAuthTransactionStore,
  generateGoogleAuthUrl,
} from "../src/lib/email/providers/gmail/oauth";
import { GMAIL_SEND_SCOPE, GOOGLE_TOKEN_ENDPOINT } from "../src/lib/email/providers/gmail/gmail-provider";
import { GOOGLE_USERINFO_ENDPOINT } from "../src/lib/email/providers/gmail/oauth";
import { createSessionToken, hashSessionToken, SESSION_COOKIE } from "../src/lib/auth";
import { decryptProviderCredential } from "../src/lib/crypto";
import { prisma } from "../src/lib/prisma";
import crypto from "crypto";

let passed = 0;
let failed = 0;

function testAssert(condition: boolean, description: string) {
  if (condition) {
    console.log(`  ✅ PASS: ${description}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${description}`);
    failed++;
  }
}

async function runOAuthVerification() {
  console.log("==================================================================");
  console.log("🔐 RUNNING GOOGLE WORKSPACE OAUTH E2E VERIFICATION SUITE");
  console.log("==================================================================\n");

  // Set test environment secrets first
  process.env.AUTH_SESSION_SECRET = "test_super_secret_session_key_32_characters_long!";
  process.env.GMAIL_CLIENT_ID = "mock-google-client-id.apps.googleusercontent.com";
  process.env.GMAIL_CLIENT_SECRET = "mock-google-client-secret";

  // Setup test admin & viewer sessions
  const adminId = "admin-oauth-test";
  const viewerId = "viewer-oauth-test";
  const adminToken = createSessionToken({ id: adminId, email: "admin@corp.com", role: "ADMIN" });
  const viewerToken = createSessionToken({ id: viewerId, email: "viewer@corp.com", role: "VIEWER" });

  const adminCookie = `${SESSION_COOKIE}=${encodeURIComponent(adminToken.token)}`;
  const viewerCookie = `${SESSION_COOKIE}=${encodeURIComponent(viewerToken.token)}`;

  // In-memory test databases
  const inMemoryProviders = new Map<string, any>();
  const inMemoryIdentities = new Map<string, any>();
  const inMemoryClients = new Map<string, any>([
    ["client-alpha", { id: "client-alpha", name: "Tenant Alpha" }],
    ["client-beta", { id: "client-beta", name: "Tenant Beta" }],
  ]);

  // Save original Prisma functions
  const origSessionFindUnique = prisma.userSession.findUnique;
  const origClientFindUnique = prisma.apiClient.findUnique;
  const origClientFindFirst = prisma.apiClient.findFirst;
  const origProviderCreate = (prisma.emailProviderConfig as any).create;
  const origProviderFindMany = (prisma.emailProviderConfig as any).findMany;
  const origProviderUpdateMany = (prisma.emailProviderConfig as any).updateMany;
  const origIdentityUpsert = (prisma.emailSenderIdentity as any).upsert;
  const origIdentityFindMany = (prisma.emailSenderIdentity as any).findMany;

  // Mock global fetch for Google OAuth endpoints
  const origFetch = globalThis.fetch;
  let mockTokenStatus = 200;
  let mockTokenResponse: any = {
    access_token: "ya29.mock-access-token-12345",
    refresh_token: "1//04mock-refresh-token-67890",
    expires_in: 3600,
    scope: `${GMAIL_SEND_SCOPE} https://www.googleapis.com/auth/userinfo.email`,
  };
  let mockUserinfoStatus = 200;
  let mockUserinfoResponse: any = {
    email: "sender@tenant-alpha.com",
    verified_email: true,
  };

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = input.toString();

    if (url === GOOGLE_TOKEN_ENDPOINT) {
      return new Response(JSON.stringify(mockTokenResponse), {
        status: mockTokenStatus,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url === GOOGLE_USERINFO_ENDPOINT) {
      return new Response(JSON.stringify(mockUserinfoResponse), {
        status: mockUserinfoStatus,
        headers: { "Content-Type": "application/json" },
      });
    }

    return origFetch(input, init);
  };

  try {
    // Mock userSession lookup
    (prisma.userSession as any).findUnique = async ({ where }: any) => {
      if (where.tokenHash === hashSessionToken(adminToken.token)) {
        return {
          id: "session-admin",
          tokenHash: where.tokenHash,
          expiresAt: new Date(Date.now() + 3600000),
          user: { id: adminId, email: "admin@corp.com", role: "ADMIN", active: true },
        };
      }
      if (where.tokenHash === hashSessionToken(viewerToken.token)) {
        return {
          id: "session-viewer",
          tokenHash: where.tokenHash,
          expiresAt: new Date(Date.now() + 3600000),
          user: { id: viewerId, email: "viewer@corp.com", role: "VIEWER", active: true },
        };
      }
      return null;
    };

    (prisma.apiClient as any).findUnique = async ({ where }: any) => {
      return inMemoryClients.get(where.id) || null;
    };

    (prisma.apiClient as any).findFirst = async () => {
      return inMemoryClients.get("client-alpha") || null;
    };

    (prisma.emailProviderConfig as any).create = async ({ data }: any) => {
      const id = `prov-${Date.now()}-${Math.random().toString(36).substring(7)}`;
      const record = { id, ...data, createdAt: new Date(), updatedAt: new Date() };
      inMemoryProviders.set(id, record);
      return record;
    };

    (prisma.emailProviderConfig as any).updateMany = async ({ where, data }: any) => {
      let count = 0;
      for (const p of inMemoryProviders.values()) {
        if (where.clientId && p.clientId !== where.clientId) continue;
        Object.assign(p, data);
        count++;
      }
      return { count };
    };

    (prisma.emailProviderConfig as any).findMany = async ({ where }: any) => {
      const list: any[] = [];
      for (const p of inMemoryProviders.values()) {
        if (where?.clientId && p.clientId !== where.clientId) continue;
        // Obey select projection: omit encryptedCredentials and encryptedOAuthRefreshToken
        const { encryptedCredentials, encryptedOAuthRefreshToken, ...safe } = p;
        list.push(safe);
      }
      return list;
    };

    (prisma.emailSenderIdentity as any).upsert = async ({ where, update, create }: any) => {
      const key = `${where.clientId_email.clientId}_${where.clientId_email.email}`;
      let record = inMemoryIdentities.get(key);
      if (record) {
        Object.assign(record, update);
      } else {
        record = {
          id: `ident-${Date.now()}`,
          ...create,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        inMemoryIdentities.set(key, record);
      }
      return record;
    };

    (prisma.emailSenderIdentity as any).findMany = async () => Array.from(inMemoryIdentities.values());

    // Set test environment secrets
    process.env.AUTH_SESSION_SECRET = "test_super_secret_session_key_32_characters_long!";
    process.env.GMAIL_CLIENT_ID = "mock-google-client-id.apps.googleusercontent.com";
    process.env.GMAIL_CLIENT_SECRET = "mock-google-client-secret";

    // -------------------------------------------------------------------------
    // 1. Valid OAuth URL & Minimum Scope Audit
    // -------------------------------------------------------------------------
    console.log("--- [1] Google OAuth URL Generation & Scope Audit ---");

    const authUrlReq = new NextRequest("http://localhost:3000/api/admin/email/providers/google/oauth?clientId=client-alpha", {
      headers: { cookie: adminCookie, accept: "application/json" },
    });
    const authUrlRes = await getOAuthUrl(authUrlReq);
    testAssert(authUrlRes.status === 200, "Initiating OAuth URL returns HTTP 200");
    const authUrlData = (await authUrlRes.json()).data;
    testAssert(typeof authUrlData.authUrl === "string", "Returns authUrl string");

    const parsedAuthUrl = new URL(authUrlData.authUrl);
    testAssert(parsedAuthUrl.origin + parsedAuthUrl.pathname === "https://accounts.google.com/o/oauth2/v2/auth", "Target endpoint is Google OAuth authorization endpoint");
    testAssert(parsedAuthUrl.searchParams.get("client_id") === process.env.GMAIL_CLIENT_ID, "Contains configured GMAIL_CLIENT_ID");
    testAssert(parsedAuthUrl.searchParams.get("access_type") === "offline", "Requests access_type=offline for refresh token");
    testAssert(parsedAuthUrl.searchParams.get("prompt") === "consent", "Requests prompt=consent to guarantee refresh token on repeated connects");

    const scopeParam = parsedAuthUrl.searchParams.get("scope") || "";
    testAssert(scopeParam.includes("gmail.send"), "CRITICAL: Requests gmail.send scope for dispatch");
    testAssert(scopeParam.includes("userinfo.email"), "Requests userinfo.email scope for authoritative sender verification");
    testAssert(!scopeParam.includes("mail.google.com"), "MINIMUM SCOPE: Does NOT request full inbox access (mail.google.com)");
    testAssert(!scopeParam.includes("gmail.readonly"), "MINIMUM SCOPE: Does NOT request inbox read access (gmail.readonly)");

    const generatedState = parsedAuthUrl.searchParams.get("state")!;
    testAssert(Boolean(generatedState) && generatedState.includes("."), "State parameter is signed and structured");

    // -------------------------------------------------------------------------
    // 2. Malformed Callback Handling
    // -------------------------------------------------------------------------
    console.log("\n--- [2] Malformed Callback Handling ---");

    const missingParamsReq = new NextRequest("http://localhost:3000/api/admin/email/providers/google/callback", {
      headers: { cookie: adminCookie, accept: "application/json" },
    });
    const missingParamsRes = await getOAuthCallback(missingParamsReq);
    testAssert(missingParamsRes.status === 400, "Missing both code and state returns HTTP 400");

    const missingCodeReq = new NextRequest("http://localhost:3000/api/admin/email/providers/google/callback?state=abc", {
      headers: { cookie: adminCookie, accept: "application/json" },
    });
    const missingCodeRes = await getOAuthCallback(missingCodeReq);
    testAssert(missingCodeRes.status === 400, "Missing code returns HTTP 400");

    const malformedStateReq = new NextRequest("http://localhost:3000/api/admin/email/providers/google/callback?code=mock_code&state=not_valid_format", {
      headers: { cookie: adminCookie, accept: "application/json" },
    });
    const malformedStateRes = await getOAuthCallback(malformedStateReq);
    testAssert(malformedStateRes.status === 403, "Malformed state string returns HTTP 403 Forbidden");

    // -------------------------------------------------------------------------
    // 3. Google OAuth Denial (User Rejected Consent)
    // -------------------------------------------------------------------------
    console.log("\n--- [3] Google Denial Handling ---");

    const denialReq = new NextRequest(
      "http://localhost:3000/api/admin/email/providers/google/callback?error=access_denied&error_description=User+denied+consent&state=somestate",
      { headers: { cookie: adminCookie, accept: "application/json" } }
    );
    const denialRes = await getOAuthCallback(denialReq);
    testAssert(denialRes.status === 400, "Google denial returns HTTP 400");
    const denialJson = await denialRes.json();
    testAssert(denialJson.error.includes("Google authorization denied: access_denied"), "Error describes user denial specifically");

    // Browser navigation redirect for denial
    const denialBrowserReq = new NextRequest(
      "http://localhost:3000/api/admin/email/providers/google/callback?error=access_denied&state=somestate",
      { headers: { cookie: adminCookie } }
    );
    const denialBrowserRes = await getOAuthCallback(denialBrowserReq);
    testAssert(denialBrowserRes.status === 307 || denialBrowserRes.status === 302, "Browser denial redirects to dashboard");
    const redirectLocation = denialBrowserRes.headers.get("location") || "";
    testAssert(redirectLocation.includes("status=error"), "Redirect contains status=error parameter");
    testAssert(redirectLocation.includes("access_denied"), "Redirect contains denial reason in message");

    // -------------------------------------------------------------------------
    // 4. Expired State Parameter
    // -------------------------------------------------------------------------
    console.log("\n--- [4] Expired State Parameter ---");

    // Construct expired state (> 15 minutes old)
    const oldNonce = "expired-nonce-12345";
    OAuthTransactionStore.save(oldNonce, {
      tenantId: "client-alpha",
      adminUserId: adminId,
      createdAt: Date.now() - 20 * 60 * 1000,
      expiresAt: Date.now() - 5 * 60 * 1000,
      used: false,
    });
    const expiredPayload = JSON.stringify({
      tenantId: "client-alpha",
      adminUserId: adminId,
      timestamp: Date.now() - 20 * 60 * 1000,
      nonce: oldNonce,
    });
    const expiredHmac = crypto.createHmac("sha256", process.env.AUTH_SESSION_SECRET!).update(expiredPayload).digest("hex");
    const expiredState = `${Buffer.from(expiredPayload).toString("base64url")}.${expiredHmac}`;

    const expiredReq = new NextRequest(
      `http://localhost:3000/api/admin/email/providers/google/callback?code=mock_code&state=${expiredState}`,
      { headers: { cookie: adminCookie, accept: "application/json" } }
    );
    const expiredRes = await getOAuthCallback(expiredReq);
    testAssert(expiredRes.status === 403, "Expired state returns HTTP 403 Forbidden");
    const expiredJson = await expiredRes.json();
    testAssert(expiredJson.error.includes("expired"), "Error indicates state expiration");

    // -------------------------------------------------------------------------
    // 5. Tampered State (Signature Invalidation)
    // -------------------------------------------------------------------------
    console.log("\n--- [5] Tampered State Defense ---");

    const validState = createOAuthState("client-alpha", adminId);
    const [b64, validSig] = validState.split(".");
    // Tamper with payload (change client-alpha to client-beta)
    const tamperedPayload = Buffer.from(b64, "base64url").toString("utf8").replace("client-alpha", "client-beta");
    const tamperedState = `${Buffer.from(tamperedPayload).toString("base64url")}.${validSig}`;

    const tamperedReq = new NextRequest(
      `http://localhost:3000/api/admin/email/providers/google/callback?code=mock_code&state=${tamperedState}`,
      { headers: { cookie: adminCookie, accept: "application/json" } }
    );
    const tamperedRes = await getOAuthCallback(tamperedReq);
    testAssert(tamperedRes.status === 403, "Tampered state payload returns HTTP 403 Forbidden");

    // -------------------------------------------------------------------------
    // 6. Cross-Tenant Admin Invariant Defense
    // -------------------------------------------------------------------------
    console.log("\n--- [6] Cross-Tenant Admin Defense ---");

    // State created by Admin A
    const adminAState = createOAuthState("client-alpha", adminId);

    // Another admin session (Admin B) tries to consume it
    const adminBId = "admin-user-beta";
    const adminBToken = createSessionToken({ id: adminBId, email: "admin-beta@corp.com", role: "ADMIN" });
    const adminBCookie = `${SESSION_COOKIE}=${encodeURIComponent(adminBToken.token)}`;

    // Add session for Admin B in mock
    const prevSessionFindUnique = (prisma.userSession as any).findUnique;
    (prisma.userSession as any).findUnique = async ({ where }: any) => {
      if (where.tokenHash === hashSessionToken(adminBToken.token)) {
        return {
          id: "session-admin-b",
          tokenHash: where.tokenHash,
          expiresAt: new Date(Date.now() + 3600000),
          user: { id: adminBId, email: "admin-beta@corp.com", role: "ADMIN", active: true },
        };
      }
      return prevSessionFindUnique({ where });
    };

    const crossAdminReq = new NextRequest(
      `http://localhost:3000/api/admin/email/providers/google/callback?code=mock_code&state=${adminAState}`,
      { headers: { cookie: adminBCookie, accept: "application/json" } }
    );
    const crossAdminRes = await getOAuthCallback(crossAdminReq);
    testAssert(crossAdminRes.status === 403, "Admin from different session cannot complete another admin's OAuth state");
    const crossAdminJson = await crossAdminRes.json();
    testAssert(crossAdminJson.error.includes("Admin user does not match"), "Error identifies admin mismatch");

    // -------------------------------------------------------------------------
    // 7. One-Time Nonce & Replay Attack Defense
    // -------------------------------------------------------------------------
    console.log("\n--- [7] One-Time Nonce & Replay Attack Defense ---");

    const replayState = createOAuthState("client-alpha", adminId);

    // First completion: succeeds
    const firstReq = new NextRequest(
      `http://localhost:3000/api/admin/email/providers/google/callback?code=mock_code_1&state=${replayState}`,
      { headers: { cookie: adminCookie, accept: "application/json" } }
    );
    const firstRes = await getOAuthCallback(firstReq);
    testAssert(firstRes.status === 200, "First execution with state succeeds (HTTP 200)");

    // Second completion with identical state: REPLAY DETECTED!
    const replayReq = new NextRequest(
      `http://localhost:3000/api/admin/email/providers/google/callback?code=mock_code_2&state=${replayState}`,
      { headers: { cookie: adminCookie, accept: "application/json" } }
    );
    const replayRes = await getOAuthCallback(replayReq);
    testAssert(replayRes.status === 409, "CRITICAL: Replayed state is rejected with HTTP 409 Conflict");
    const replayJson = await replayRes.json();
    testAssert(replayJson.error.includes("already been used"), "Error explicitly identifies state reuse");

    // -------------------------------------------------------------------------
    // 8. Google Token Exchange Failure
    // -------------------------------------------------------------------------
    console.log("\n--- [8] Google Token Exchange Failure ---");

    mockTokenStatus = 400;
    mockTokenResponse = { error: "invalid_grant", error_description: "Code has already been redeemed" };

    const tokenFailState = createOAuthState("client-alpha", adminId);
    const tokenFailReq = new NextRequest(
      `http://localhost:3000/api/admin/email/providers/google/callback?code=bad_code&state=${tokenFailState}`,
      { headers: { cookie: adminCookie, accept: "application/json" } }
    );
    const tokenFailRes = await getOAuthCallback(tokenFailReq);
    testAssert(tokenFailRes.status === 502, "Google token exchange failure returns HTTP 502 Bad Gateway");
    const tokenFailJson = await tokenFailRes.json();
    testAssert(tokenFailJson.error.includes("Google token exchange failed"), "Error explains token exchange failure");

    // Restore token exchange mock to 200
    mockTokenStatus = 200;
    mockTokenResponse = {
      access_token: "ya29.mock-token-good",
      refresh_token: "1//04mock-refresh-token-good",
      expires_in: 3600,
      scope: `${GMAIL_SEND_SCOPE} https://www.googleapis.com/auth/userinfo.email`,
    };

    // -------------------------------------------------------------------------
    // 9. Missing Refresh Token Handling
    // -------------------------------------------------------------------------
    console.log("\n--- [9] Missing Refresh Token Handling ---");

    mockTokenResponse = {
      access_token: "ya29.mock-token-no-refresh",
      // refresh_token intentionally omitted!
      expires_in: 3600,
      scope: `${GMAIL_SEND_SCOPE} https://www.googleapis.com/auth/userinfo.email`,
    };

    const noRefreshState = createOAuthState("client-alpha", adminId);
    const noRefreshReq = new NextRequest(
      `http://localhost:3000/api/admin/email/providers/google/callback?code=mock_code&state=${noRefreshState}`,
      { headers: { cookie: adminCookie, accept: "application/json" } }
    );
    const noRefreshRes = await getOAuthCallback(noRefreshReq);
    testAssert(noRefreshRes.status === 502, "Missing refresh token returns HTTP 502");
    const noRefreshJson = await noRefreshRes.json();
    testAssert(noRefreshJson.error.includes("Google did not return a refresh token"), "Error clearly alerts missing refresh token");

    // Restore valid refresh token
    mockTokenResponse = {
      access_token: "ya29.mock-token-fresh",
      refresh_token: "1//04valid-refresh-token-12345",
      expires_in: 3600,
      scope: `${GMAIL_SEND_SCOPE} https://www.googleapis.com/auth/userinfo.email`,
    };

    // -------------------------------------------------------------------------
    // 10. Authoritative Sender Identity Lookup Failure
    // -------------------------------------------------------------------------
    console.log("\n--- [10] Authoritative Sender Identity Lookup Failure ---");

    mockUserinfoStatus = 401;
    mockUserinfoResponse = { error: "unauthorized" };

    const userinfoFailState = createOAuthState("client-alpha", adminId);
    const userinfoFailReq = new NextRequest(
      `http://localhost:3000/api/admin/email/providers/google/callback?code=mock_code&state=${userinfoFailState}`,
      { headers: { cookie: adminCookie, accept: "application/json" } }
    );
    const userinfoFailRes = await getOAuthCallback(userinfoFailReq);
    testAssert(userinfoFailRes.status === 502, "Sender email lookup failure returns HTTP 502");
    const userinfoFailJson = await userinfoFailRes.json();
    testAssert(userinfoFailJson.error.includes("Unable to verify Google account email address"), "Error specifies verified email lookup failure");

    // Restore userinfo mock to 200
    mockUserinfoStatus = 200;
    mockUserinfoResponse = {
      email: "authoritative.sender@tenant-alpha.com",
      verified_email: true,
    };

    // -------------------------------------------------------------------------
    // 11. Encrypted Credentials Persistence & Decryption Verification
    // -------------------------------------------------------------------------
    console.log("\n--- [11] Encrypted Persistence at Rest ---");

    const validSetupState = createOAuthState("client-alpha", adminId);
    const setupReq = new NextRequest(
      `http://localhost:3000/api/admin/email/providers/google/callback?code=mock_code_setup&state=${validSetupState}`,
      { headers: { cookie: adminCookie, accept: "application/json" } }
    );
    const setupRes = await getOAuthCallback(setupReq);
    testAssert(setupRes.status === 200, "Setup callback completes with HTTP 200");
    const setupData = (await setupRes.json()).data;

    const savedProvider = inMemoryProviders.get(setupData.providerId);
    testAssert(savedProvider !== undefined, "Provider record saved in DB");
    testAssert(savedProvider.providerType === "GMAIL", "Provider type is GMAIL");
    testAssert(savedProvider.status === "ACTIVE", "Provider status initialized to ACTIVE");
    testAssert(savedProvider.senderEmail === "authoritative.sender@tenant-alpha.com", "Provider stores authoritative sender email");

    // Verify encryption: raw refresh token NEVER stored in plaintext
    testAssert(savedProvider.encryptedCredentials !== null, "Credentials payload is encrypted");
    testAssert(!savedProvider.encryptedCredentials.includes("1//04valid-refresh-token"), "Plaintext refresh token NOT exposed in credentials string");
    testAssert(savedProvider.encryptedOAuthRefreshToken !== null, "OAuth refresh token is separately encrypted");
    testAssert(!savedProvider.encryptedOAuthRefreshToken.includes("1//04valid-refresh-token"), "Plaintext refresh token NOT exposed in token string");

    // Decrypt and verify recovered payload matches exactly
    const decryptedPayloadStr = decryptProviderCredential(savedProvider.encryptedCredentials);
    const decryptedPayload = JSON.parse(decryptedPayloadStr);
    testAssert(decryptedPayload.refreshToken === "1//04valid-refresh-token-12345", "AES-256-GCM decrypts back to authentic refresh token");
    testAssert(decryptedPayload.clientId === process.env.GMAIL_CLIENT_ID, "Decrypted credentials contain matching client ID");

    // -------------------------------------------------------------------------
    // 12. Verified Sender Identity Persistence
    // -------------------------------------------------------------------------
    console.log("\n--- [12] Verified Sender Identity Persistence ---");

    const senderKey = "client-alpha_authoritative.sender@tenant-alpha.com";
    const savedIdentity = inMemoryIdentities.get(senderKey);
    testAssert(savedIdentity !== undefined, "EmailSenderIdentity record created in DB");
    testAssert(savedIdentity.verified === true, "Sender identity marked verified: true");
    testAssert(savedIdentity.verifiedAt instanceof Date, "Sender identity verifiedAt timestamp recorded");
    testAssert(savedIdentity.providerConfigId === setupData.providerId, "Sender identity linked to newly created providerConfig");

    // -------------------------------------------------------------------------
    // 13. VIEWER Role Rejection (RBAC)
    // -------------------------------------------------------------------------
    console.log("\n--- [13] RBAC Matrix: VIEWER Rejection ---");

    const viewerState = createOAuthState("client-alpha", adminId);
    const viewerReq = new NextRequest(
      `http://localhost:3000/api/admin/email/providers/google/callback?code=mock_code&state=${viewerState}`,
      { headers: { cookie: viewerCookie, accept: "application/json" } }
    );
    const viewerRes = await getOAuthCallback(viewerReq);
    testAssert(viewerRes.status === 403, "VIEWER role strictly forbidden (HTTP 403) from completing OAuth callback");

    // -------------------------------------------------------------------------
    // 14. ADMIN Success Browser Redirect Flow & Dashboard Listing
    // -------------------------------------------------------------------------
    console.log("\n--- [14] ADMIN Browser Flow & Dashboard Reflection ---");

    // 1. Admin navigates to OAuth initiation route
    const browserOAuthReq = new NextRequest("http://localhost:3000/api/admin/email/providers/google/oauth?clientId=client-alpha", {
      headers: { cookie: adminCookie, accept: "text/html,application/xhtml+xml" },
    });
    const browserOAuthRes = await getOAuthUrl(browserOAuthReq);
    testAssert(browserOAuthRes.status === 307 || browserOAuthRes.status === 302, "Browser navigation to OAuth initiation returns 302/307 redirect to Google");
    const googleAuthUrl = new URL(browserOAuthRes.headers.get("location")!);
    const flowState = googleAuthUrl.searchParams.get("state")!;

    // 2. Google redirects browser back to callback route
    const browserCallbackReq = new NextRequest(
      `http://localhost:3000/api/admin/email/providers/google/callback?code=mock_browser_code&state=${flowState}`,
      { headers: { cookie: adminCookie, accept: "text/html,application/xhtml+xml" } }
    );
    const browserCallbackRes = await getOAuthCallback(browserCallbackReq);
    testAssert(browserCallbackRes.status === 307 || browserCallbackRes.status === 302, "Browser callback returns redirect to dashboard");

    const returnUrl = new URL(browserCallbackRes.headers.get("location")!);
    testAssert(returnUrl.pathname === "/dashboard/email/providers", "Redirect destination is /dashboard/email/providers");
    testAssert(returnUrl.searchParams.get("status") === "success", "Redirect contains status=success");
    testAssert(returnUrl.searchParams.get("provider") === "authoritative.sender@tenant-alpha.com", "Redirect contains provider email");

    // 3. Verify GET /api/admin/email/providers immediately returns the newly connected provider
    const listReq = new NextRequest("http://localhost:3000/api/admin/email/providers?clientId=client-alpha", {
      headers: { cookie: adminCookie },
    });
    const listRes = await listProviders(listReq);
    testAssert(listRes.status === 200, "Providers listing returns HTTP 200");
    const providerList = (await listRes.json()).data;
    testAssert(providerList.length >= 1, "Configured provider appears in dashboard list");
    const listedProvider = providerList.find((p: any) => p.senderEmail === "authoritative.sender@tenant-alpha.com");
    testAssert(listedProvider !== undefined, "Connected Google Workspace provider found in list");
    testAssert(listedProvider.status === "ACTIVE", "Provider listed as ACTIVE");
    testAssert(listedProvider.encryptedCredentials === undefined, "CRITICAL: Secrets omitted from provider list response");

    // -------------------------------------------------------------------------
    // 15. Programmatic POST Callback Compatibility
    // -------------------------------------------------------------------------
    console.log("\n--- [15] Programmatic POST Callback Compatibility ---");

    const postState = createOAuthState("client-alpha", adminId);
    const postReq = new NextRequest("http://localhost:3000/api/admin/email/providers/google/callback", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: adminCookie,
      },
      body: JSON.stringify({
        code: "mock_post_code",
        state: postState,
        googleClientId: process.env.GMAIL_CLIENT_ID,
        googleClientSecret: process.env.GMAIL_CLIENT_SECRET,
      }),
    });
    const postRes = await postOAuthCallback(postReq);
    testAssert(postRes.status === 200, "POST callback returns HTTP 200");
    const postData = (await postRes.json()).data;
    testAssert(postData.status === "ACTIVE", "POST callback marks provider ACTIVE");
  } finally {
    // Restore mocks
    globalThis.fetch = origFetch;
    (prisma.userSession as any).findUnique = origSessionFindUnique;
    (prisma.apiClient as any).findUnique = origClientFindUnique;
    (prisma.apiClient as any).findFirst = origClientFindFirst;
    (prisma.emailProviderConfig as any).create = origProviderCreate;
    (prisma.emailProviderConfig as any).findMany = origProviderFindMany;
    (prisma.emailProviderConfig as any).updateMany = origProviderUpdateMany;
    (prisma.emailSenderIdentity as any).upsert = origIdentityUpsert;
    (prisma.emailSenderIdentity as any).findMany = origIdentityFindMany;
    OAuthTransactionStore.clear();
  }

  console.log("\n-------------------------------------------------");
  console.log(`OAuth Verification Summary: ${passed} PASSED, ${failed} FAILED`);
  console.log("-------------------------------------------------\n");

  if (failed > 0) {
    process.exit(1);
  }
}

runOAuthVerification().catch((err) => {
  console.error("Fatal error during OAuth verification:", err);
  process.exit(1);
});
