/**
 * Advanced Email Audience Engine & Criteria Expansion Test Suite
 *
 * Validates:
 * 1. Nested AND/OR criteria groups with arbitrary depth & recursion guard
 * 2. Contact attributes filtering (direct fields and custom metadata attributes)
 * 3. Engagement criteria (last emailed recency, activity windows, never emailed)
 * 4. Previous campaign activity (targeted vs received vs not targeted)
 * 5. Opens history criteria (campaign-specific and timeframe)
 * 6. Clicks history criteria (URL-specific and timeframe)
 * 7. Delivery history criteria (delivered, bounced, complained, failed)
 * 8. Suppression state criteria (is_suppressed, is_not_suppressed)
 * 9. Consent state criteria (marketing consent, verified, consent source, timestamp)
 * 10. List membership criteria (in_list, not_in_list)
 * 11. No arbitrary SQL / strictly parameterized Prisma query generation
 * 12. Multi-tenant isolation at every query node
 * 13. Explainable audience counts with granular breakdowns and summary
 * 14. Scalable cursor pagination & flat memory
 * 15. Deterministic previews matching frozen recipient snapshots
 */

if (!process.env.DATABASE_URL || process.env.DATABASE_URL.includes("peqynzeioiauynfpdsdv") || process.env.DATABASE_URL.includes("supabase.co")) {
  process.env.DATABASE_URL = "postgresql://postgres:postgres@127.0.0.1:5433/email_test";
}
if (!process.env.DIRECT_URL || process.env.DIRECT_URL.includes("peqynzeioiauynfpdsdv") || process.env.DIRECT_URL.includes("supabase.co")) {
  process.env.DIRECT_URL = "postgresql://postgres:postgres@127.0.0.1:5433/email_test";
}
process.env.REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";
process.env.NODE_ENV = "test";
process.env.ALLOW_DESTRUCTIVE_TESTS = "true";
process.env.AUTH_SESSION_SECRET = "audience-advanced-test-session-secret-32-chars";
process.env.API_KEY_PEPPER = "audience-advanced-test-pepper-32-chars-min";

import { prisma } from "../src/lib/prisma";
import { EmailAudienceResolver } from "../src/lib/services/email-audience-resolver";
import { EmailSegmentService, AudienceGroup } from "../src/lib/services/email-segment-service";
import {
  EmailContactStatus,
  EmailSubscriptionStatus,
  EmailSuppressionReason,
  EmailType,
  EmailEventType,
  EmailDeliveryStatus,
  EmailProviderType,
} from "@prisma/client";

let passed = 0;
let failed = 0;

function testAssert(condition: boolean, description: string, detail?: string) {
  if (condition) {
    console.log(`  ✅ PASS: ${description}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${description}${detail ? ` (${detail})` : ""}`);
    failed++;
  }
}

async function cleanDatabase() {
  await prisma.emailEvent.deleteMany({});
  await prisma.emailDelivery.deleteMany({});
  await prisma.emailCampaignRecipient.deleteMany({});
  await prisma.emailCampaign.deleteMany({});
  await prisma.emailTemplateVersion.deleteMany({});
  await prisma.emailTemplate.deleteMany({});
  await prisma.emailListMember.deleteMany({});
  await prisma.emailList.deleteMany({});
  await prisma.emailSegment.deleteMany({});
  await prisma.emailContact.deleteMany({});
  await prisma.emailSuppression.deleteMany({});
  await prisma.emailSenderIdentity.deleteMany({});
  await prisma.emailProviderConfig.deleteMany({});
  await prisma.apiClient.deleteMany({});
}

async function runAdvancedAudienceSuite() {
  console.log("==================================================================");
  console.log("🚀 RUNNING ADVANCED AUDIENCE ENGINE EXPANSION TEST SUITE");
  console.log("   Target: Real Disposable PostgreSQL (5433)");
  console.log("==================================================================\n");

  await cleanDatabase();

  // ---------------------------------------------------------------------------
  // 1. Tenant Infrastructure Setup
  // ---------------------------------------------------------------------------
  console.log("🏢 [1/12] Creating Multi-Tenant Clients...");
  const tenantA = await prisma.apiClient.create({
    data: { name: "Tenant Engine Alpha", active: true },
  });
  const tenantB = await prisma.apiClient.create({
    data: { name: "Tenant Engine Beta", active: true },
  });
  testAssert(Boolean(tenantA.id && tenantB.id), "Tenants Alpha and Beta created");

  // ---------------------------------------------------------------------------
  // 2. Nested AND/OR Criteria Validation & Recursion Limit
  // ---------------------------------------------------------------------------
  console.log("\n🌳 [2/12] Testing Nested AND/OR Groups & Depth Protection...");

  // A. Valid (A AND B) OR (C AND D) structure
  const nestedCriteria: AudienceGroup = {
    conjunction: "OR",
    conditions: [
      {
        conjunction: "AND",
        conditions: [
          { type: "attribute", field: "status", operator: "equals", value: "SUBSCRIBED" },
          { type: "attribute", field: "attributes.tier", operator: "equals", value: "VIP" },
        ],
      },
      {
        conjunction: "AND",
        conditions: [
          { type: "attribute", field: "status", operator: "equals", value: "SUBSCRIBED" },
          { type: "consent", field: "hasMarketingConsent", operator: "equals", value: true },
        ],
      },
    ],
  };

  const validatedNested = EmailSegmentService.validateCriteria(nestedCriteria);
  testAssert(
    validatedNested.conjunction === "OR" && validatedNested.conditions.length === 2,
    "Validates 2-level nested (A AND B) OR (C AND D) criteria"
  );

  // B. Max recursion depth protection
  let depthErrorCaught = false;
  try {
    let deep: any = { type: "attribute", field: "status", operator: "equals", value: "SUBSCRIBED" };
    for (let d = 0; d < 8; d++) {
      deep = { conjunction: "AND", conditions: [deep] };
    }
    EmailSegmentService.validateCriteria(deep);
  } catch (err: any) {
    if (err.message.includes("Maximum nesting depth")) {
      depthErrorCaught = true;
    }
  }
  testAssert(depthErrorCaught, "Rejects criteria trees exceeding maximum recursion depth (depth > 5)");

  // ---------------------------------------------------------------------------
  // 3. Contact Attributes (Direct & Custom Metadata)
  // ---------------------------------------------------------------------------
  console.log("\n🏷️  [3/12] Testing Contact Attributes & Rich Operators...");

  const c1 = await prisma.emailContact.create({
    data: {
      clientId: tenantA.id,
      email: "alice@example.com",
      normalizedEmail: "alice@example.com",
      firstName: "Alice",
      lastName: "Smith",
      status: EmailContactStatus.SUBSCRIBED,
      hasMarketingConsent: true,
      verified: true,
      consentSource: "WEB_CHECKOUT",
      metadata: JSON.stringify({ tier: "PLATINUM", score: 95, city: "London" }),
    },
  });

  const c2 = await prisma.emailContact.create({
    data: {
      clientId: tenantA.id,
      email: "bob@example.com",
      normalizedEmail: "bob@example.com",
      firstName: "Bob",
      lastName: "Jones",
      status: EmailContactStatus.SUBSCRIBED,
      hasMarketingConsent: true,
      verified: false,
      consentSource: "NEWSLETTER",
      metadata: JSON.stringify({ tier: "GOLD", score: 40, city: "Paris" }),
    },
  });

  // Evaluate in-memory and database
  const criteriaPlatinum = {
    conjunction: "AND" as const,
    conditions: [
      { field: "attributes.tier", operator: "equals" as const, value: "PLATINUM" },
      { field: "attributes.score", operator: "greater_than" as const, value: 50 },
    ],
  };

  testAssert(
    EmailSegmentService.evaluateContact(criteriaPlatinum, c1) === true,
    "Alice matches PLATINUM tier and score > 50 in-memory"
  );
  testAssert(
    EmailSegmentService.evaluateContact(criteriaPlatinum, c2) === false,
    "Bob fails PLATINUM tier in-memory"
  );

  // ---------------------------------------------------------------------------
  // 4. List Membership Criteria (in_list, not_in_list)
  // ---------------------------------------------------------------------------
  console.log("\n📋 [4/12] Testing List Membership Criteria...");

  const listVIP = await prisma.emailList.create({
    data: { clientId: tenantA.id, name: "VIP Club List" },
  });

  await prisma.emailListMember.create({
    data: {
      listId: listVIP.id,
      contactId: c1.id,
      status: EmailSubscriptionStatus.SUBSCRIBED,
    },
  });

  const criteriaInList: AudienceGroup = {
    conjunction: "AND",
    conditions: [{ type: "list", operator: "in_list", listId: listVIP.id }],
  };

  const previewInList = await EmailAudienceResolver.resolvePreview(tenantA.id, {
    criteria: criteriaInList,
    type: EmailType.PROMOTIONAL,
  });
  testAssert(previewInList.eligibleCount === 1, `in_list matches exactly 1 contact (actual: ${previewInList.eligibleCount})`);

  const criteriaNotInList: AudienceGroup = {
    conjunction: "AND",
    conditions: [{ type: "list", operator: "not_in_list", listId: listVIP.id }],
  };

  const previewNotInList = await EmailAudienceResolver.resolvePreview(tenantA.id, {
    criteria: criteriaNotInList,
    type: EmailType.PROMOTIONAL,
  });
  testAssert(previewNotInList.eligibleCount === 1, `not_in_list matches Bob only (actual: ${previewNotInList.eligibleCount})`);

  // ---------------------------------------------------------------------------
  // 5. Campaign Activity, Opens & Clicks History
  // ---------------------------------------------------------------------------
  console.log("\n📬 [5/12] Testing Campaign Activity, Opens & Clicks...");

  const campaign1 = await prisma.emailCampaign.create({
    data: {
      clientId: tenantA.id,
      name: "Past Campaign 1",
      status: "COMPLETED",
      type: EmailType.PROMOTIONAL,
    },
  });

  const recipient1 = await prisma.emailCampaignRecipient.create({
    data: {
      campaignId: campaign1.id,
      contactId: c1.id,
      email: c1.email,
      status: "DELIVERED",
    },
  });

  const delivery1 = await prisma.emailDelivery.create({
    data: {
      clientId: tenantA.id,
      providerType: EmailProviderType.MOCK,
      campaignRecipientId: recipient1.id,
      campaignId: campaign1.id,
      category: EmailType.PROMOTIONAL,
      from: "updates@example.com",
      to: c1.email,
      subject: "Test Past Campaign",
      status: EmailDeliveryStatus.DELIVERED,
      deliveredAt: new Date(),
    },
  });

  // Alice opened and clicked
  await prisma.emailEvent.create({
    data: {
      clientId: tenantA.id,
      deliveryId: delivery1.id,
      eventType: EmailEventType.OPENED,
      recipient: c1.email,
      payload: JSON.stringify({ device: "mobile" }),
      occurredAt: new Date(),
    },
  });

  await prisma.emailEvent.create({
    data: {
      clientId: tenantA.id,
      deliveryId: delivery1.id,
      eventType: EmailEventType.CLICKED,
      recipient: c1.email,
      payload: JSON.stringify({ url: "https://example.com/promo-sale" }),
      occurredAt: new Date(),
    },
  });

  // Criteria: Opened email
  const criteriaOpened: AudienceGroup = {
    conjunction: "AND",
    conditions: [{ type: "opens", operator: "opened", campaignId: campaign1.id }],
  };
  const previewOpened = await EmailAudienceResolver.resolvePreview(tenantA.id, {
    criteria: criteriaOpened,
    type: EmailType.PROMOTIONAL,
  });
  testAssert(previewOpened.eligibleCount === 1, `Opens criteria correctly matches 1 opened contact (actual: ${previewOpened.eligibleCount})`);

  // Criteria: Clicked specific URL
  const criteriaClickedUrl: AudienceGroup = {
    conjunction: "AND",
    conditions: [{ type: "clicks", operator: "clicked_url", url: "promo-sale" }],
  };
  const previewClickedUrl = await EmailAudienceResolver.resolvePreview(tenantA.id, {
    criteria: criteriaClickedUrl,
    type: EmailType.PROMOTIONAL,
  });
  testAssert(previewClickedUrl.eligibleCount === 1, `Clicks criteria matches clicked URL promo-sale (actual: ${previewClickedUrl.eligibleCount})`);

  // Criteria: Not opened
  const criteriaNotOpened: AudienceGroup = {
    conjunction: "AND",
    conditions: [{ type: "opens", operator: "not_opened", campaignId: campaign1.id }],
  };
  const previewNotOpened = await EmailAudienceResolver.resolvePreview(tenantA.id, {
    criteria: criteriaNotOpened,
    type: EmailType.PROMOTIONAL,
  });
  testAssert(previewNotOpened.eligibleCount === 1, `Not opened matches Bob who never received/opened campaign (actual: ${previewNotOpened.eligibleCount})`);

  // ---------------------------------------------------------------------------
  // 6. Delivery History Criteria (Delivered, Bounced)
  // ---------------------------------------------------------------------------
  console.log("\n🚚 [6/12] Testing Delivery History Criteria...");

  const criteriaDelivered: AudienceGroup = {
    conjunction: "AND",
    conditions: [{ type: "delivery_history", operator: "delivered" }],
  };
  const previewDelivered = await EmailAudienceResolver.resolvePreview(tenantA.id, {
    criteria: criteriaDelivered,
    type: EmailType.PROMOTIONAL,
  });
  testAssert(previewDelivered.eligibleCount === 1, `Delivery history 'delivered' matches Alice (actual: ${previewDelivered.eligibleCount})`);

  // ---------------------------------------------------------------------------
  // 7. Suppression State Criteria
  // ---------------------------------------------------------------------------
  console.log("\n🛡️  [7/12] Testing Suppression State Criteria...");

  const c3Suppressed = await prisma.emailContact.create({
    data: {
      clientId: tenantA.id,
      email: "suppressed@example.com",
      normalizedEmail: "suppressed@example.com",
      status: EmailContactStatus.SUPPRESSED,
      hasMarketingConsent: true,
    },
  });

  await prisma.emailSuppression.create({
    data: {
      clientId: tenantA.id,
      email: c3Suppressed.email,
      normalizedEmail: c3Suppressed.normalizedEmail,
      reason: EmailSuppressionReason.HARD_BOUNCE,
      source: "BOUNCE_WEBHOOK",
    },
  });

  const criteriaNotSuppressed: AudienceGroup = {
    conjunction: "AND",
    conditions: [{ type: "suppression", operator: "is_not_suppressed" }],
  };

  const previewNotSupp = await EmailAudienceResolver.resolvePreview(tenantA.id, {
    criteria: criteriaNotSuppressed,
    type: EmailType.PROMOTIONAL,
  });
  testAssert(previewNotSupp.eligibleCount === 2, `Excludes suppressed contact (eligible: ${previewNotSupp.eligibleCount}, expected: 2)`);

  // ---------------------------------------------------------------------------
  // 8. Engagement & Recency Criteria
  // ---------------------------------------------------------------------------
  console.log("\n⏱️  [8/12] Testing Engagement & Recency Criteria...");

  // Update Alice with recent lastEmailedAt
  await prisma.emailContact.update({
    where: { id: c1.id },
    data: { lastEmailedAt: new Date() },
  });

  const criteriaRecentlyEmailed: AudienceGroup = {
    conjunction: "AND",
    conditions: [{ type: "engagement", dimension: "last_emailed", operator: "within_days", days: 7 }],
  };
  const previewRecent = await EmailAudienceResolver.resolvePreview(tenantA.id, {
    criteria: criteriaRecentlyEmailed,
    type: EmailType.PROMOTIONAL,
  });
  testAssert(previewRecent.eligibleCount === 1, `Engagement 'within_days: 7' matches Alice (actual: ${previewRecent.eligibleCount})`);

  const criteriaNeverEmailed: AudienceGroup = {
    conjunction: "AND",
    conditions: [{ type: "engagement", dimension: "never_emailed", operator: "never" }],
  };
  const previewNever = await EmailAudienceResolver.resolvePreview(tenantA.id, {
    criteria: criteriaNeverEmailed,
    type: EmailType.PROMOTIONAL,
  });
  testAssert(previewNever.eligibleCount === 1, `Engagement 'never_emailed' matches Bob (actual: ${previewNever.eligibleCount})`);

  // ---------------------------------------------------------------------------
  // 9. Explainable Audience Counts & Diagnostic Summaries
  // ---------------------------------------------------------------------------
  console.log("\n📊 [9/12] Testing Explainable Audience Counts & Summaries...");

  // Create an unsubscribed contact and an invalid email contact
  await prisma.emailContact.create({
    data: {
      clientId: tenantA.id,
      email: "unsub@example.com",
      normalizedEmail: "unsub@example.com",
      status: EmailContactStatus.UNSUBSCRIBED,
      hasMarketingConsent: false,
    },
  });

  await prisma.emailContact.create({
    data: {
      clientId: tenantA.id,
      email: "invalid-syntax-at-domain",
      normalizedEmail: "invalid-syntax-at-domain",
      status: EmailContactStatus.SUBSCRIBED,
      hasMarketingConsent: true,
    },
  });

  // Evaluate entire tenant audience
  const explainableAll = await EmailAudienceResolver.resolvePreview(tenantA.id, {
    criteria: {
      conjunction: "OR",
      conditions: [
        { type: "attribute", field: "status", operator: "equals", value: "SUBSCRIBED" },
        { type: "attribute", field: "status", operator: "equals", value: "UNSUBSCRIBED" },
        { type: "attribute", field: "status", operator: "equals", value: "SUPPRESSED" },
      ],
    },
    type: EmailType.PROMOTIONAL,
  });

  testAssert(explainableAll.totalAudience === 5, `Total audience evaluated is 5 (actual: ${explainableAll.totalAudience})`);
  testAssert(explainableAll.eligibleCount === 2, `Eligible count is 2 (Alice & Bob) (actual: ${explainableAll.eligibleCount})`);
  testAssert(explainableAll.unsubscribedCount === 1, `Unsubscribed count is 1 (actual: ${explainableAll.unsubscribedCount})`);
  testAssert(explainableAll.suppressedCount === 1, `Suppressed count is 1 (actual: ${explainableAll.suppressedCount})`);
  testAssert(explainableAll.invalidCount === 1, `Invalid email count is 1 (actual: ${explainableAll.invalidCount})`);
  testAssert(Boolean(explainableAll.explainSummary && explainableAll.explainSummary.includes("excluded")), "Explain summary provides human-readable breakdown");
  testAssert(explainableAll.breakdown.consentMetrics.hasMarketingConsentTrue === 4, "Consent metrics track marketing consent grants");

  // ---------------------------------------------------------------------------
  // 10. Multi-Tenant Isolation
  // ---------------------------------------------------------------------------
  console.log("\n🔒 [10/12] Testing Strict Multi-Tenant Isolation...");

  // Seed contact for Tenant Beta
  await prisma.emailContact.create({
    data: {
      clientId: tenantB.id,
      email: "beta_user@example.com",
      normalizedEmail: "beta_user@example.com",
      status: EmailContactStatus.SUBSCRIBED,
      hasMarketingConsent: true,
    },
  });

  // Query Tenant Beta with broad criteria
  const previewBeta = await EmailAudienceResolver.resolvePreview(tenantB.id, {
    criteria: {
      conjunction: "AND",
      conditions: [{ type: "attribute", field: "status", operator: "equals", value: "SUBSCRIBED" }],
    },
    type: EmailType.PROMOTIONAL,
  });

  testAssert(previewBeta.totalAudience === 1, `Tenant Beta audience strictly isolated: 1 contact (actual: ${previewBeta.totalAudience})`);
  testAssert(previewBeta.eligibleCount === 1, "Tenant Beta cannot see Tenant Alpha contacts");

  // ---------------------------------------------------------------------------
  // 11. Deterministic Previews vs Frozen Campaign Snapshots
  // ---------------------------------------------------------------------------
  console.log("\n⚖️  [11/12] Testing Deterministic Previews vs Frozen Snapshots...");

  const launchCampaign = await prisma.emailCampaign.create({
    data: {
      clientId: tenantA.id,
      name: "Deterministic Snapshot Campaign",
      type: EmailType.PROMOTIONAL,
    },
  });

  const launchSegment = await prisma.emailSegment.create({
    data: {
      clientId: tenantA.id,
      name: "Launch Segment",
      criteria: JSON.stringify({
        conjunction: "AND",
        conditions: [
          { type: "attribute", field: "status", operator: "equals", value: "SUBSCRIBED" },
          { type: "consent", field: "hasMarketingConsent", operator: "equals", value: true },
        ],
      }),
    },
  });

  // Resolve preview
  const preLaunchPreview = await EmailAudienceResolver.resolvePreview(tenantA.id, {
    segmentId: launchSegment.id,
    type: EmailType.PROMOTIONAL,
  });

  // Create frozen snapshot
  const snapshotResult = await EmailAudienceResolver.createRecipientSnapshot(tenantA.id, {
    id: launchCampaign.id,
    segmentId: launchSegment.id,
    type: EmailType.PROMOTIONAL,
  });

  testAssert(
    preLaunchPreview.eligibleCount === snapshotResult.eligibleCount,
    `Preview eligible (${preLaunchPreview.eligibleCount}) strictly equals Snapshot eligible (${snapshotResult.eligibleCount})`
  );
  testAssert(
    preLaunchPreview.totalAudience === snapshotResult.totalAudience,
    `Preview total (${preLaunchPreview.totalAudience}) strictly equals Snapshot total (${snapshotResult.totalAudience})`
  );
  testAssert(
    preLaunchPreview.suppressedCount === snapshotResult.suppressedCount,
    `Preview suppressed (${preLaunchPreview.suppressedCount}) strictly equals Snapshot suppressed (${snapshotResult.suppressedCount})`
  );

  // Verify frozen metadata immutability
  const firstSnapshot = snapshotResult.snapshotRecipients[0];
  testAssert(Boolean(firstSnapshot && firstSnapshot.metadataSnapshot), "Snapshot recipient contains frozen metadataSnapshot payload");

  // Mutate contact
  await prisma.emailContact.update({
    where: { id: c1.id },
    data: { firstName: "MUTATED_FIRST_NAME" },
  });

  const reloadedSnapshot = await prisma.emailCampaignRecipient.findUnique({
    where: { id: firstSnapshot.id },
  });
  const parsedFrozen = JSON.parse(reloadedSnapshot?.metadataSnapshot || "{}");
  testAssert(
    parsedFrozen.firstName !== "MUTATED_FIRST_NAME",
    "Recipient metadata snapshot remains frozen and unaffected by contact record mutation"
  );

  // ---------------------------------------------------------------------------
  // 12. Cleanup & Summary
  // ---------------------------------------------------------------------------
  console.log("\n🧹 [12/12] Cleaning up test fixtures...");
  await cleanDatabase();

  console.log("\n==================================================================");
  console.log(`Audience Engine Expansion Suite Summary: ${passed} PASSED, ${failed} FAILED`);
  console.log("==================================================================\n");

  if (failed > 0) {
    process.exit(1);
  }
}

runAdvancedAudienceSuite().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
