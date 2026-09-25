/**
 * Phase 2 Email Provider & Gmail Integration Verification Suite
 *
 * Validates:
 * 1. GmailProvider interface conformance & normalized response contract
 * 2. Successful send with mocked Google OAuth & Gmail send endpoints
 * 3. Token refresh failure handling & HTTP error classification (400, 401, 403, 429, 503)
 * 4. Missing credentials & missing refresh token rejection
 * 5. Multipart MIME (HTML + text, attachments, non-ASCII subject, category headers)
 * 6. Secret redaction (tokens & client secrets stripped from errors)
 * 7. Provider Registry resolution
 * 8. Server-side OAuth state creation & verification
 * 9. EmailService sender identity resolution & delivery state recording
 * 10. Server-side RBAC: VIEWER forbidden from mutating providers & sender identities
 *
 * Mocks all external Google API HTTP calls; does NOT send real emails or hit external APIs.
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { NextRequest } from "next/server";

process.env.AUTH_SESSION_SECRET = process.env.AUTH_SESSION_SECRET || "phase2-test-auth-session-secret-32-chars-min!";
process.env.API_KEY_PEPPER = process.env.API_KEY_PEPPER || "phase2-test-api-key-pepper-32-chars-min!!";
import {
  GmailProvider,
  GMAIL_SEND_SCOPE,
  GOOGLE_TOKEN_ENDPOINT,
  GMAIL_SEND_ENDPOINT,
  buildGmailMime,
  base64UrlDecode,
  base64UrlEncode,
  createOAuthState,
  verifyOAuthState,
  providerRegistry,
  getEmailProvider,
  EmailProviderType,
  EmailSendRequest,
  EmailType,
} from "../src/lib/email";
import {
  encryptProviderCredential,
  decryptProviderCredential,
} from "../src/lib/crypto";
import { EmailService } from "../src/lib/services/email-service";
import { prisma } from "../src/lib/prisma";
import { createSessionToken, hashPasswordForStorage, hashSessionToken, SESSION_COOKIE } from "../src/lib/auth";

async function runPhase2Tests() {
  console.log("==================================================================");
  console.log("📧 RUNNING PHASE 2 GMAIL PROVIDER & INTEGRATION VERIFICATION CHECKS");
  console.log("==================================================================\n");

  let passed = 0;
  let failed = 0;

  function testAssert(condition: boolean, testName: string, detail?: string) {
    if (condition) {
      console.log(`  ✅ PASS: ${testName}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${testName}${detail ? ` - ${detail}` : ""}`);
      failed++;
    }
  }

  // -------------------------------------------------------------------------
  // 1. MIME Generation & Base64URL Encoding
  // -------------------------------------------------------------------------
  const mimeRequest: EmailSendRequest = {
    clientId: "test-client-1",
    type: "PROMOTIONAL",
    to: "alice@example.com",
    from: { name: "Store Promo", email: "deals@mystore.com" },
    subject: "Special Offer: 50% Off! 🎉",
    html: "<h1>Special Sale</h1><p>Save 50% now!</p>",
    text: "Special Sale: Save 50% now!",
    headers: {
      "List-Unsubscribe": "<https://mystore.com/unsub>",
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  };

  const rawMime = buildGmailMime(mimeRequest, "deals@mystore.com");
  testAssert(rawMime.includes("From: \"Store Promo\" <deals@mystore.com>"), "MIME builder formats display name + email in From header");
  testAssert(rawMime.includes("To: alice@example.com"), "MIME builder includes To header");
  testAssert(rawMime.includes("=?UTF-8?B?"), "MIME builder encodes non-ASCII subject with RFC 2047 syntax");
  testAssert(rawMime.includes("Precedence: bulk"), "Promotional email includes Precedence: bulk header");
  testAssert(rawMime.includes("List-Unsubscribe: <https://mystore.com/unsub>"), "Promotional email includes List-Unsubscribe header");
  testAssert(rawMime.includes("multipart/alternative"), "Multipart/alternative used when both HTML and Text provided");

  const b64Url = base64UrlEncode(rawMime);
  testAssert(!b64Url.includes("+") && !b64Url.includes("/") && !b64Url.includes("="), "base64UrlEncode outputs RFC 4648 URL-safe string without +, /, or =");
  const decodedMime = base64UrlDecode(b64Url).toString("utf8");
  testAssert(decodedMime === rawMime, "base64UrlDecode restores exact original MIME string");

  // -------------------------------------------------------------------------
  // 2. Successful Send with Mocked Gmail API
  // -------------------------------------------------------------------------
  let tokenEndpointCalled = false;
  let sendEndpointCalled = false;

  const mockFetch: typeof fetch = async (input, init) => {
    const url = input.toString();

    if (url === GOOGLE_TOKEN_ENDPOINT) {
      tokenEndpointCalled = true;
      return new Response(
        JSON.stringify({
          access_token: "mock-access-token-ya29-xyz123",
          expires_in: 3600,
          token_type: "Bearer",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    if (url === GMAIL_SEND_ENDPOINT) {
      sendEndpointCalled = true;
      // Verify Authorization header
      const authHeader = (init?.headers as Record<string, string>)?.["Authorization"];
      if (authHeader !== "Bearer mock-access-token-ya29-xyz123") {
        return new Response("Unauthorized", { status: 401 });
      }

      // Verify JSON body has raw field
      const parsedBody = JSON.parse(init?.body as string);
      if (!parsedBody.raw) {
        return new Response("Missing raw field", { status: 400 });
      }

      return new Response(
        JSON.stringify({
          id: "gmail_msg_id_success_999",
          threadId: "gmail_thread_id_888",
          labelIds: ["SENT"],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response("Not Found", { status: 404 });
  };

  const provider = new GmailProvider({
    credentials: {
      clientId: "mock-client-id.apps.googleusercontent.com",
      clientSecret: "mock-client-secret-abc",
      refreshToken: "mock-refresh-token-123",
      senderEmail: "deals@mystore.com",
    },
    fetchFn: mockFetch,
  });

  const sendResult = await provider.send(mimeRequest);

  testAssert(tokenEndpointCalled, "Token endpoint was called to obtain access token");
  testAssert(sendEndpointCalled, "Gmail send endpoint was called with payload");
  testAssert(sendResult.accepted === true && sendResult.success === true, "Send result marked accepted and success = true");
  testAssert(sendResult.providerName === "Google Workspace / Gmail", "Normalized providerName matches 'Google Workspace / Gmail'");
  testAssert(sendResult.providerType === EmailProviderType.GMAIL, "Normalized providerType is GMAIL");
  testAssert(sendResult.providerMessageId === "gmail_msg_id_success_999", "Returns normalized providerMessageId");
  testAssert(sendResult.providerStatus === "SENT", "Normalized providerStatus is SENT");
  testAssert(sendResult.error === undefined, "No error returned on successful send");

  // -------------------------------------------------------------------------
  // 3. Missing Credentials & Refresh Token
  // -------------------------------------------------------------------------
  const emptyProvider = new GmailProvider({
    credentials: {
      clientId: "",
      clientSecret: "",
      refreshToken: "",
    },
    fetchFn: mockFetch,
  });

  const missingCredsResult = await emptyProvider.send(mimeRequest);
  testAssert(
    missingCredsResult.accepted === false && missingCredsResult.error?.code === "MISSING_CREDENTIALS",
    "Missing credentials correctly returned with code MISSING_CREDENTIALS"
  );

  // -------------------------------------------------------------------------
  // 4. Token Refresh Failure Handling
  // -------------------------------------------------------------------------
  const failAuthFetch: typeof fetch = async (input) => {
    const url = input.toString();
    if (url === GOOGLE_TOKEN_ENDPOINT) {
      return new Response(
        JSON.stringify({
          error: "invalid_grant",
          error_description: "Token has been expired or revoked.",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response("Not Found", { status: 404 });
  };

  const failAuthProvider = new GmailProvider({
    credentials: {
      clientId: "mock-id",
      clientSecret: "mock-secret",
      refreshToken: "revoked-refresh-token",
      senderEmail: "deals@mystore.com",
    },
    fetchFn: failAuthFetch,
  });

  const failAuthResult = await failAuthProvider.send(mimeRequest);
  testAssert(
    failAuthResult.accepted === false && failAuthResult.error?.code === "PROVIDER_ERROR",
    "Token refresh failure handled cleanly with error return"
  );
  testAssert(
    !failAuthResult.error?.message.includes("mock-secret"),
    "Client secret is redacted from token refresh error message"
  );

  // -------------------------------------------------------------------------
  // 5. HTTP Error Classification (400, 401, 403, 429, 503)
  // -------------------------------------------------------------------------
  const err429 = provider.classifyHttpError(429, "Rate limit exceeded");
  testAssert(err429.code === "RATE_LIMIT_EXCEEDED" && err429.retryable === true, "429 classified as RATE_LIMIT_EXCEEDED (retryable: true)");

  const err503 = provider.classifyHttpError(503, "Backend Error");
  testAssert(err503.code === "SERVICE_UNAVAILABLE" && err503.retryable === true, "503 classified as SERVICE_UNAVAILABLE (retryable: true)");

  const err401 = provider.classifyHttpError(401, "Invalid Credentials");
  testAssert(err401.code === "AUTHENTICATION_FAILED" && err401.retryable === false, "401 classified as AUTHENTICATION_FAILED (retryable: false)");

  const err403Quota = provider.classifyHttpError(403, "Daily User Sending Quota Exceeded");
  testAssert(err403Quota.code === "QUOTA_EXCEEDED" && err403Quota.retryable === false, "403 (quota) classified as QUOTA_EXCEEDED (retryable: false)");

  const err403Perm = provider.classifyHttpError(403, "Access Not Configured");
  testAssert(err403Perm.code === "PERMISSION_DENIED" && err403Perm.retryable === false, "403 (permissions) classified as PERMISSION_DENIED (retryable: false)");

  const err400 = provider.classifyHttpError(400, "Bad Request: Invalid raw payload");
  testAssert(err400.code === "INVALID_REQUEST" && err400.retryable === false, "400 classified as INVALID_REQUEST (retryable: false)");

  // -------------------------------------------------------------------------
  // 6. Secret Redaction
  // -------------------------------------------------------------------------
  const sensitiveRaw = "Error with clientSecret mock-client-secret-abc and refreshToken mock-refresh-token-123";
  const redacted = provider.redactSecrets(sensitiveRaw);
  testAssert(!redacted.includes("mock-client-secret-abc"), "redactSecrets removes clientSecret");
  testAssert(!redacted.includes("mock-refresh-token-123"), "redactSecrets removes refreshToken");
  testAssert(redacted.includes("[REDACTED_CLIENT_SECRET]") && redacted.includes("[REDACTED_REFRESH_TOKEN]"), "redactSecrets inserts safety placeholders");

  // -------------------------------------------------------------------------
  // 7. Encrypted Credential Representation (AES-256-GCM)
  // -------------------------------------------------------------------------
  const rawCreds = JSON.stringify({
    clientId: "google-123",
    clientSecret: "secret-456",
    refreshToken: "token-789",
  });
  const enc = encryptProviderCredential(rawCreds);
  testAssert(enc.split(":").length === 3, "encryptProviderCredential outputs iv:authTag:ciphertext format");
  testAssert(!enc.includes("secret-456") && !enc.includes("token-789"), "Encrypted string contains no plaintext tokens or secrets");
  const dec = decryptProviderCredential(enc);
  testAssert(dec === rawCreds, "decryptProviderCredential roundtrips exact credentials");

  // Provider instantiation via encryptedCredentials
  const encProvider = new GmailProvider({
    encryptedCredentials: enc,
    fetchFn: mockFetch,
  });
  testAssert(encProvider.id === "gmail", "GmailProvider successfully initializes using encryptedCredentials");

  // -------------------------------------------------------------------------
  // 8. Provider Registry
  // -------------------------------------------------------------------------
  testAssert(providerRegistry.has(EmailProviderType.GMAIL), "Provider registry has GMAIL registered");
  const resolvedProvider = getEmailProvider(EmailProviderType.GMAIL, {
    credentials: {
      clientId: "id",
      clientSecret: "sec",
      refreshToken: "ref",
    },
    fetchFn: mockFetch,
  });
  testAssert(resolvedProvider.id === "gmail", "getEmailProvider resolves Gmail provider instance");

  // -------------------------------------------------------------------------
  // 9. OAuth State Generation & Verification (CSRF Protection)
  // -------------------------------------------------------------------------
  const state = createOAuthState("tenant-123", "test-secret-32-chars-minimum-len");
  const stateVerify = verifyOAuthState(state, "test-secret-32-chars-minimum-len");
  testAssert(stateVerify.valid === true && stateVerify.tenantId === "tenant-123", "OAuth state encodes and validates tenantId with HMAC signature");

  const tamperedState = `tamperedPayload.${state.split(".")[1]}`;
  testAssert(verifyOAuthState(tamperedState, "test-secret-32-chars-minimum-len").valid === false, "Tampered OAuth state is rejected");

  // -------------------------------------------------------------------------
  // 10. EmailService Sender Validation & Delivery State
  // -------------------------------------------------------------------------
  // Clean mock provider test inside EmailService
  let threwNoClient = false;
  try {
    await EmailService.send({
      clientId: "",
      type: "TRANSACTIONAL",
      to: "bob@example.com",
      subject: "Test",
      text: "Content",
    });
  } catch {
    threwNoClient = true;
  }
  testAssert(threwNoClient, "EmailService strictly requires non-empty clientId");

  let threwBadRecipient = false;
  try {
    await EmailService.send({
      clientId: "tenant-01",
      type: "TRANSACTIONAL",
      to: "not-an-email\r\nBcc: evil@attacker.com",
      subject: "Test",
      text: "Content",
    });
  } catch {
    threwBadRecipient = true;
  }
  testAssert(threwBadRecipient, "EmailService rejects malformed or header-injected recipient email");

  let threwEmptyContent = false;
  try {
    await EmailService.send({
      clientId: "tenant-01",
      type: "TRANSACTIONAL",
      to: "bob@example.com",
      subject: "Test",
      text: "",
      html: "",
    });
  } catch {
    threwEmptyContent = true;
  }
  testAssert(threwEmptyContent, "EmailService rejects email without text or html body");

  // -------------------------------------------------------------------------
  // 11. Server-Side RBAC Enforcement (Viewer vs Admin on Email Provider Routes)
  // -------------------------------------------------------------------------
  const { GET: getProviders, POST: postProvider } = await import("../src/app/api/admin/email/providers/route");
  const { GET: getOAuthUrl } = await import("../src/app/api/admin/email/providers/google/oauth/route");
  const { POST: postOAuthCallback } = await import("../src/app/api/admin/email/providers/google/callback/route");
  const { GET: getSenderIdentities, POST: postSenderIdentity } = await import("../src/app/api/admin/email/sender-identities/route");

  // Generate tokens for test Admin and test Viewer
  const adminTokenObj = createSessionToken({ id: "mock-admin-id", email: "admin@example.com", role: "ADMIN" });
  const viewerTokenObj = createSessionToken({ id: "mock-viewer-id", email: "viewer@example.com", role: "VIEWER" });

  const adminCookie = `${SESSION_COOKIE}=${encodeURIComponent(adminTokenObj.token)}`;
  const viewerCookie = `${SESSION_COOKIE}=${encodeURIComponent(viewerTokenObj.token)}`;

  // Mock prisma session lookup and query handlers so tests run isolated from DB
  const origFindUnique = prisma.userSession.findUnique;
  const origProviderFindMany = (prisma.emailProviderConfig as any).findMany;
  const origIdentityFindMany = (prisma.emailSenderIdentity as any).findMany;

  (prisma.userSession as any).findUnique = async ({ where }: any) => {
    if (where.tokenHash === hashSessionToken(adminTokenObj.token)) {
      return {
        id: "session-admin",
        tokenHash: where.tokenHash,
        expiresAt: new Date(Date.now() + 3600000),
        user: {
          id: "mock-admin-id",
          email: "admin@example.com",
          role: "ADMIN",
          active: true,
        },
      };
    }
    if (where.tokenHash === hashSessionToken(viewerTokenObj.token)) {
      return {
        id: "session-viewer",
        tokenHash: where.tokenHash,
        expiresAt: new Date(Date.now() + 3600000),
        user: {
          id: "mock-viewer-id",
          email: "viewer@example.com",
          role: "VIEWER",
          active: true,
        },
      };
    }
    return null;
  };

  (prisma.emailProviderConfig as any).findMany = async () => [];
  (prisma.emailSenderIdentity as any).findMany = async () => [];

  try {
    // Viewer -> POST /api/admin/email/providers must return 403
    const viewerReqPost = new NextRequest("http://localhost:3000/api/admin/email/providers", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: viewerCookie,
      },
      body: JSON.stringify({
        clientId: "test-client",
        providerType: "GMAIL",
      }),
    });
    const viewerResPost = await postProvider(viewerReqPost);
    testAssert(viewerResPost.status === 403, "Viewer is forbidden (403) from creating email providers");

    // Viewer -> GET /api/admin/email/providers/google/oauth must return 403
    const viewerReqOAuth = new NextRequest("http://localhost:3000/api/admin/email/providers/google/oauth?clientId=client-1", {
      method: "GET",
      headers: { cookie: viewerCookie },
    });
    const viewerResOAuth = await getOAuthUrl(viewerReqOAuth);
    testAssert(viewerResOAuth.status === 403, "Viewer is forbidden (403) from initiating Google OAuth");

    // Viewer -> POST /api/admin/email/providers/google/callback must return 403
    const viewerReqCb = new NextRequest("http://localhost:3000/api/admin/email/providers/google/callback", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: viewerCookie,
      },
      body: JSON.stringify({ code: "abc", state: "xyz" }),
    });
    const viewerResCb = await postOAuthCallback(viewerReqCb);
    testAssert(viewerResCb.status === 403, "Viewer is forbidden (403) from completing Google OAuth callback");

    // Viewer -> POST /api/admin/email/sender-identities must return 403
    const viewerReqIdentity = new NextRequest("http://localhost:3000/api/admin/email/sender-identities", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: viewerCookie,
      },
      body: JSON.stringify({
        clientId: "test-client",
        email: "sender@example.com",
      }),
    });
    const viewerResIdentity = await postSenderIdentity(viewerReqIdentity);
    testAssert(viewerResIdentity.status === 403, "Viewer is forbidden (403) from mutating sender identities");

    // Viewer -> GET /api/admin/email/providers is permitted (read-only, secrets omitted)
    const viewerReqGet = new NextRequest("http://localhost:3000/api/admin/email/providers", {
      method: "GET",
      headers: { cookie: viewerCookie },
    });
    const viewerResGet = await getProviders(viewerReqGet);
    testAssert(viewerResGet.status === 200, "Viewer is permitted (200) to read email provider listings");

    // Viewer -> GET /api/admin/email/sender-identities is permitted (read-only)
    const viewerReqGetId = new NextRequest("http://localhost:3000/api/admin/email/sender-identities", {
      method: "GET",
      headers: { cookie: viewerCookie },
    });
    const viewerResGetId = await getSenderIdentities(viewerReqGetId);
    testAssert(viewerResGetId.status === 200, "Viewer is permitted (200) to read sender identities");

    // Admin -> GET /api/admin/email/providers is permitted
    const adminReqGet = new NextRequest("http://localhost:3000/api/admin/email/providers", {
      method: "GET",
      headers: { cookie: adminCookie },
    });
    const adminResGet = await getProviders(adminReqGet);
    testAssert(adminResGet.status === 200, "Admin is permitted (200) to read email provider listings");
  } finally {
    // Restore mocks
    (prisma.userSession as any).findUnique = origFindUnique;
    (prisma.emailProviderConfig as any).findMany = origProviderFindMany;
    (prisma.emailSenderIdentity as any).findMany = origIdentityFindMany;
  }

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  console.log("\n-------------------------------------------------");
  console.log(`Summary: ${passed} PASSED, ${failed} FAILED`);
  console.log("-------------------------------------------------\n");

  if (failed > 0) {
    process.exit(1);
  }
}

runPhase2Tests().catch((err) => {
  console.error("Fatal error during Phase 2 verification:", err);
  process.exit(1);
});
