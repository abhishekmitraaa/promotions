import assert from "node:assert/strict";
import crypto from "node:crypto";

process.env.NODE_ENV = process.env.NODE_ENV || "test";
process.env.AUTH_SESSION_SECRET ||= "rbac-test-session-secret-32-characters-minimum";
process.env.API_KEY_PEPPER ||= "rbac-test-api-key-pepper-32-characters-min";
process.env.WEBHOOK_SECRET_ENCRYPTION_KEY ||= "rbac-test-webhook-key-32-characters-min";

type AnyResponse = Response & { cookies?: { get(name: string): { value: string } | undefined } };

async function main() {
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
  const webhookDeliveries = await import("../src/app/api/admin/webhooks/deliveries/route");
  const sendMessage = (await import("../src/app/api/admin/messages/send/route")).POST;
  const cleanup = (await import("../src/app/api/admin/clean-data/route")).POST;
  const queue = (await import("../src/app/api/admin/webhooks/process-queue/route")).POST;
  const middleware = (await import("../src/middleware")).middleware;

  const suffix = crypto.randomBytes(5).toString("hex");
  const adminEmail = `rbac-admin-${suffix}@example.test`;
  const viewerEmail = `rbac-viewer-${suffix}@example.test`;
  const adminPassword = `Admin!${crypto.randomBytes(12).toString("hex")}`;
  const viewerPassword = `Viewer!${crypto.randomBytes(12).toString("hex")}`;
  const resetPassword = `Reset!${crypto.randomBytes(12).toString("hex")}`;

  let adminCookie = "";
  let viewerCookie = "";
  let apiClientId = "";
  let apiKeyId = "";
  let webhookId = "";

  const request = (url: string, method = "GET", body?: unknown, cookie = "") =>
    new NextRequest(`http://localhost:3000${url}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(cookie ? { cookie: `${SESSION_COOKIE}=${encodeURIComponent(cookie)}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  const json = async (res: Response) => {
    const data = await res.json();
    return data;
  };

  const loginAs = async (email: string, password: string, ip = crypto.randomBytes(4).toString("hex")) => {
    const res = await login(request("/api/auth/login", "POST", { email, password, ip }));
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

    console.log("2. Session token integrity, dotted emails, tampering");
    const tokenInfo = createSessionToken({ id: "u-test", email: adminEmail, role: "ADMIN" });
    assert.equal(verifySessionTokenNode(tokenInfo.token)?.email, adminEmail);
    assert.equal(verifySessionTokenNode(tokenInfo.token)?.role, "ADMIN");
    const [encoded, signature] = tokenInfo.token.split(".");
    const tampered = `${encoded}.${signature.slice(0, -1)}x`;
    assert.equal(verifySessionTokenNode(tampered), null);

    console.log("3. Database user creation stores only password hash");
    const admin = await prisma.user.create({
      data: { email: adminEmail, passwordHash, role: "ADMIN", active: true },
    });
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
    }));
    assertStatus(createViewer, 201, "Create viewer");
    const viewerRecord = await prisma.user.findUnique({ where: { email: viewerEmail } });
    assert.ok(viewerRecord);
    assert.equal(viewerRecord?.role, "VIEWER");
    assert.equal(viewerRecord?.passwordHash === viewerPassword, false);

    console.log("6. Validation: weak password and duplicate email");
    const weak = await users.POST(request("/api/admin/users", "POST", {
      email: `weak-${suffix}@example.test`, password: "short", role: "VIEWER"
    }));
    assertStatus(weak, 400, "Weak password");
    const duplicate = await users.POST(request("/api/admin/users", "POST", {
      email: viewerEmail, password: viewerPassword, role: "VIEWER"
    }));
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
      ["create api key", apiKeys.POST(request("/api/admin/api-keys", "POST", { clientName: `blocked-${suffix}` }, viewerCookie))],
      ["send message", sendMessage(request("/api/admin/messages/send", "POST", { to: "919876543210", type: "text", body: "blocked" }, viewerCookie))],
      ["create webhook", webhooks.POST(request("/api/admin/webhooks", "POST", { name: "blocked", url: "https://example.com/hook", subscribedEvents: ["*"] }, viewerCookie))],
      ["retry delivery", webhookDeliveries.POST(request("/api/admin/webhooks/deliveries", "POST", { deliveryId: "missing" }, viewerCookie))],
      ["cleanup", cleanup(request("/api/admin/clean-data", "POST", { confirm: "NO" }, viewerCookie))],
      ["process queue", queue(request("/api/admin/webhooks/process-queue", "POST", undefined, viewerCookie))],
    ];
    for (const [label, p] of denied) assertStatus(await p, 403, `Viewer ${label}`);

    console.log("9. Middleware unauthenticated redirect and viewer mutation block");
    const unauthDashboard = await middleware(request("/dashboard"));
    assert.equal(unauthDashboard.status, 307);
    const viewerMutation = await middleware(request("/api/admin/users", "POST", {}, viewerCookie));
    assert.equal(viewerMutation.status, 403);
    const viewerDashboard = await middleware(request("/dashboard", "GET", undefined, viewerCookie));
    assert.equal(viewerDashboard.status, 200);

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

    console.log("12. Admin webhook create/read/update/delete");
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

    console.log("18. Self lockout protection");
    for (const patch of [
      { id: admin.id, role: "VIEWER" },
      { id: admin.id, active: false },
    ]) {
      assertStatus(await users.PATCH(request("/api/admin/users", "PATCH", patch, adminCookie)), 400, "Self lockout patch");
    }
    assertStatus(await users.DELETE(request(`/api/admin/users?id=${admin.id}`, "DELETE", undefined, adminCookie)), 400, "Self delete");

    console.log("19. Logout invalidates session");
    const logoutRes = await logout(request("/api/auth/logout", "POST", undefined, adminCookie));
    assertStatus(logoutRes, 200, "Logout");
    assertStatus(await me(request("/api/auth/me", "GET", undefined, adminCookie)), 401, "Session after logout");

    console.log("20. Login rate limiting");
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

    console.log("22. Cleanup test artifacts");
    if (webhookId) await prisma.webhookEndpoint.deleteMany({ where: { id: webhookId } });
    if (apiClientId) await prisma.webhookDelivery.deleteMany({ where: { clientId: apiClientId } });
    if (apiClientId) await prisma.webhookEndpoint.deleteMany({ where: { clientId: apiClientId } });
    if (apiClientId) await prisma.messageEvent.deleteMany({ where: { clientId: apiClientId } });
    if (apiClientId) await prisma.message.deleteMany({ where: { clientId: apiClientId } });
    if (apiClientId) await prisma.apiKey.deleteMany({ where: { clientId: apiClientId } });
    if (apiClientId) await prisma.apiClient.deleteMany({ where: { id: apiClientId } });
    await prisma.userSession.deleteMany({ where: { userId: admin.id } });
    await prisma.user.deleteMany({ where: { id: admin.id } });

    console.log("\n✅ RBAC TEST SUITE PASSED: authentication, sessions, roles, user lifecycle, admin/read-only separation, existing admin APIs, invalidation, RLS, and rate limiting.");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error("\n❌ RBAC TEST SUITE FAILED");
  console.error(error);
  process.exitCode = 1;
});
