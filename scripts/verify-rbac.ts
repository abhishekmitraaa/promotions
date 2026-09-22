import assert from "node:assert/strict";
import crypto from "node:crypto";
import { assertDestructiveTestAllowed } from "./test-db-guard";

process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.AUTH_SESSION_SECRET ||= "rbac-test-session-secret-32-characters-minimum";
process.env.API_KEY_PEPPER ||= "rbac-test-api-key-pepper-32-characters-min";
process.env.WEBHOOK_SECRET_ENCRYPTION_KEY ||= "rbac-test-webhook-key-32-characters-min";
process.env.INTERNAL_WORKER_SECRET ||= "rbac-test-worker-secret-32-chars-min";

type AnyResponse = Response & { cookies?: { get(name: string): { value: string } | undefined } };

async function main() {
  assertDestructiveTestAllowed("verify-rbac");

  const { NextRequest } = await import("next/server");
  const { prisma } = await import("../src/lib/prisma");
  const { hashPasswordForStorage, verifyPassword, createSessionToken, verifySessionTokenNode, SESSION_COOKIE } = await import("../src/lib/auth");
  const login = (await import("../src/app/api/auth/login/route")).POST;
  const logout = (await import("../src/app/api/auth/logout/route")).POST;
  const me = (await import("../src/app/api/auth/me/route")).GET;
  const users = await import("../src/app/api/admin/users/route");
  const overview = (await import("../src/app/api/admin/overview/route")).GET;
  const messages = (await import("../src/app/api/admin/messages/route")).GET;
  const conversations = (await import("../src/app/api/admin/conversations/route")).GET;
  const apiKeys = await import("../src/app/api/admin/api-keys/route");
  const revokeApiKey = (await import("../src/app/api/admin/api-keys/[id]/revoke/route")).POST;
  const webhooks = await import("../src/app/api/admin/webhooks/route");
  const webhookItem = await import("../src/app/api/admin/webhooks/[id]/route");
  const regenWebhookSecret = (await import("../src/app/api/admin/webhooks/[id]/regenerate-secret/route")).POST;
  const webhookDeliveries = await import("../src/app/api/admin/webhooks/deliveries/route");
  const sendMessage = (await import("../src/app/api/admin/messages/send/route")).POST;
  const cleanup = (await import("../src/app/api/admin/clean-data/route")).POST;
  const queue = (await import("../src/app/api/admin/webhooks/process-queue/route")).POST;
  const middleware = (await import("../src/middleware")).middleware;

  const suffix = crypto.randomBytes(5).toString("hex");
  const adminEmail = `rbac-admin-${suffix}@example.test`;
  const viewerEmail = `rbac-viewer-${suffix}@example.test`;
  const secondaryAdminEmail = `rbac-admin2-${suffix}@example.test`;
  const adminPassword = `Admin!${crypto.randomBytes(12).toString("hex")}`;
  const viewerPassword = `Viewer!${crypto.randomBytes(12).toString("hex")}`;
  const secondaryAdminPassword = `Admin2!${crypto.randomBytes(12).toString("hex")}`;
  const resetPassword = `Reset!${crypto.randomBytes(12).toString("hex")}`;

  let adminCookie = "";
  let viewerCookie = "";
  let apiClientId = "";
  let apiKeyId = "";
  let webhookId = "";
  let secondaryAdminId = "";
  let adminId = "";

  const request = (url: string, method = "GET", body?: unknown, cookie = "", ip = "") =>
    new NextRequest(`http://localhost:3000${url}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(cookie ? { cookie: `${SESSION_COOKIE}=${encodeURIComponent(cookie)}` } : {}),
        ...(ip ? { "x-forwarded-for": ip } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  const json = async (res: Response) => {
    const data = await res.json();
    return data;
  };

  const loginAs = async (email: string, password: string, ip = crypto.randomBytes(4).toString("hex")) => {
    const res = await login(request("/api/auth/login", "POST", { email, password }, "", ip));
    const cookie = res.cookies?.get(SESSION_COOKIE)?.value || "";
    return { res, cookie };
  };

  const assertStatus = (res: Response, expected: number, label: string) => {
    assert.equal(res.status, expected, `${label}: expected ${expected}, got ${res.status}`);
  };

  try {
    console.log("1. Password hashing and verification");
    const passwordHash = await hashPasswordForStorage(adminPassword);
    assert.notEqual(passwordHash, adminPassword);
    assert.match(passwordHash, /^scrypt\$/);
    assert.equal(await verifyPassword(adminPassword, passwordHash), true);
    assert.equal(await verifyPassword("wrong-password", passwordHash), false);

    console.log("2. Session token integrity, dotted emails, tampering & robustness");
    const tokenInfo = createSessionToken({ id: "u-test", email: adminEmail, role: "ADMIN" });
    assert.equal(verifySessionTokenNode(tokenInfo.token)?.email, adminEmail);
    assert.equal(verifySessionTokenNode(tokenInfo.token)?.role, "ADMIN");
    const [encoded, signature] = tokenInfo.token.split(".");
    const tampered = `${encoded}.${signature.slice(0, -1)}x`;
    assert.equal(verifySessionTokenNode(tampered), null);

    // Malformed session token robustness checks
    assert.equal(verifySessionTokenNode(""), null, "empty token");
    assert.equal(verifySessionTokenNode("   "), null, "whitespace token");
    assert.equal(verifySessionTokenNode("not.valid.base64"), null, "invalid base64");
    assert.equal(verifySessionTokenNode(`${encoded}.invalid_sig`), null, "invalid signature");

    // Expired token
    const expiredPayload = Buffer.from(JSON.stringify({ id: "u-test", email: adminEmail, role: "ADMIN", expiresAt: Date.now() - 1000 })).toString("base64url");
    const expiredSig = crypto.createHmac("sha256", process.env.AUTH_SESSION_SECRET!).update(Buffer.from(expiredPayload, "base64url").toString("utf8")).digest("base64url");
    assert.equal(verifySessionTokenNode(`${expiredPayload}.${expiredSig}`), null, "expired token");

    // Invalid role
    const badRolePayload = Buffer.from(JSON.stringify({ id: "u-test", email: adminEmail, role: "SUPERUSER", expiresAt: Date.now() + 10000 })).toString("base64url");
    const badRoleSig = crypto.createHmac("sha256", process.env.AUTH_SESSION_SECRET!).update(Buffer.from(badRolePayload, "base64url").toString("utf8")).digest("base64url");
    assert.equal(verifySessionTokenNode(`${badRolePayload}.${badRoleSig}`), null, "invalid role");

    // Missing id
    const missingIdPayload = Buffer.from(JSON.stringify({ email: adminEmail, role: "ADMIN", expiresAt: Date.now() + 10000 })).toString("base64url");
    const missingIdSig = crypto.createHmac("sha256", process.env.AUTH_SESSION_SECRET!).update(Buffer.from(missingIdPayload, "base64url").toString("utf8")).digest("base64url");
    assert.equal(verifySessionTokenNode(`${missingIdPayload}.${missingIdSig}`), null, "missing id");

    // Missing email
    const missingEmailPayload = Buffer.from(JSON.stringify({ id: "u-test", role: "ADMIN", expiresAt: Date.now() + 10000 })).toString("base64url");
    const missingEmailSig = crypto.createHmac("sha256", process.env.AUTH_SESSION_SECRET!).update(Buffer.from(missingEmailPayload, "base64url").toString("utf8")).digest("base64url");
    assert.equal(verifySessionTokenNode(`${missingEmailPayload}.${missingEmailSig}`), null, "missing email");

    // Missing expiresAt
    const missingExpiresPayload = Buffer.from(JSON.stringify({ id: "u-test", email: adminEmail, role: "ADMIN" })).toString("base64url");
    const missingExpiresSig = crypto.createHmac("sha256", process.env.AUTH_SESSION_SECRET!).update(Buffer.from(missingExpiresPayload, "base64url").toString("utf8")).digest("base64url");
    assert.equal(verifySessionTokenNode(`${missingExpiresPayload}.${missingExpiresSig}`), null, "missing expiresAt");

    console.log("3. Database user creation stores only password hash");
    const admin = await prisma.user.create({
      data: { email: adminEmail, passwordHash, role: "ADMIN", active: true },
    });
    adminId = admin.id;
    const storedAdmin = await prisma.user.findUnique({ where: { id: admin.id } });
    assert.ok(storedAdmin);
    assert.equal(storedAdmin?.passwordHash, passwordHash);
    assert.notEqual(storedAdmin?.passwordHash, adminPassword);

    console.log("4. Admin login, cookie flags, and /me");
    const loginAdmin = await loginAs(adminEmail, adminPassword);
    assertStatus(loginAdmin.res, 200, "Admin login");
    assert.ok(loginAdmin.cookie, "Admin session cookie should exist");
    const setCookie = loginAdmin.res.headers.get("set-cookie") || "";
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=lax/i);
    adminCookie = loginAdmin.cookie;

    const adminMe = await me(request("/api/auth/me", "GET", undefined, adminCookie));
    assertStatus(adminMe, 200, "Admin /me");
    assert.equal((await json(adminMe)).data.role, "ADMIN");

    console.log("5. Admin creates viewer through real API");
    const createViewer = await users.POST(request("/api/admin/users", "POST", {
      email: viewerEmail, password: viewerPassword, role: "VIEWER"
    }, adminCookie));
    assertStatus(createViewer, 201, "Create viewer");
    const viewerRecord = await prisma.user.findUnique({ where: { email: viewerEmail } });
    assert.ok(viewerRecord);
    assert.equal(viewerRecord?.role, "VIEWER");
    assert.equal(viewerRecord?.passwordHash === viewerPassword, false);

    const createAdmin = await users.POST(request("/api/admin/users", "POST", {
      email: secondaryAdminEmail, password: secondaryAdminPassword, role: "ADMIN"
    }, adminCookie));
    assertStatus(createAdmin, 201, "Create second admin");
    const secondaryAdmin = await prisma.user.findUnique({ where: { email: secondaryAdminEmail } });
    assert.ok(secondaryAdmin);
    secondaryAdminId = secondaryAdmin!.id;
    assert.equal(secondaryAdmin?.role, "ADMIN");

    console.log("6. Validation: weak password, invalid email, and duplicate email");
    const weak = await users.POST(request("/api/admin/users", "POST", {
      email: `weak-${suffix}@example.test`, password: "short", role: "VIEWER"
    }, adminCookie));
    assertStatus(weak, 400, "Weak password");
    const invalidEmail = await users.POST(request("/api/admin/users", "POST", {
      email: "not-an-email", password: viewerPassword, role: "VIEWER"
    }, adminCookie));
    assertStatus(invalidEmail, 400, "Invalid email format");
    const emptyEmail = await users.POST(request("/api/admin/users", "POST", {
      email: "", password: viewerPassword, role: "VIEWER"
    }, adminCookie));
    assertStatus(emptyEmail, 400, "Empty email");
    const invalidRole = await users.POST(request("/api/admin/users", "POST", {
      email: `role-${suffix}@example.test`, password: viewerPassword, role: "SUPERMAN"
    }, adminCookie));
    assertStatus(invalidRole, 400, "Invalid role");
    const duplicate = await users.POST(request("/api/admin/users", "POST", {
      email: viewerEmail, password: viewerPassword, role: "VIEWER"
    }, adminCookie));
    assertStatus(duplicate, 409, "Duplicate email");

    console.log("7. Viewer login and read access");
    const loginViewer = await loginAs(viewerEmail, viewerPassword);
    assertStatus(loginViewer.res, 200, "Viewer login");
    viewerCookie = loginViewer.cookie;
    assert.ok(viewerCookie);

    const viewerMe = await me(request("/api/auth/me", "GET", undefined, viewerCookie));
    assertStatus(viewerMe, 200, "Viewer /me");
    assert.equal((await json(viewerMe)).data.role, "VIEWER");

    for (const [label, handler, url] of [
      ["overview", overview, "/api/admin/overview"],
      ["messages", messages, "/api/admin/messages"],
      ["conversations", conversations, "/api/admin/conversations"],
      ["api keys", apiKeys.GET, "/api/admin/api-keys"],
      ["webhooks", webhooks.GET, "/api/admin/webhooks"],
      ["deliveries", webhookDeliveries.GET, "/api/admin/webhooks/deliveries"],
      ["users", users.GET, "/api/admin/users"],
    ] as const) {
      const res = await handler(request(url, "GET", undefined, viewerCookie));
      assert.equal(res.status !== 401 && res.status !== 403, true, `Viewer should be allowed to read ${label}`);
    }

    console.log("8. Viewer mutation denial matrix");
    const denied: Array<[string, Promise<Response>]> = [
      ["create user", users.POST(request("/api/admin/users", "POST", { email: `blocked-${suffix}@example.test`, password: viewerPassword, role: "ADMIN" }, viewerCookie))],
      ["patch user", users.PATCH(request("/api/admin/users", "PATCH", { id: "dummy-id", role: "ADMIN" }, viewerCookie))],
      ["delete user", users.DELETE(request("/api/admin/users?id=dummy-id", "DELETE", undefined, viewerCookie))],
      ["create api key", apiKeys.POST(request("/api/admin/api-keys", "POST", { clientName: `blocked-${suffix}` }, viewerCookie))],
      ["revoke api key", revokeApiKey(request("/api/admin/api-keys/dummy-id/revoke", "POST", {}, viewerCookie), { params: Promise.resolve({ id: "dummy-id" }) })],
      ["send message", sendMessage(request("/api/admin/messages/send", "POST", { to: "919876543210", type: "text", body: "blocked" }, viewerCookie))],
      ["create webhook", webhooks.POST(request("/api/admin/webhooks", "POST", { name: "blocked", url: "https://example.com/hook", subscribedEvents: ["*"] }, viewerCookie))],
      ["patch webhook", webhookItem.PATCH(request("/api/admin/webhooks/dummy-id", "PATCH", { name: "blocked" }, viewerCookie), { params: Promise.resolve({ id: "dummy-id" }) })],
      ["delete webhook", webhookItem.DELETE(request("/api/admin/webhooks/dummy-id", "DELETE", undefined, viewerCookie), { params: Promise.resolve({ id: "dummy-id" }) })],
      ["regenerate webhook secret", regenWebhookSecret(request("/api/admin/webhooks/dummy-id/regenerate-secret", "POST", undefined, viewerCookie), { params: Promise.resolve({ id: "dummy-id" }) })],
      ["retry delivery", webhookDeliveries.POST(request("/api/admin/webhooks/deliveries", "POST", { deliveryId: "missing" }, viewerCookie))],
      ["cleanup", cleanup(request("/api/admin/clean-data", "POST", { confirm: "NO" }, viewerCookie))],
      ["process queue", queue(request("/api/admin/webhooks/process-queue", "POST", undefined, viewerCookie))],
    ];
    for (const [label, p] of denied) assertStatus(await p, 403, `Viewer ${label}`);

    // Verify authorized worker can trigger queue processing via x-worker-secret
    const workerQueueRes = await queue(new NextRequest("http://localhost:3000/api/admin/webhooks/process-queue", {
      method: "POST",
      headers: { "x-worker-secret": process.env.INTERNAL_WORKER_SECRET! },
    }));
    assertStatus(workerQueueRes, 200, "Worker secret queue processing");

    console.log("9. Middleware unauthenticated redirect, viewer mutation block & worker secret verification");
    const unauthDashboard = await middleware(request("/dashboard"));
    assert.equal(unauthDashboard.status, 307);
    const viewerMutation = await middleware(request("/api/admin/users", "POST", {}, viewerCookie));
    assert.equal(viewerMutation.status, 403);
    const viewerDashboard = await middleware(request("/dashboard", "GET", undefined, viewerCookie));
    assert.equal(viewerDashboard.status, 200);

    // Worker secret timing-safe comparison & method/path restriction matrix
    const workerSecret = process.env.INTERNAL_WORKER_SECRET!;
    const workerReq = (url: string, method = "POST", secretHeader?: string) =>
      new NextRequest(`http://localhost:3000${url}`, {
        method,
        headers: {
          ...(secretHeader !== undefined ? { "x-worker-secret": secretHeader } : {}),
        },
      });

    // 9a. Valid worker secret + POST on /api/admin/webhooks/process-queue => ALLOWED (200 / next)
    const validWorkerRes = await middleware(workerReq("/api/admin/webhooks/process-queue", "POST", workerSecret));
    assert.equal(validWorkerRes.status, 200, "Valid worker secret POST must be allowed through middleware");

    // 9b. Invalid worker secret + POST on /api/admin/webhooks/process-queue => 401 UNAUTHORIZED
    const invalidWorkerRes = await middleware(workerReq("/api/admin/webhooks/process-queue", "POST", "wrong-secret-value"));
    assert.equal(invalidWorkerRes.status, 401, "Invalid worker secret must return 401");

    // 9c. Missing worker secret + POST on /api/admin/webhooks/process-queue => 401 UNAUTHORIZED
    const missingWorkerRes = await middleware(workerReq("/api/admin/webhooks/process-queue", "POST"));
    assert.equal(missingWorkerRes.status, 401, "Missing worker secret must return 401");

    // 9d. Valid worker secret + GET on /api/admin/webhooks/process-queue => 401 (POST-only restriction)
    const getWorkerRes = await middleware(workerReq("/api/admin/webhooks/process-queue", "GET", workerSecret));
    assert.equal(getWorkerRes.status, 401, "GET with valid worker secret must NOT be accepted as worker bypass");

    // 9e. Valid worker secret + PUT on /api/admin/webhooks/process-queue => 401 (POST-only restriction)
    const putWorkerRes = await middleware(workerReq("/api/admin/webhooks/process-queue", "PUT", workerSecret));
    assert.equal(putWorkerRes.status, 401, "PUT with valid worker secret must NOT be accepted as worker bypass");

    // 9f. Valid worker secret + DELETE on /api/admin/webhooks/process-queue => 401 (POST-only restriction)
    const deleteWorkerRes = await middleware(workerReq("/api/admin/webhooks/process-queue", "DELETE", workerSecret));
    assert.equal(deleteWorkerRes.status, 401, "DELETE with valid worker secret must NOT be accepted as worker bypass");

    // 9g. Valid worker secret on /api/admin/users (wrong endpoint) => 401 (exact path restriction)
    const wrongPathWorkerRes = await middleware(workerReq("/api/admin/users", "POST", workerSecret));
    assert.equal(wrongPathWorkerRes.status, 401, "Valid worker secret on wrong path must NOT be accepted as worker bypass");

    console.log("10. Admin API client + API key management");
    const apiCreate = await apiKeys.POST(request("/api/admin/api-keys", "POST", { clientName: `rbac-client-${suffix}`, keyName: "RBAC Test" }, adminCookie));
    assertStatus(apiCreate, 200, "Create API key");
    const apiCreateBody = await json(apiCreate);
    apiClientId = apiCreateBody.data.clientId;
    apiKeyId = apiCreateBody.data.keyId;
    assert.ok(apiCreateBody.data.rawKey);
    const apiRevoke = await revokeApiKey(request(`/api/admin/api-keys/${apiKeyId}/revoke`, "POST", {}, adminCookie), { params: Promise.resolve({ id: apiKeyId }) });
    assertStatus(apiRevoke, 200, "Revoke API key");
    const viewerRevoke = await revokeApiKey(request(`/api/admin/api-keys/${apiKeyId}/revoke`, "POST", {}, viewerCookie), { params: Promise.resolve({ id: apiKeyId }) });
    assertStatus(viewerRevoke, 403, "Viewer revoke API key");

    console.log("11. Admin messaging read + dispatch path");
    const send = await sendMessage(request("/api/admin/messages/send", "POST", { clientId: apiClientId, to: "919876543210", type: "text", body: "RBAC integration test" }, adminCookie));
    assert.equal(send.status !== 401 && send.status !== 403, true, `Admin send must pass authorization, got ${send.status}`);
    assert.equal((await messages(request("/api/admin/messages", "GET", undefined, viewerCookie))).status, 200);

    console.log("12. Admin webhook create/read/update/delete/regenerate-secret");
    const webhookCreate = await webhooks.POST(request("/api/admin/webhooks", "POST", {
      name: `rbac-hook-${suffix}`, url: "https://example.com/rbac-hook", subscribedEvents: ["message.sent"]
    }, adminCookie));
    assertStatus(webhookCreate, 200, "Create webhook");
    webhookId = (await json(webhookCreate)).data.id;
    const webhookRead = await webhookItem.GET(
      request(`/api/admin/webhooks/${webhookId}`, "GET", undefined, viewerCookie),
      { params: Promise.resolve({ id: webhookId }) }
    );
    assertStatus(webhookRead, 200, "Viewer read webhook");
    const webhookPatchDenied = await webhookItem.PATCH(
      request(`/api/admin/webhooks/${webhookId}`, "PATCH", { name: "nope" }, viewerCookie),
      { params: Promise.resolve({ id: webhookId }) }
    );
    assertStatus(webhookPatchDenied, 403, "Viewer patch webhook");
    const webhookPatch = await webhookItem.PATCH(
      request(`/api/admin/webhooks/${webhookId}`, "PATCH", { name: `rbac-hook-updated-${suffix}` }, adminCookie),
      { params: Promise.resolve({ id: webhookId }) }
    );
    assertStatus(webhookPatch, 200, "Admin patch webhook");

    const regenDenied = await regenWebhookSecret(
      request(`/api/admin/webhooks/${webhookId}/regenerate-secret`, "POST", undefined, viewerCookie),
      { params: Promise.resolve({ id: webhookId }) }
    );
    assertStatus(regenDenied, 403, "Viewer regenerate webhook secret");
    const regenAllowed = await regenWebhookSecret(
      request(`/api/admin/webhooks/${webhookId}/regenerate-secret`, "POST", undefined, adminCookie),
      { params: Promise.resolve({ id: webhookId }) }
    );
    assertStatus(regenAllowed, 200, "Admin regenerate webhook secret");
    assert.ok((await json(regenAllowed)).data.signingSecret, "New signing secret returned");

    const webhookDeleteDenied = await webhookItem.DELETE(
      request(`/api/admin/webhooks/${webhookId}`, "DELETE", undefined, viewerCookie),
      { params: Promise.resolve({ id: webhookId }) }
    );
    assertStatus(webhookDeleteDenied, 403, "Viewer delete webhook");
    const webhookDelete = await webhookItem.DELETE(
      request(`/api/admin/webhooks/${webhookId}`, "DELETE", undefined, adminCookie),
      { params: Promise.resolve({ id: webhookId }) }
    );
    assertStatus(webhookDelete, 200, "Admin delete webhook");
    webhookId = "";

    console.log("13. Password reset invalidates old sessions and changes login credential");
    const reset = await users.PATCH(request("/api/admin/users", "PATCH", { id: viewerRecord!.id, password: resetPassword }, adminCookie));
    assertStatus(reset, 200, "Reset viewer password");
    const oldViewerMe = await me(request("/api/auth/me", "GET", undefined, viewerCookie));
    assertStatus(oldViewerMe, 401, "Old viewer session after password reset");
    const oldPasswordLogin = await loginAs(viewerEmail, viewerPassword);
    assertStatus(oldPasswordLogin.res, 401, "Old password after reset");
    const newPasswordLogin = await loginAs(viewerEmail, resetPassword);
    assertStatus(newPasswordLogin.res, 200, "New password after reset");
    viewerCookie = newPasswordLogin.cookie;

    console.log("14. Role promotion invalidates viewer session; promoted user can re-login as admin");
    const promote = await users.PATCH(request("/api/admin/users", "PATCH", { id: viewerRecord!.id, role: "ADMIN" }, adminCookie));
    assertStatus(promote, 200, "Promote viewer");
    assertStatus(await me(request("/api/auth/me", "GET", undefined, viewerCookie)), 401, "Old session after promotion");
    const promotedLogin = await loginAs(viewerEmail, resetPassword);
    assertStatus(promotedLogin.res, 200, "Promoted admin login");
    viewerCookie = promotedLogin.cookie;
    assert.equal((await json(await me(request("/api/auth/me", "GET", undefined, viewerCookie)))).data.role, "ADMIN");

    console.log("15. Demotion invalidates admin session");
    const demote = await users.PATCH(request("/api/admin/users", "PATCH", { id: viewerRecord!.id, role: "VIEWER" }, adminCookie));
    assertStatus(demote, 200, "Demote admin");
    assertStatus(await me(request("/api/auth/me", "GET", undefined, viewerCookie)), 401, "Old session after demotion");
    const demotedLogin = await loginAs(viewerEmail, resetPassword);
    assertStatus(demotedLogin.res, 200, "Demoted viewer login");
    viewerCookie = demotedLogin.cookie;
    assert.equal((await json(await me(request("/api/auth/me", "GET", undefined, viewerCookie)))).data.role, "VIEWER");

    console.log("16. Deactivation invalidates active session and blocks login");
    const disable = await users.PATCH(request("/api/admin/users", "PATCH", { id: viewerRecord!.id, active: false }, adminCookie));
    assertStatus(disable, 200, "Disable viewer");
    assertStatus(await me(request("/api/auth/me", "GET", undefined, viewerCookie)), 401, "Disabled user's existing session");
    const disabledLogin = await loginAs(viewerEmail, resetPassword);
    assertStatus(disabledLogin.res, 401, "Disabled account login");
    const enable = await users.PATCH(request("/api/admin/users", "PATCH", { id: viewerRecord!.id, active: true }, adminCookie));
    assertStatus(enable, 200, "Enable viewer");

    console.log("17. Account deletion blocks future login");
    const deleteViewer = await users.DELETE(request(`/api/admin/users?id=${encodeURIComponent(viewerRecord!.id)}`, "DELETE", undefined, adminCookie));
    assertStatus(deleteViewer, 200, "Delete viewer");
    assert.equal(await prisma.user.findUnique({ where: { id: viewerRecord!.id } }), null);
    const deletedLogin = await loginAs(viewerEmail, resetPassword);
    assertStatus(deletedLogin.res, 401, "Deleted account login");

    console.log("18. Self lockout protection & Last admin protection");
    for (const patch of [
      { id: admin.id, role: "VIEWER" },
      { id: admin.id, active: false },
    ]) {
      assertStatus(await users.PATCH(request("/api/admin/users", "PATCH", patch, adminCookie)), 400, "Self lockout patch");
    }
    assertStatus(await users.DELETE(request(`/api/admin/users?id=${admin.id}`, "DELETE", undefined, adminCookie)), 400, "Self delete");

    // Last admin protection:
    // Create a 3rd temporary admin:
    const tempAdminEmail = `rbac-admin3-${suffix}@example.test`;
    const tempAdminRes = await users.POST(request("/api/admin/users", "POST", { email: tempAdminEmail, password: adminPassword, role: "ADMIN" }, adminCookie));
    assertStatus(tempAdminRes, 201, "Create 3rd admin");
    const tempAdminId = (await json(tempAdminRes)).data.id;

    // Demoting secondary admin when other admins exist succeeds:
    const demoteSecondary = await users.PATCH(request("/api/admin/users", "PATCH", { id: secondaryAdminId, role: "VIEWER" }, adminCookie));
    assertStatus(demoteSecondary, 200, "Demote secondary admin when multiple admins exist");

    // Deleting temp admin leaves only 1 active admin (`admin`):
    const delTemp = await users.DELETE(request(`/api/admin/users?id=${tempAdminId}`, "DELETE", undefined, adminCookie));
    assertStatus(delTemp, 200, "Delete temp admin when multiple admins exist");

    // Now `admin` is the sole active ADMIN in the database!
    // Sole admin cannot be demoted, disabled, or deleted:
    const demoteSole = await users.PATCH(request("/api/admin/users", "PATCH", { id: admin.id, role: "VIEWER" }, adminCookie));
    assertStatus(demoteSole, 400, "Sole admin cannot be demoted");

    const disableSole = await users.PATCH(request("/api/admin/users", "PATCH", { id: admin.id, active: false }, adminCookie));
    assertStatus(disableSole, 400, "Sole admin cannot be disabled");

    const deleteSole = await users.DELETE(request(`/api/admin/users?id=${admin.id}`, "DELETE", undefined, adminCookie));
    assertStatus(deleteSole, 400, "Sole admin cannot be deleted");

    console.log("18b. Last-Admin Concurrency: Genuine Two-Admin Race Test");

    // Pre-race safety check: verify database is an isolated disposable test target
    const preExistingAdmins = await prisma.user.findMany({ where: { role: "ADMIN", active: true } });
    const unexpectedNonTestAdmins = preExistingAdmins.filter((u) => !u.email.startsWith("rbac-"));
    if (unexpectedNonTestAdmins.length > 0) {
      throw new Error(
        `\n⛔ [SAFETY GATE TRIGGERED] Cannot execute two-admin race test: found ${unexpectedNonTestAdmins.length} pre-existing active non-test administrator(s).\n` +
        `The genuine two-admin race test requires an isolated disposable database with no pre-existing real admins.\n`
      );
    }

    // Demote or delete any existing test admins from earlier steps (like `admin`)
    // so we can initialize the race with EXACTLY TWO active ADMIN users.
    // To respect sole-admin protection, we first create Race Admin A & B, then demote/delete the earlier admin.
    const raceIterations = 3;
    console.log(`   Running ${raceIterations} iterations of concurrent DELETE-vs-DELETE with exactly 2 active admins...`);

    for (let iter = 1; iter <= raceIterations; iter++) {
      const iterRunId = crypto.randomBytes(4).toString("hex");
      const emailA = `rbac-race-${iterRunId}-a@example.test`;
      const emailB = `rbac-race-${iterRunId}-b@example.test`;
      const passA = `RacePassA!${crypto.randomBytes(8).toString("hex")}`;
      const passB = `RacePassB!${crypto.randomBytes(8).toString("hex")}`;
      const hashA = await hashPasswordForStorage(passA);
      const hashB = await hashPasswordForStorage(passB);

      // 1. Create Race Admin A and Race Admin B
      const raceA = await prisma.user.create({
        data: { email: emailA, passwordHash: hashA, role: "ADMIN", active: true },
      });
      const raceB = await prisma.user.create({
        data: { email: emailB, passwordHash: hashB, role: "ADMIN", active: true },
      });

      // 2. Safe cleanup: Verify no unexpected non-test administrators exist in the database.
      // A test must never destroy data it cannot prove belongs to itself.
      const unexpectedAdmins = await prisma.user.findMany({
        where: {
          role: "ADMIN",
          active: true,
          NOT: {
            email: {
              startsWith: "rbac-",
              endsWith: "@example.test",
            },
          },
        },
      });
      if (unexpectedAdmins.length > 0) {
        throw new Error(
          `ABORT: Unexpected pre-existing administrator(s) found in database (${unexpectedAdmins.length} unknown admin(s)). Destructive test will not delete unknown administrators.`
        );
      }

      // Safe cleanup of ONLY test-generated admins from previous steps/iterations:
      const priorTestAdmins = await prisma.user.findMany({
        where: {
          role: "ADMIN",
          active: true,
          email: { startsWith: "rbac-", endsWith: "@example.test" },
          id: { notIn: [raceA.id, raceB.id] },
        },
      });
      for (const prior of priorTestAdmins) {
        await prisma.userSession.deleteMany({ where: { userId: prior.id } });
        await prisma.user.delete({ where: { id: prior.id } });
      }

      // 3. ASSERT: The entire database now contains EXACTLY TWO active ADMIN users!
      const activeAdminsBefore = await prisma.user.findMany({
        where: { role: "ADMIN", active: true },
      });
      assert.equal(
        activeAdminsBefore.length,
        2,
        `Iteration ${iter}: Active ADMIN count must be EXACTLY 2 before race. Found: ${activeAdminsBefore.length}`
      );
      assert.equal(
        activeAdminsBefore.map((u) => u.id).sort().join(","),
        [raceA.id, raceB.id].sort().join(","),
        `Iteration ${iter}: The only 2 active admins must be race participants A and B`
      );

      // 4. Authenticate both race participants with independent authenticated sessions
      const loginA = await loginAs(emailA, passA);
      assertStatus(loginA.res, 200, `Iteration ${iter}: Admin A login`);
      const cookieA = loginA.cookie;
      assert.ok(cookieA, `Iteration ${iter}: Admin A cookie`);

      const loginB = await loginAs(emailB, passB);
      assertStatus(loginB.res, 200, `Iteration ${iter}: Admin B login`);
      const cookieB = loginB.cookie;
      assert.ok(cookieB, `Iteration ${iter}: Admin B cookie`);

      // Verify both authenticated sessions work
      assert.equal((await json(await me(request("/api/auth/me", "GET", undefined, cookieA)))).data.role, "ADMIN");
      assert.equal((await json(await me(request("/api/auth/me", "GET", undefined, cookieB)))).data.role, "ADMIN");

      // 5. LAUNCH THE PRIMARY RACE:
      // Request A: Admin A attempts to DELETE Admin B
      // Request B: Admin B attempts to DELETE Admin A
      // Both requests are launched concurrently via Promise.all
      const [resDelA, resDelB] = await Promise.all([
        users.DELETE(request(`/api/admin/users?id=${raceB.id}`, "DELETE", undefined, cookieA)),
        users.DELETE(request(`/api/admin/users?id=${raceA.id}`, "DELETE", undefined, cookieB)),
      ]);

      const aWon = resDelA.status === 200;
      const bWon = resDelB.status === 200;

      // Invariant 1: Exactly ONE succeeds. Under NO circumstances may both succeed!
      assert.notEqual(
        aWon && bWon,
        true,
        `Iteration ${iter}: CRITICAL REGRESSION: Both concurrent DELETE requests succeeded! Active admin count dropped to zero!`
      );
      assert.equal(
        (aWon && !bWon) || (!aWon && bWon),
        true,
        `Iteration ${iter}: Exactly one DELETE must succeed. A result: ${resDelA.status}, B result: ${resDelB.status}`
      );

      // Verify the losing request was properly rejected
      const losingRes = aWon ? resDelB : resDelA;
      assert.ok(
        losingRes.status === 400 || losingRes.status === 401,
        `Iteration ${iter}: Losing request must be rejected with 400 (LAST_ADMIN_PROTECTION) or 401 (cascaded session). Got ${losingRes.status}`
      );
      if (losingRes.status === 400) {
        const losingBody = await json(losingRes);
        assert.equal(
          losingBody.error?.code,
          "LAST_ADMIN_PROTECTION",
          `Iteration ${iter}: Expected error code LAST_ADMIN_PROTECTION, got ${losingBody.error?.code}`
        );
      }

      // Invariant 2: Exactly ONE active ADMIN remains in the database. Active admin count >= 1 invariant holds!
      const activeAdminsAfter = await prisma.user.findMany({
        where: { role: "ADMIN", active: true },
      });
      assert.equal(
        activeAdminsAfter.length,
        1,
        `Iteration ${iter}: CRITICAL INVARIANT: Exactly 1 active admin must remain in DB! Found: ${activeAdminsAfter.length}`
      );

      const survivingAdmin = activeAdminsAfter[0];
      const expectedSurvivingId = aWon ? raceA.id : raceB.id;
      assert.equal(survivingAdmin.id, expectedSurvivingId, `Iteration ${iter}: Surviving admin must match winning requester`);
      assert.equal(survivingAdmin.active, true);
      assert.equal(survivingAdmin.role, "ADMIN");

      // Invariant 3: The surviving admin remains usable
      const survivingCookie = aWon ? cookieA : cookieB;
      const survivingMe = await me(request("/api/auth/me", "GET", undefined, survivingCookie));
      assertStatus(survivingMe, 200, `Iteration ${iter}: Surviving admin session must remain valid`);

      // Invariant 4: The deleted admin is completely removed and has no platform access
      const deletedAdminId = aWon ? raceB.id : raceA.id;
      const deletedRecord = await prisma.user.findUnique({ where: { id: deletedAdminId } });
      assert.equal(deletedRecord, null, `Iteration ${iter}: Deleted admin row must not exist in DB`);
      const deletedSessions = await prisma.userSession.count({ where: { userId: deletedAdminId } });
      assert.equal(deletedSessions, 0, `Iteration ${iter}: Deleted admin sessions must be cascaded`);
      const deletedCookie = aWon ? cookieB : cookieA;
      const deletedMe = await me(request("/api/auth/me", "GET", undefined, deletedCookie));
      assertStatus(deletedMe, 401, `Iteration ${iter}: Deleted admin cannot authenticate with previous session`);

      console.log(`   Iteration ${iter}: PASS (Winner: ${aWon ? "Admin A" : "Admin B"}, Loser rejected with ${losingRes.status}, Surviving admins in DB: 1)`);
    }

    // Optional Secondary Race: Demote vs Disable with EXACTLY TWO active admins
    console.log("   Testing secondary concurrent race: Demote-vs-Disable with exactly 2 active admins...");
    {
      const secRunId = crypto.randomBytes(4).toString("hex");
      const emailC = `rbac-race-${secRunId}-c@example.test`;
      const emailD = `rbac-race-${secRunId}-d@example.test`;
      const passC = `RacePassC!${crypto.randomBytes(8).toString("hex")}`;
      const passD = `RacePassD!${crypto.randomBytes(8).toString("hex")}`;
      const hashC = await hashPasswordForStorage(passC);
      const hashD = await hashPasswordForStorage(passD);

      const raceC = await prisma.user.create({
        data: { email: emailC, passwordHash: hashC, role: "ADMIN", active: true },
      });
      const raceD = await prisma.user.create({
        data: { email: emailD, passwordHash: hashD, role: "ADMIN", active: true },
      });

      // Safe cleanup: Verify no unexpected non-test administrators exist in the database.
      const unexpectedSecondaryAdmins = await prisma.user.findMany({
        where: {
          role: "ADMIN",
          active: true,
          NOT: {
            email: {
              startsWith: "rbac-",
              endsWith: "@example.test",
            },
          },
        },
      });
      if (unexpectedSecondaryAdmins.length > 0) {
        throw new Error(
          `ABORT: Unexpected pre-existing administrator(s) found in database (${unexpectedSecondaryAdmins.length} unknown admin(s)). Destructive test will not delete unknown administrators.`
        );
      }

      // Safe cleanup of ONLY test-generated admins from previous steps:
      const priorSecondaryTestAdmins = await prisma.user.findMany({
        where: {
          role: "ADMIN",
          active: true,
          email: { startsWith: "rbac-", endsWith: "@example.test" },
          id: { notIn: [raceC.id, raceD.id] },
        },
      });
      for (const prior of priorSecondaryTestAdmins) {
        await prisma.userSession.deleteMany({ where: { userId: prior.id } });
        await prisma.user.delete({ where: { id: prior.id } });
      }

      const activeBeforeMutations = await prisma.user.findMany({ where: { role: "ADMIN", active: true } });
      assert.equal(activeBeforeMutations.length, 2, "Must start secondary race with exactly 2 active admins");

      const loginC = await loginAs(emailC, passC);
      const cookieC = loginC.cookie;
      const loginD = await loginAs(emailD, passD);
      const cookieD = loginD.cookie;

      // Admin C attempts to DEMOTE Admin D to VIEWER
      // Admin D attempts to DISABLE Admin C (active: false)
      const [resPatchC, resPatchD] = await Promise.all([
        users.PATCH(request("/api/admin/users", "PATCH", { id: raceD.id, role: "VIEWER" }, cookieC)),
        users.PATCH(request("/api/admin/users", "PATCH", { id: raceC.id, active: false }, cookieD)),
      ]);

      const cWon = resPatchC.status === 200;
      const dWon = resPatchD.status === 200;

      assert.notEqual(cWon && dWon, true, "CRITICAL REGRESSION: Both concurrent mutations succeeded! Active admin count dropped to zero!");
      assert.equal((cWon && !dWon) || (!cWon && dWon), true, `Exactly one mutation must succeed. C: ${resPatchC.status}, D: ${resPatchD.status}`);

      const losingPatchRes = cWon ? resPatchD : resPatchC;
      assert.equal(losingPatchRes.status, 400, `Losing mutation must return 400, got ${losingPatchRes.status}`);
      const losingPatchBody = await json(losingPatchRes);
      assert.equal(losingPatchBody.error?.code, "LAST_ADMIN_PROTECTION", `Expected LAST_ADMIN_PROTECTION code`);

      const activeAdminsAfterMutations = await prisma.user.count({ where: { role: "ADMIN", active: true } });
      assert.equal(activeAdminsAfterMutations, 1, `CRITICAL INVARIANT: Exactly 1 active admin must remain in DB! Found: ${activeAdminsAfterMutations}`);

      console.log(`   Secondary race: PASS (Winner: ${cWon ? "Admin C demoted D" : "Admin D disabled C"}, Loser rejected with 400 LAST_ADMIN_PROTECTION, Surviving admins in DB: 1)`);
    }

    // Recreate the standard test admin so subsequent phases (logout, rate-limit) operate normally
    const restoredAdmin = await prisma.user.create({
      data: { email: adminEmail, passwordHash: await hashPasswordForStorage(adminPassword), role: "ADMIN", active: true },
    });
    adminId = restoredAdmin.id;
    const restoredLogin = await loginAs(adminEmail, adminPassword);
    assertStatus(restoredLogin.res, 200, "Restore test admin login");
    adminCookie = restoredLogin.cookie;


    console.log("19. Logout invalidates session");
    const logoutRes = await logout(request("/api/auth/logout", "POST", undefined, adminCookie));
    assertStatus(logoutRes, 200, "Logout");
    assertStatus(await me(request("/api/auth/me", "GET", undefined, adminCookie)), 401, "Session after logout");

    console.log("20. Login rate limiting");
    await prisma.rateLimit.deleteMany({ where: { key: "login:unknown" } });
    const rateIp = `rbac-rate-${suffix}`;
    for (let i = 0; i < 10; i++) {
      const bad = await loginAs(adminEmail, "definitely-wrong", rateIp);
      assertStatus(bad.res, 401, `Rate-limit attempt ${i + 1}`);
    }
    const rateLimited = await loginAs(adminEmail, "definitely-wrong", rateIp);
    assertStatus(rateLimited.res, 429, "Rate limit boundary");

    console.log("21. Auth table RLS and privilege checks");
    const rls = await prisma.$queryRawUnsafe(`
      SELECT c.relname AS table_name, c.relrowsecurity AS rls_enabled
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname IN ('User', 'UserSession')
      ORDER BY c.relname;
    `);
    assert.equal((rls as Array<{table_name:string;rls_enabled:boolean}>).every(x => x.rls_enabled), true);
    const broadGrants = await prisma.$queryRawUnsafe(`
      SELECT grantee, table_name
      FROM information_schema.role_table_grants
      WHERE grantee IN ('anon','authenticated') AND table_name IN ('User','UserSession');
    `);
    assert.equal((broadGrants as unknown[]).length, 0);

    console.log("\n✅ RBAC TEST SUITE PASSED: authentication, sessions, roles, user lifecycle, admin/read-only separation, existing admin APIs, invalidation, RLS, and rate limiting.");
  } finally {
    try {
      console.log("Cleaning up RBAC test artifacts...");
      if (webhookId) await prisma.webhookEndpoint.deleteMany({ where: { id: webhookId } });
      if (apiClientId) {
        await prisma.webhookDelivery.deleteMany({ where: { clientId: apiClientId } });
        await prisma.webhookEndpoint.deleteMany({ where: { clientId: apiClientId } });
        await prisma.messageEvent.deleteMany({ where: { clientId: apiClientId } });
        await prisma.message.deleteMany({ where: { clientId: apiClientId } });
        await prisma.apiKey.deleteMany({ where: { clientId: apiClientId } });
        await prisma.apiClient.deleteMany({ where: { id: apiClientId } });
      }
      if (adminId) await prisma.userSession.deleteMany({ where: { userId: adminId } });
      if (secondaryAdminId) await prisma.userSession.deleteMany({ where: { userId: secondaryAdminId } });
      // Delete any test sessions for rbac test users
      await prisma.userSession.deleteMany({
        where: {
          user: {
            email: {
              startsWith: "rbac-",
              endsWith: "@example.test",
            },
          },
        },
      });
      // Delete all test users created by rbac verification
      await prisma.user.deleteMany({
        where: {
          email: {
            startsWith: "rbac-",
            endsWith: "@example.test",
          },
        },
      });
      // Verify no leftover test users remain in database
      const leftoverCount = await prisma.user.count({
        where: {
          email: {
            startsWith: "rbac-",
            endsWith: "@example.test",
          },
        },
      });
      if (leftoverCount > 0) {
        throw new Error(`Leftover test users detected in database: ${leftoverCount} rows remain!`);
      }
      console.log("RBAC test cleanup verified: 0 test users remain.");
    } finally {
      await prisma.$disconnect();
    }
  }
}


main().catch((error) => {
  console.error("\n❌ RBAC TEST SUITE FAILED");
  console.error(error);
  process.exitCode = 1;
});
