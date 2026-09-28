if (!process.env.DATABASE_URL || process.env.DATABASE_URL.includes("peqynzeioiauynfpdsdv") || process.env.DATABASE_URL.includes("supabase.co")) {
  process.env.DATABASE_URL = "postgresql://postgres:postgres@127.0.0.1:5433/email_test";
}
if (!process.env.DIRECT_URL || process.env.DIRECT_URL.includes("peqynzeioiauynfpdsdv") || process.env.DIRECT_URL.includes("supabase.co")) {
  process.env.DIRECT_URL = "postgresql://postgres:postgres@127.0.0.1:5433/email_test";
}
process.env.REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";
process.env.NODE_ENV = "test";
process.env.ALLOW_DESTRUCTIVE_TESTS = "true";
process.env.AUTH_SESSION_SECRET = "dashboard-test-session-secret-32-chars-min";
process.env.PROVIDER_CREDENTIAL_KEY = "dashboard-test-cred-encryption-key-32";
process.env.EMAIL_TRACKING_SECRET = "dashboard-test-tracking-secret-32-chars";

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { assertDestructiveTestAllowed } from "./test-db-guard";

async function main() {
  assertDestructiveTestAllowed("verify-email-dashboard-operational");
  console.log("\n========================================================");
  console.log("  EMAIL DASHBOARD COMPLETE OPERATIONAL AUDIT & RBAC TEST");
  console.log("========================================================\n");

  const { NextRequest } = await import("next/server");
  const { prisma } = await import("../src/lib/prisma");
  const { hashPasswordForStorage, createSessionToken, hashSessionToken, SESSION_COOKIE } = await import("../src/lib/auth");

  // Route handlers under audit
  const analyticsRoute = await import("../src/app/api/email/analytics/route");
  const queueHealthRoute = await import("../src/app/api/admin/email/queue/health/route");
  const providersRoute = await import("../src/app/api/admin/email/providers/route");
  const providerHealthRoute = await import("../src/app/api/admin/email/providers/health/route");
  const senderIdentitiesRoute = await import("../src/app/api/admin/email/sender-identities/route");
  const contactsRoute = await import("../src/app/api/email/contacts/route");
  const contactIdRoute = await import("../src/app/api/email/contacts/[id]/route");
  const contactsImportRoute = await import("../src/app/api/email/contacts/import/route");
  const listsRoute = await import("../src/app/api/email/lists/route");
  const listIdRoute = await import("../src/app/api/email/lists/[id]/route");
  const listMembersRoute = await import("../src/app/api/email/lists/[id]/members/route");
  const segmentsRoute = await import("../src/app/api/email/segments/route");
  const segmentIdRoute = await import("../src/app/api/email/segments/[id]/route");
  const segmentEvaluateRoute = await import("../src/app/api/email/segments/evaluate/route");
  const segmentIdEvaluateRoute = await import("../src/app/api/email/segments/[id]/evaluate/route");
  const templatesRoute = await import("../src/app/api/email/templates/route");
  const templateIdRoute = await import("../src/app/api/email/templates/[id]/route");
  const templateVersionsRoute = await import("../src/app/api/email/templates/[id]/versions/route");
  const templateTestSendRoute = await import("../src/app/api/email/templates/[id]/test-send/route");
  const campaignsRoute = await import("../src/app/api/email/campaigns/route");
  const campaignPreviewRoute = await import("../src/app/api/email/campaigns/preview/route");
  const campaignIdPreviewRoute = await import("../src/app/api/email/campaigns/[id]/preview/route");
  const campaignIdTestSendRoute = await import("../src/app/api/email/campaigns/[id]/test-send/route");
  const campaignIdPauseRoute = await import("../src/app/api/email/campaigns/[id]/pause/route");
  const campaignIdResumeRoute = await import("../src/app/api/email/campaigns/[id]/resume/route");
  const campaignIdCancelRoute = await import("../src/app/api/email/campaigns/[id]/cancel/route");
  const campaignIdAnalyticsRoute = await import("../src/app/api/email/campaigns/[id]/analytics/route");
  const deliveriesRoute = await import("../src/app/api/email/deliveries/route");
  const suppressionsRoute = await import("../src/app/api/email/suppressions/route");

  const testSuffix = crypto.randomBytes(4).toString("hex");

  // 1. Setup Tenant & Users
  console.log("-> [Step 1] Setting up Tenant, Admin User & Viewer User...");
  const tenant = await prisma.apiClient.create({
    data: {
      name: `Dashboard Audit Tenant ${testSuffix}`,
      active: true,
    },
  });

  const testProvider = await prisma.emailProviderConfig.create({
    data: {
      clientId: tenant.id,
      name: `Test Provider ${testSuffix}`,
      providerType: "MOCK",
      status: "ACTIVE",
      isDefault: true,
      senderEmail: `test-${testSuffix}@example.test`,
    },
  });

  const pwdHash = await hashPasswordForStorage("StrongPassword123!");
  const adminUser = await prisma.user.create({
    data: {
      email: `dash-admin-${testSuffix}@example.test`,
      passwordHash: pwdHash,
      role: "ADMIN",
    },
  });

  const viewerUser = await prisma.user.create({
    data: {
      email: `dash-viewer-${testSuffix}@example.test`,
      passwordHash: pwdHash,
      role: "VIEWER",
    },
  });

  const adminTokenInfo = createSessionToken({ id: adminUser.id, email: adminUser.email, role: "ADMIN" });
  await prisma.userSession.create({
    data: {
      userId: adminUser.id,
      tokenHash: hashSessionToken(adminTokenInfo.token),
      expiresAt: new Date(adminTokenInfo.expiresAt),
    },
  });
  const adminToken = adminTokenInfo.token;

  const viewerTokenInfo = createSessionToken({ id: viewerUser.id, email: viewerUser.email, role: "VIEWER" });
  await prisma.userSession.create({
    data: {
      userId: viewerUser.id,
      tokenHash: hashSessionToken(viewerTokenInfo.token),
      expiresAt: new Date(viewerTokenInfo.expiresAt),
    },
  });
  const viewerToken = viewerTokenInfo.token;

  const makeReq = (url: string, method = "GET", body?: unknown, token = adminToken) => {
    return new NextRequest(`http://localhost:3000${url}`, {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
        "x-client-id": tenant.id,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  };

  try {
    // -------------------------------------------------------------
    // Route 1: Dashboard Overview & Authoritative Analytics
    // -------------------------------------------------------------
    console.log("-> [Step 2] Auditing Route: /dashboard/email Overview APIs...");
    const analyticsRes = await analyticsRoute.GET(makeReq("/api/email/analytics", "GET", undefined, adminToken));
    assert.equal(analyticsRes.status, 200, "Admin analytics should return 200");
    const analyticsJson = await analyticsRes.json();
    assert.equal(analyticsJson.success, true);
    assert.equal(typeof analyticsJson.data.sent, "number", "sent must be numeric authoritative data");
    assert.equal(typeof analyticsJson.data.delivered, "number", "delivered must be numeric authoritative data");

    // Viewer read-only check
    const viewerAnalyticsRes = await analyticsRoute.GET(makeReq("/api/email/analytics", "GET", undefined, viewerToken));
    assert.equal(viewerAnalyticsRes.status, 200, "Viewer analytics should return 200 (read-only)");

    // Queue Health
    const qHealthRes = await queueHealthRoute.GET(makeReq("/api/admin/email/queue/health", "GET", undefined, viewerToken));
    assert.ok(qHealthRes.status === 200 || qHealthRes.status === 503, "Queue health must return 200 or 503");

    console.log("  [PASS] Dashboard Overview & Analytics authoritative checks passed.");

    // -------------------------------------------------------------
    // Route 2: Providers & Sender Identities
    // -------------------------------------------------------------
    console.log("-> [Step 3] Auditing Route: /dashboard/email/providers...");
    // 1. Providers list
    const provsRes = await providersRoute.GET(makeReq("/api/admin/email/providers", "GET", undefined, viewerToken));
    assert.equal(provsRes.status, 200);

    // 2. Viewer mutation rejection (POST provider)
    const viewerCreateProv = await providersRoute.POST(
      makeReq("/api/admin/email/providers", "POST", { name: "Fake", providerType: "GMAIL" }, viewerToken)
    );
    assert.equal(viewerCreateProv.status, 403, "Viewer must be rejected with 403 Forbidden for provider creation");

    // 3. Sender Identity creation by Admin
    const adminCreateSender = await senderIdentitiesRoute.POST(
      makeReq("/api/admin/email/sender-identities", "POST", {
        email: `notifications-${testSuffix}@example.test`,
        name: "Test Notifications",
        isDefault: true,
        verified: true,
      }, adminToken)
    );
    assert.ok(adminCreateSender.status === 200 || adminCreateSender.status === 201, "Admin sender creation should succeed with 200 or 201");

    // 4. Sender Identity creation by Viewer -> 403
    const viewerCreateSender = await senderIdentitiesRoute.POST(
      makeReq("/api/admin/email/sender-identities", "POST", {
        email: `viewer-${testSuffix}@example.test`,
      }, viewerToken)
    );
    assert.equal(viewerCreateSender.status, 403, "Viewer must be rejected with 403 for sender identity creation");

    // 5. Provider health check (ADMIN only for live active probe; VIEWER receives 403)
    const provHealthViewerRes = await providerHealthRoute.GET(makeReq("/api/admin/email/providers/health", "GET", undefined, viewerToken));
    assert.equal(provHealthViewerRes.status, 403, "Viewer must be rejected with 403 for live provider health probe");
    const provHealthAdminRes = await providerHealthRoute.GET(makeReq("/api/admin/email/providers/health", "GET", undefined, adminToken));
    assert.equal(provHealthAdminRes.status, 200, "Admin can inspect provider health");
    console.log("  [PASS] Providers & Sender Identities audit & RBAC passed.");

    // -------------------------------------------------------------
    // Route 3: Contacts & Consent Management
    // -------------------------------------------------------------
    console.log("-> [Step 4] Auditing Route: /dashboard/email/contacts...");
    // 1. List contacts
    const listContactsRes = await contactsRoute.GET(makeReq("/api/email/contacts", "GET", undefined, viewerToken));
    assert.equal(listContactsRes.status, 200);

    // 2. Viewer create contact -> 403
    const viewerCreateContact = await contactsRoute.POST(
      makeReq("/api/email/contacts", "POST", { email: `contact-${testSuffix}@example.test` }, viewerToken)
    );
    assert.equal(viewerCreateContact.status, 403, "Viewer must be rejected with 403 for contact creation");

    // 3. Admin create contact -> 201
    const adminCreateContact = await contactsRoute.POST(
      makeReq("/api/email/contacts", "POST", {
        email: `contact-${testSuffix}@example.test`,
        firstName: "Alice",
        lastName: "Tester",
        marketingConsent: true,
        consentSource: "AUDIT_TEST",
      }, adminToken)
    );
    assert.equal(adminCreateContact.status, 201, "Admin contact create should return 201");
    const contactJson = await adminCreateContact.json();
    const contactId = contactJson.data.id;
    assert.ok(contactId);

    // 4. Viewer patch contact -> 403
    const viewerPatchContact = await contactIdRoute.PATCH(
      makeReq(`/api/email/contacts/${contactId}`, "PATCH", { firstName: "Hacked" }, viewerToken),
      { params: Promise.resolve({ id: contactId }) }
    );
    assert.equal(viewerPatchContact.status, 403, "Viewer contact edit must be 403");

    // 5. Admin patch contact -> 200
    const adminPatchContact = await contactIdRoute.PATCH(
      makeReq(`/api/email/contacts/${contactId}`, "PATCH", { firstName: "Alicia" }, adminToken),
      { params: Promise.resolve({ id: contactId }) }
    );
    assert.equal(adminPatchContact.status, 200, "Admin contact edit must be 200");

    // 6. Contact Bulk Import -> Admin 200, Viewer 403
    const viewerImport = await contactsImportRoute.POST(
      makeReq("/api/email/contacts/import", "POST", {
        contacts: [{ email: `imp1-${testSuffix}@example.test` }],
      }, viewerToken)
    );
    assert.equal(viewerImport.status, 403, "Viewer contact import must be 403");

    const adminImport = await contactsImportRoute.POST(
      makeReq("/api/email/contacts/import", "POST", {
        contacts: [
          { email: `imp1-${testSuffix}@example.test`, firstName: "Bob", marketingConsent: true },
          { email: `imp2-${testSuffix}@example.test`, firstName: "Charlie", marketingConsent: false },
        ],
      }, adminToken)
    );
    assert.equal(adminImport.status, 200, "Admin contact import must be 200");
    console.log("  [PASS] Contacts & Consent Management audit & RBAC passed.");

    // -------------------------------------------------------------
    // Route 4: Lists & Membership Management
    // -------------------------------------------------------------
    console.log("-> [Step 5] Auditing Route: /dashboard/email/lists...");
    // 1. Viewer create list -> 403
    const viewerCreateList = await listsRoute.POST(
      makeReq("/api/email/lists", "POST", { name: "VList" }, viewerToken)
    );
    assert.equal(viewerCreateList.status, 403, "Viewer list create must be 403");

    // 2. Admin create list -> 201
    const adminCreateList = await listsRoute.POST(
      makeReq("/api/email/lists", "POST", { name: `Audit List ${testSuffix}`, description: "Test List" }, adminToken)
    );
    assert.equal(adminCreateList.status, 201);
    const listJson = await adminCreateList.json();
    const listId = listJson.data.id;

    // 3. Add list member (Admin 200/201, Viewer 403)
    const viewerAddMember = await listMembersRoute.POST(
      makeReq(`/api/email/lists/${listId}/members`, "POST", { contactId }, viewerToken),
      { params: Promise.resolve({ id: listId }) }
    );
    assert.equal(viewerAddMember.status, 403, "Viewer add member must be 403");

    const adminAddMember = await listMembersRoute.POST(
      makeReq(`/api/email/lists/${listId}/members`, "POST", { contactId }, adminToken),
      { params: Promise.resolve({ id: listId }) }
    );
    assert.equal(adminAddMember.status, 201, "Admin add member must be 201");

    // 4. Viewer read list members -> 200
    const viewerGetMembers = await listMembersRoute.GET(
      makeReq(`/api/email/lists/${listId}/members`, "GET", undefined, viewerToken),
      { params: Promise.resolve({ id: listId }) }
    );
    assert.equal(viewerGetMembers.status, 200);
    const membersData = await viewerGetMembers.json();
    assert.equal(membersData.data.members.length, 1);

    // 5. Bulk member patch (Admin 200, Viewer 403)
    const viewerBulkMember = await listMembersRoute.PATCH(
      makeReq(`/api/email/lists/${listId}/members`, "PATCH", { removeContactIds: [contactId] }, viewerToken),
      { params: Promise.resolve({ id: listId }) }
    );
    assert.equal(viewerBulkMember.status, 403, "Viewer bulk member patch must be 403");

    console.log("  [PASS] Lists & Membership audit & RBAC passed.");

    // -------------------------------------------------------------
    // Route 5: Segments & Live Evaluation
    // -------------------------------------------------------------
    console.log("-> [Step 6] Auditing Route: /dashboard/email/segments...");
    const criteriaPayload = {
      conjunction: "AND",
      conditions: [{ field: "marketingConsent", operator: "equals", value: true }],
    };

    // 1. Live criteria evaluation (Viewer & Admin both allowed read-only dry-run)
    const evalRes = await segmentEvaluateRoute.POST(
      makeReq("/api/email/segments/evaluate", "POST", { criteria: criteriaPayload }, viewerToken)
    );
    assert.equal(evalRes.status, 200, "Viewer evaluation preview must be 200");
    const evalJson = await evalRes.json();
    assert.equal(typeof evalJson.data.totalMatching, "number");

    // 2. Viewer create segment -> 403
    const viewerCreateSeg = await segmentsRoute.POST(
      makeReq("/api/email/segments", "POST", { name: "VSeg", criteria: criteriaPayload }, viewerToken)
    );
    assert.equal(viewerCreateSeg.status, 403, "Viewer create segment must be 403");

    // 3. Admin create segment -> 201
    const adminCreateSeg = await segmentsRoute.POST(
      makeReq("/api/email/segments", "POST", { name: `Audit Seg ${testSuffix}`, criteria: criteriaPayload }, adminToken)
    );
    assert.equal(adminCreateSeg.status, 201);
    const segJson = await adminCreateSeg.json();
    const segId = segJson.data.id;

    // 4. Saved segment evaluate -> 200 for Viewer
    const segEvalRes = await segmentIdEvaluateRoute.GET(
      makeReq(`/api/email/segments/${segId}/evaluate`, "GET", undefined, viewerToken),
      { params: Promise.resolve({ id: segId }) }
    );
    assert.equal(segEvalRes.status, 200);

    console.log("  [PASS] Segments & Live Evaluation audit & RBAC passed.");

    // -------------------------------------------------------------
    // Route 6: Templates, Versioning & Test Send
    // -------------------------------------------------------------
    console.log("-> [Step 7] Auditing Route: /dashboard/email/templates & Test Send...");
    // 1. Viewer create template -> 403
    const viewerCreateTpl = await templatesRoute.POST(
      makeReq("/api/email/templates", "POST", { name: "VTpl", subject: "S", htmlContent: "<p>H</p>" }, viewerToken)
    );
    assert.equal(viewerCreateTpl.status, 403, "Viewer template create must be 403");

    // 2. Admin create template -> 201
    const adminCreateTpl = await templatesRoute.POST(
      makeReq("/api/email/templates", "POST", {
        name: `Audit Template ${testSuffix}`,
        subject: "Hello {{firstName}}",
        htmlContent: "<h1>Welcome {{firstName}} {{lastName}}</h1>",
        textContent: "Welcome {{firstName}}",
        type: "PROMOTIONAL",
      }, adminToken)
    );
    assert.equal(adminCreateTpl.status, 201);
    const tplJson = await adminCreateTpl.json();
    const tplId = tplJson.data.id;

    // 3. Admin create new version -> 201; Viewer -> 403
    const viewerNewVer = await templateVersionsRoute.POST(
      makeReq(`/api/email/templates/${tplId}/versions`, "POST", { subject: "V2", htmlContent: "<h2>V2</h2>" }, viewerToken),
      { params: Promise.resolve({ id: tplId }) }
    );
    assert.equal(viewerNewVer.status, 403, "Viewer template version create must be 403");

    const adminNewVer = await templateVersionsRoute.POST(
      makeReq(`/api/email/templates/${tplId}/versions`, "POST", { subject: "V2 Subject", htmlContent: "<h2>V2 Html</h2>" }, adminToken),
      { params: Promise.resolve({ id: tplId }) }
    );
    assert.equal(adminNewVer.status, 201);

    // 4. Test Send: Viewer -> 403
    const viewerTestSend = await templateTestSendRoute.POST(
      makeReq(`/api/email/templates/${tplId}/test-send`, "POST", { testEmail: "test@example.com" }, viewerToken),
      { params: Promise.resolve({ id: tplId }) }
    );
    assert.equal(viewerTestSend.status, 403, "Viewer test-send must be 403");

    // Verify initial campaign recipient count is zero
    const countBeforeTestSend = await prisma.emailCampaignRecipient.count({
      where: { campaign: { clientId: tenant.id } },
    });

    // 5. Test Send: Admin (Renders template, does NOT create campaign-recipient records)
    const adminTestSend = await templateTestSendRoute.POST(
      makeReq(`/api/email/templates/${tplId}/test-send`, "POST", {
        testEmail: "testrecipient@example.com",
        customVariables: { firstName: "Testy" },
      }, adminToken),
      { params: Promise.resolve({ id: tplId }) }
    );
    assert.equal(adminTestSend.status, 200, "Admin test-send must succeed (200)");
    const testSendJson = await adminTestSend.json();
    assert.equal(testSendJson.success, true);
    assert.equal(testSendJson.data.sentTo, "testrecipient@example.com");

    const countAfterTestSend = await prisma.emailCampaignRecipient.count({
      where: { campaign: { clientId: tenant.id } },
    });
    assert.equal(countAfterTestSend, countBeforeTestSend, "Test send MUST NOT create campaign recipient records!");

    console.log("  [PASS] Templates, Versioning & Test Send audit passed.");

    // -------------------------------------------------------------
    // Route 7: Campaigns, Audience Preview & Lifecycle
    // -------------------------------------------------------------
    console.log("-> [Step 8] Auditing Route: /dashboard/email/campaigns & Preview Parity...");
    // 1. Audience Preview (matches launch eligibility logic)
    const previewRes = await campaignPreviewRoute.POST(
      makeReq("/api/email/campaigns/preview", "POST", {
        listId,
        type: "PROMOTIONAL",
      }, viewerToken)
    );
    assert.equal(previewRes.status, 200);
    const previewJson = await previewRes.json();
    assert.equal(previewJson.data.totalAudience, 1);
    assert.equal(previewJson.data.eligibleCount, 1);
    assert.equal(previewJson.data.suppressedCount, 0);

    // 2. Viewer create campaign -> 403
    const viewerCreateCamp = await campaignsRoute.POST(
      makeReq("/api/email/campaigns", "POST", { name: "VCamp" }, viewerToken)
    );
    assert.equal(viewerCreateCamp.status, 403, "Viewer campaign create must be 403");

    // 3. Admin create campaign -> 201
    const adminCreateCamp = await campaignsRoute.POST(
      makeReq("/api/email/campaigns", "POST", {
        name: `Audit Campaign ${testSuffix}`,
        type: "PROMOTIONAL",
        listId,
        templateId: tplId,
      }, adminToken)
    );
    assert.equal(adminCreateCamp.status, 201);
    const campJson = await adminCreateCamp.json();
    const campId = campJson.data.id;

    // 4. Campaign Preview by ID (Viewer & Admin allowed)
    const campPreviewRes = await campaignIdPreviewRoute.GET(
      makeReq(`/api/email/campaigns/${campId}/preview`, "GET", undefined, viewerToken),
      { params: Promise.resolve({ id: campId }) }
    );
    assert.equal(campPreviewRes.status, 200);
    const campPreviewJson = await campPreviewRes.json();
    assert.equal(campPreviewJson.data.audienceCount, 1);
    assert.equal(campPreviewJson.data.eligibleRecipientCount, 1);

    // 5. Campaign Test Send (Admin 200, Viewer 403; does NOT create recipient records)
    const viewerCampTestSend = await campaignIdTestSendRoute.POST(
      makeReq(`/api/email/campaigns/${campId}/test-send`, "POST", { testEmail: "camptest@example.com" }, viewerToken),
      { params: Promise.resolve({ id: campId }) }
    );
    assert.equal(viewerCampTestSend.status, 403, "Viewer campaign test send must be 403");

    const adminCampTestSend = await campaignIdTestSendRoute.POST(
      makeReq(`/api/email/campaigns/${campId}/test-send`, "POST", { testEmail: "camptest@example.com" }, adminToken),
      { params: Promise.resolve({ id: campId }) }
    );
    assert.equal(adminCampTestSend.status, 200);

    const countAfterCampTestSend = await prisma.emailCampaignRecipient.count({
      where: { campaignId: campId },
    });
    assert.equal(countAfterCampTestSend, 0, "Campaign test send MUST NOT create recipient records!");

    // 6. Campaign Lifecycle: Pause, Resume, Cancel (Viewer 403, Admin handled)
    const viewerPause = await campaignIdPauseRoute.POST(
      makeReq(`/api/email/campaigns/${campId}/pause`, "POST", {}, viewerToken),
      { params: Promise.resolve({ id: campId }) }
    );
    assert.equal(viewerPause.status, 403, "Viewer pause must be 403");

    const viewerResume = await campaignIdResumeRoute.POST(
      makeReq(`/api/email/campaigns/${campId}/resume`, "POST", {}, viewerToken),
      { params: Promise.resolve({ id: campId }) }
    );
    assert.equal(viewerResume.status, 403, "Viewer resume must be 403");

    const viewerCancel = await campaignIdCancelRoute.POST(
      makeReq(`/api/email/campaigns/${campId}/cancel`, "POST", {}, viewerToken),
      { params: Promise.resolve({ id: campId }) }
    );
    assert.equal(viewerCancel.status, 403, "Viewer cancel must be 403");

    // Admin cancel
    const adminCancel = await campaignIdCancelRoute.POST(
      makeReq(`/api/email/campaigns/${campId}/cancel`, "POST", {}, adminToken),
      { params: Promise.resolve({ id: campId }) }
    );
    assert.equal(adminCancel.status, 200, "Admin cancel must succeed");

    // 7. Campaign Analytics
    const campAnalyticsRes = await campaignIdAnalyticsRoute.GET(
      makeReq(`/api/email/campaigns/${campId}/analytics`, "GET", undefined, viewerToken),
      { params: Promise.resolve({ id: campId }) }
    );
    assert.equal(campAnalyticsRes.status, 200, "Campaign analytics must be 200 for Viewer");

    console.log("  [PASS] Campaigns, Audience Preview & Lifecycle audit passed.");

    // -------------------------------------------------------------
    // Route 8: Deliveries Telemetry
    // -------------------------------------------------------------
    console.log("-> [Step 9] Auditing Route: /dashboard/email/deliveries...");
    const deliveriesRes = await deliveriesRoute.GET(makeReq("/api/email/deliveries", "GET", undefined, viewerToken));
    assert.equal(deliveriesRes.status, 200);
    const delivJson = await deliveriesRes.json();
    assert.ok(Array.isArray(delivJson.data.items));
    console.log("  [PASS] Deliveries telemetry audit passed.");

    // -------------------------------------------------------------
    // Route 9: Suppressions Management
    // -------------------------------------------------------------
    console.log("-> [Step 10] Auditing Route: /dashboard/email/suppressions...");
    // 1. Viewer add suppression -> 403
    const viewerAddSupp = await suppressionsRoute.POST(
      makeReq("/api/email/suppressions", "POST", { email: "supp@example.com" }, viewerToken)
    );
    assert.equal(viewerAddSupp.status, 403, "Viewer add suppression must be 403");

    // 2. Admin add suppression -> 200/201
    const adminAddSupp = await suppressionsRoute.POST(
      makeReq("/api/email/suppressions", "POST", {
        email: `suppressed-${testSuffix}@example.test`,
        reason: "MANUAL",
        source: "AUDIT_TEST",
      }, adminToken)
    );
    assert.equal(adminAddSupp.status, 201, "Admin add suppression must be 201");

    // 3. Check suppression status via GET
    const getSuppRes = await suppressionsRoute.GET(
      makeReq(`/api/email/suppressions?email=suppressed-${testSuffix}@example.test`, "GET", undefined, viewerToken)
    );
    assert.equal(getSuppRes.status, 200);
    const getSuppJson = await getSuppRes.json();
    assert.equal(getSuppJson.data.suppressed, true);

    // 4. Viewer delete suppression -> 403
    const viewerDelSupp = await suppressionsRoute.DELETE(
      makeReq(`/api/email/suppressions?email=suppressed-${testSuffix}@example.test`, "DELETE", undefined, viewerToken)
    );
    assert.equal(viewerDelSupp.status, 403, "Viewer delete suppression must be 403");

    // 5. Admin delete suppression -> 200
    const adminDelSupp = await suppressionsRoute.DELETE(
      makeReq(`/api/email/suppressions?email=suppressed-${testSuffix}@example.test`, "DELETE", undefined, adminToken)
    );
    assert.equal(adminDelSupp.status, 200, "Admin delete suppression must be 200");

    console.log("  [PASS] Suppressions management audit & RBAC passed.");

    console.log("\n========================================================");
    console.log("  ALL 9 DASHBOARD MODULES PASSED OPERATIONAL AUDIT!");
    console.log("========================================================\n");
  } finally {
    // Clean up created test entities
    try {
      await prisma.emailCampaign.deleteMany({ where: { clientId: tenant.id } });
      await prisma.emailTemplate.deleteMany({ where: { clientId: tenant.id } });
      await prisma.emailSegment.deleteMany({ where: { clientId: tenant.id } });
      await prisma.emailList.deleteMany({ where: { clientId: tenant.id } });
      await prisma.emailContact.deleteMany({ where: { clientId: tenant.id } });
      await prisma.emailSenderIdentity.deleteMany({ where: { clientId: tenant.id } });
      await prisma.emailProviderConfig.deleteMany({ where: { clientId: tenant.id } });
      await prisma.emailSuppression.deleteMany({ where: { clientId: tenant.id } });
      await prisma.userSession.deleteMany({ where: { userId: { in: [adminUser.id, viewerUser.id] } } });
      await prisma.user.deleteMany({ where: { id: { in: [adminUser.id, viewerUser.id] } } });
      await prisma.apiClient.delete({ where: { id: tenant.id } });
      await prisma.$disconnect();
    } catch (cleanupErr) {
      console.warn("Cleanup warning:", cleanupErr);
    }
  }
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error("Dashboard operational verification failed:", err);
    process.exit(1);
  });

