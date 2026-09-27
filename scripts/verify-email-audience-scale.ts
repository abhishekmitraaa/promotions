/**
 * Scalable Email Audience Engine & Resolution Integration Test Suite
 *
 * Validates correctness, performance, and scaling properties against real PostgreSQL (5433):
 * 1. Multi-tenant isolation (Tenant A vs Tenant B).
 * 2. Thousands of contacts processed in bounded streaming batches (flat memory).
 * 3. Structured criteria translation into parameterized Prisma/PostgreSQL queries (NO arbitrary SQL).
 * 4. Strict allowlist validation for fields and operators.
 * 5. Deterministic ordering across all queries (orderBy: { id: "asc" }).
 * 6. Authoritative suppression and marketing consent filtering.
 * 7. Accurate, uncapped preview counts (uncapped estimates).
 * 8. Preview count EQUALS actual eligible snapshot count for the same point in time.
 * 9. Safe concurrent campaign snapshot creation (via PostgreSQL advisory locks & deduplication).
 * 10. Prevention of duplicate EmailCampaignRecipient records across list/segment unions.
 * 11. Immutability of recipient metadata snapshot after campaign launch.
 */

process.env.DATABASE_URL = "postgresql://postgres:postgres@127.0.0.1:5433/email_test";
process.env.DIRECT_URL = "postgresql://postgres:postgres@127.0.0.1:5433/email_test";
process.env.REDIS_URL = "redis://127.0.0.1:6379";
process.env.NODE_ENV = "test";
process.env.ALLOW_DESTRUCTIVE_TESTS = "true";
process.env.AUTH_SESSION_SECRET = "audience-scale-test-session-secret-32-chars";
process.env.API_KEY_PEPPER = "audience-scale-test-pepper-32-chars-min";

import { prisma } from "../src/lib/prisma";
import { EmailAudienceResolver } from "../src/lib/services/email-audience-resolver";
import { EmailSegmentService, SegmentCriteria } from "../src/lib/services/email-segment-service";
import { EmailCampaignService } from "../src/lib/services/email-campaign-service";
import { EmailSuppressionService } from "../src/lib/services/email-suppression-service";
import {
  EmailCampaignStatus,
  EmailContactStatus,
  EmailSubscriptionStatus,
  EmailSuppressionReason,
  EmailType,
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

async function runAudienceScaleSuite() {
  console.log("==================================================================");
  console.log("🚀 RUNNING SCALABLE EMAIL AUDIENCE ENGINE INTEGRATION SUITE");
  console.log("   Target: Real Disposable PostgreSQL (5433) - Scale & Correctness");
  console.log("==================================================================\n");

  await cleanDatabase();

  // ---------------------------------------------------------------------------
  // 1. Multi-Tenant Infrastructure Setup
  // ---------------------------------------------------------------------------
  console.log("\n📦 [1/10] Setting up Multi-Tenant Clients...");
  const tenantA = await prisma.apiClient.create({
    data: { name: "Tenant Scale Alpha", active: true },
  });
  const tenantB = await prisma.apiClient.create({
    data: { name: "Tenant Scale Beta", active: true },
  });

  testAssert(Boolean(tenantA.id && tenantB.id), "Multi-tenant clients created successfully");

  // ---------------------------------------------------------------------------
  // 2. Structured Criteria Allowlist & SQL Injection Resistance
  // ---------------------------------------------------------------------------
  console.log("\n🛡️  [2/10] Testing Structured Criteria Allowlist & Injection Resistance...");

  // A. SQL Injection attempts in values or fields
  let sqlInjectionBlocked = false;
  try {
    EmailSegmentService.validateCriteria({
      conjunction: "AND",
      conditions: [
        { field: "email", operator: "EQUALS", value: "test@example.com'; DROP TABLE email_contacts; --" },
      ],
    });
  } catch (err: any) {
    if (err.message.includes("Dangerous characters or SQL keywords")) {
      sqlInjectionBlocked = true;
    }
  }
  testAssert(sqlInjectionBlocked, "Strict validation rejects SQL injection strings in condition values");

  // B. Disallowed arbitrary fields
  let arbitraryFieldBlocked = false;
  try {
    EmailSegmentService.validateCriteria({
      conjunction: "AND",
      conditions: [
        { field: "non_existent_column_raw_sql", operator: "EQUALS", value: "foo" },
      ],
    });
  } catch (err: any) {
    if (err.message.includes("Unsupported segment field")) {
      arbitraryFieldBlocked = true;
    }
  }
  testAssert(arbitraryFieldBlocked, "Strict validation rejects non-allowlisted arbitrary fields");

  // C. Arbitrary operator injection
  let arbitraryOperatorBlocked = false;
  try {
    EmailSegmentService.validateCriteria({
      conjunction: "AND",
      conditions: [
        { field: "status", operator: "UNION SELECT * FROM" as any, value: "SUBSCRIBED" },
      ],
    });
  } catch (err: any) {
    if (err.message.includes("Unsupported operator")) {
      arbitraryOperatorBlocked = true;
    }
  }
  testAssert(arbitraryOperatorBlocked, "Strict validation rejects non-allowlisted operators");

  // D. Valid criteria translated into parameterized Prisma where clause
  const validCriteria: SegmentCriteria = {
    conjunction: "AND",
    conditions: [
      { field: "status", operator: "EQUALS", value: "SUBSCRIBED" },
      { field: "marketingConsent", operator: "EQUALS", value: true },
      { field: "attributes.tier", operator: "EQUALS", value: "VIP" },
    ],
  };

  const translation = EmailSegmentService.buildPrismaWhereFromCriteria(tenantA.id, validCriteria);
  const andConditions = Array.isArray((translation.prismaWhere as any).AND)
    ? (translation.prismaWhere as any).AND
    : [];
  const hasStatusFilter = andConditions.some((c: any) => c.status === "SUBSCRIBED");
  const hasConsentFilter = andConditions.some((c: any) => c.hasMarketingConsent === true);

  testAssert(
    translation.prismaWhere.clientId === tenantA.id &&
    hasStatusFilter &&
    hasConsentFilter,
    "Structured criteria cleanly translates direct fields to parameterized Prisma where clause"
  );
  testAssert(translation.hasAttributeConditions === true, "Flags attribute conditions for streaming batch evaluation");

  // ---------------------------------------------------------------------------
  // 3. Dataset Generation: Thousands of Contacts Across Tenants
  // ---------------------------------------------------------------------------
  console.log("\n📊 [3/10] Seeding Large Dataset (Thousands of Contacts)...");

  // Tenant Alpha Contacts:
  // - 1,500 active consented contacts (750 VIP tier, 750 STANDARD tier)
  // - 300 unsubscribed contacts (status: UNSUBSCRIBED, hasMarketingConsent: false)
  // - 150 pending contacts (status: PENDING, hasMarketingConsent: false)
  // - 50 suppressed contacts (added to suppression list)
  // - 50 malformed email contacts
  // Total: 2,050 raw contacts for Tenant Alpha

  const alphaContactsData: any[] = [];

  // Active consented VIP (750)
  for (let i = 1; i <= 750; i++) {
    const email = `vip_${i}@tenant-alpha.test`;
    alphaContactsData.push({
      clientId: tenantA.id,
      email,
      normalizedEmail: email.toLowerCase(),
      firstName: `VipFirst${i}`,
      lastName: `VipLast${i}`,
      status: EmailContactStatus.SUBSCRIBED,
      hasMarketingConsent: true,
      metadata: JSON.stringify({ tier: "VIP", city: "New York", points: i * 10 }),
    });
  }

  // Active consented STANDARD (750)
  for (let i = 1; i <= 750; i++) {
    const email = `std_${i}@tenant-alpha.test`;
    alphaContactsData.push({
      clientId: tenantA.id,
      email,
      normalizedEmail: email.toLowerCase(),
      firstName: `StdFirst${i}`,
      lastName: `StdLast${i}`,
      status: EmailContactStatus.SUBSCRIBED,
      hasMarketingConsent: true,
      metadata: JSON.stringify({ tier: "STANDARD", city: "Chicago", points: i * 5 }),
    });
  }

  // Unsubscribed contacts (300)
  for (let i = 1; i <= 300; i++) {
    const email = `unsub_${i}@tenant-alpha.test`;
    alphaContactsData.push({
      clientId: tenantA.id,
      email,
      normalizedEmail: email.toLowerCase(),
      firstName: `UnsubFirst${i}`,
      lastName: `UnsubLast${i}`,
      status: EmailContactStatus.UNSUBSCRIBED,
      hasMarketingConsent: false,
      metadata: JSON.stringify({ tier: "STANDARD" }),
    });
  }

  // Pending consent contacts (150)
  for (let i = 1; i <= 150; i++) {
    const email = `pending_${i}@tenant-alpha.test`;
    alphaContactsData.push({
      clientId: tenantA.id,
      email,
      normalizedEmail: email.toLowerCase(),
      firstName: `PendingFirst${i}`,
      lastName: `PendingLast${i}`,
      status: EmailContactStatus.PENDING,
      hasMarketingConsent: false,
      metadata: JSON.stringify({ tier: "STANDARD" }),
    });
  }

  // Suppressed candidate contacts (50)
  for (let i = 1; i <= 50; i++) {
    const email = `suppressed_${i}@tenant-alpha.test`;
    alphaContactsData.push({
      clientId: tenantA.id,
      email,
      normalizedEmail: email.toLowerCase(),
      firstName: `SuppFirst${i}`,
      lastName: `SuppLast${i}`,
      status: EmailContactStatus.SUBSCRIBED,
      hasMarketingConsent: true, // Consented on contact, but on tenant suppression list
      metadata: JSON.stringify({ tier: "STANDARD" }),
    });
  }

  // Malformed contacts (50)
  const malformedEmails = [
    "not-an-email",
    "missing-at.domain.com",
    "@missing-username.com",
    "has spaces@domain.com",
    "trailing-dot@domain.",
  ];
  for (let i = 1; i <= 50; i++) {
    const malformed = `${malformedEmails[i % malformedEmails.length]}-${i}`;
    alphaContactsData.push({
      clientId: tenantA.id,
      email: malformed,
      normalizedEmail: malformed.toLowerCase(),
      firstName: `MalformedFirst${i}`,
      lastName: `MalformedLast${i}`,
      status: EmailContactStatus.SUBSCRIBED,
      hasMarketingConsent: true,
      metadata: JSON.stringify({ tier: "STANDARD" }),
    });
  }

  // Batch insert contacts for Tenant Alpha
  const BATCH_INSERT_SIZE = 500;
  for (let i = 0; i < alphaContactsData.length; i += BATCH_INSERT_SIZE) {
    const slice = alphaContactsData.slice(i, i + BATCH_INSERT_SIZE);
    await prisma.emailContact.createMany({ data: slice });
  }

  // Tenant Beta Contacts (500 contacts for cross-tenant isolation testing)
  const betaContactsData: any[] = [];
  for (let i = 1; i <= 500; i++) {
    const email = `beta_${i}@tenant-beta.test`;
    betaContactsData.push({
      clientId: tenantB.id,
      email,
      normalizedEmail: email.toLowerCase(),
      firstName: `BetaFirst${i}`,
      lastName: `BetaLast${i}`,
      status: EmailContactStatus.SUBSCRIBED,
      hasMarketingConsent: true,
      metadata: JSON.stringify({ tier: "VIP" }),
    });
  }
  await prisma.emailContact.createMany({ data: betaContactsData });

  const totalAlphaContacts = await prisma.emailContact.count({ where: { clientId: tenantA.id } });
  const totalBetaContacts = await prisma.emailContact.count({ where: { clientId: tenantB.id } });

  testAssert(totalAlphaContacts === 2050, `Seeded 2,050 contacts for Tenant Alpha (actual: ${totalAlphaContacts})`);
  testAssert(totalBetaContacts === 500, `Seeded 500 contacts for Tenant Beta (actual: ${totalBetaContacts})`);

  // Seed Tenant Alpha Suppressions (50 suppressions)
  const suppressionsData: any[] = [];
  for (let i = 1; i <= 50; i++) {
    const email = `suppressed_${i}@tenant-alpha.test`;
    suppressionsData.push({
      clientId: tenantA.id,
      email,
      normalizedEmail: email.toLowerCase(),
      reason: EmailSuppressionReason.HARD_BOUNCE,
      source: "TEST_SUITE_SEED",
    });
  }
  await prisma.emailSuppression.createMany({ data: suppressionsData });
  const suppressionCount = await prisma.emailSuppression.count({ where: { clientId: tenantA.id } });
  testAssert(suppressionCount === 50, `Seeded 50 suppressions for Tenant Alpha (actual: ${suppressionCount})`);

  // ---------------------------------------------------------------------------
  // 4. List and Segment Setup
  // ---------------------------------------------------------------------------
  console.log("\n📋 [4/10] Setting up Lists and Dynamic Segments...");

  // Create EmailList for Tenant Alpha
  const listAlpha = await prisma.emailList.create({
    data: {
      clientId: tenantA.id,
      name: "Alpha Master Subscribers List",
      description: "Master list containing a blend of active, unsubscribed, and suppressed contacts",
    },
  });

  // Fetch all Alpha contacts to bind members
  const allAlphaContacts = await prisma.emailContact.findMany({
    where: { clientId: tenantA.id },
    orderBy: { id: "asc" },
  });

  // Add 1,200 contacts to the list:
  // - 600 VIP contacts (active)
  // - 400 STANDARD contacts (active)
  // - 100 unsubscribed contacts
  // - 50 suppressed contacts
  // - 50 malformed contacts
  const membersToCreate: any[] = [];
  const listContactPool = [
    ...allAlphaContacts.filter((c) => c.email.startsWith("vip_")).slice(0, 600),
    ...allAlphaContacts.filter((c) => c.email.startsWith("std_")).slice(0, 400),
    ...allAlphaContacts.filter((c) => c.email.startsWith("unsub_")).slice(0, 100),
    ...allAlphaContacts.filter((c) => c.email.startsWith("suppressed_")).slice(0, 50),
    ...allAlphaContacts.filter((c) => malformedEmails.some((m) => c.email.startsWith(m))).slice(0, 50),
  ];

  for (const c of listContactPool) {
    membersToCreate.push({
      listId: listAlpha.id,
      contactId: c.id,
      status: EmailSubscriptionStatus.SUBSCRIBED,
    });
  }

  for (let i = 0; i < membersToCreate.length; i += BATCH_INSERT_SIZE) {
    await prisma.emailListMember.createMany({
      data: membersToCreate.slice(i, i + BATCH_INSERT_SIZE),
    });
  }

  const listMemberCount = await prisma.emailListMember.count({ where: { listId: listAlpha.id } });
  testAssert(listMemberCount === 1200, `List members populated with 1,200 contacts (actual: ${listMemberCount})`);

  // Create Segment A: Direct Criteria (status = SUBSCRIBED AND marketingConsent = true)
  const segmentDirect = await prisma.emailSegment.create({
    data: {
      clientId: tenantA.id,
      name: "All Consented Subscribers",
      criteria: JSON.stringify({
        conjunction: "AND",
        conditions: [
          { field: "status", operator: "EQUALS", value: "SUBSCRIBED" },
          { field: "marketingConsent", operator: "EQUALS", value: true },
        ],
      }),
    },
  });

  // Create Segment B: Attribute Criteria (tier = VIP)
  const segmentAttribute = await prisma.emailSegment.create({
    data: {
      clientId: tenantA.id,
      name: "VIP Tier Members",
      criteria: JSON.stringify({
        conjunction: "AND",
        conditions: [
          { field: "attributes.tier", operator: "EQUALS", value: "VIP" },
        ],
      }),
    },
  });

  testAssert(Boolean(segmentDirect.id && segmentAttribute.id), "Direct and attribute dynamic segments created");

  // Create Template and Campaigns
  const template = await prisma.emailTemplate.create({
    data: {
      clientId: tenantA.id,
      name: "Scale Campaign Template",
      type: "PROMOTIONAL",
    },
  });
  const version = await prisma.emailTemplateVersion.create({
    data: {
      templateId: template.id,
      version: 1,
      subject: "Hello {{firstName}}!",
      htmlContent: "<p>Hello {{firstName}}, special announcement!</p>",
      textContent: "Hello {{firstName}}",
      status: "PUBLISHED",
    },
  });
  await prisma.emailTemplate.update({
    where: { id: template.id },
    data: { activeVersionId: version.id },
  });

  // Campaign 1: List Target (1,200 members)
  const campaignList = await prisma.emailCampaign.create({
    data: {
      clientId: tenantA.id,
      name: "Campaign List Scale",
      type: EmailType.PROMOTIONAL,
      status: EmailCampaignStatus.DRAFT,
      templateVersionId: version.id,
      listId: listAlpha.id,
    },
  });

  // Campaign 2: Segment Target (Attribute: VIP - 750 contacts)
  const campaignSegment = await prisma.emailCampaign.create({
    data: {
      clientId: tenantA.id,
      name: "Campaign Segment VIP",
      type: EmailType.PROMOTIONAL,
      status: EmailCampaignStatus.DRAFT,
      templateVersionId: version.id,
      segmentId: segmentAttribute.id,
    },
  });

  // Campaign 3: Union of List AND Segment (tests deduplication across overlapping sources)
  const campaignUnion = await prisma.emailCampaign.create({
    data: {
      clientId: tenantA.id,
      name: "Campaign Union List and Segment",
      type: EmailType.PROMOTIONAL,
      status: EmailCampaignStatus.DRAFT,
      templateVersionId: version.id,
      listId: listAlpha.id,
      segmentId: segmentAttribute.id,
    },
  });

  // ---------------------------------------------------------------------------
  // 5. Accurate Preview Counts vs Capped Estimates (Thousands of Contacts)
  // ---------------------------------------------------------------------------
  console.log("\n📈 [5/10] Verifying Accurate Uncapped Preview Counts...");

  // Preview Campaign 1 (List of 1,200):
  // Out of 1,200 list members:
  // - 600 VIP (all eligible)
  // - 400 STANDARD (all eligible)
  // - 100 unsubscribed (unsubscribedCount = 100)
  // - 50 suppressed (suppressedCount = 50)
  // - 50 malformed (invalidCount = 50)
  // Expected: totalAudience = 1200, eligibleCount = 1000, unsubscribedCount = 100, suppressedCount = 50, invalidCount = 50
  const previewList = await EmailAudienceResolver.resolvePreview(tenantA.id, {
    listId: listAlpha.id,
    type: EmailType.PROMOTIONAL,
  });

  testAssert(previewList.totalAudience === 1200, `Preview accurately counts total list audience: 1,200 (actual: ${previewList.totalAudience})`);
  testAssert(previewList.unsubscribedCount === 100, `Preview accurately identifies 100 unsubscribed list members (actual: ${previewList.unsubscribedCount})`);
  testAssert(previewList.suppressedCount === 50, `Preview accurately identifies 50 suppressed list members (actual: ${previewList.suppressedCount})`);
  testAssert(previewList.invalidCount === 50, `Preview accurately identifies 50 malformed email addresses (actual: ${previewList.invalidCount})`);
  testAssert(previewList.eligibleCount === 1000, `Preview calculates exactly 1,000 eligible recipients (actual: ${previewList.eligibleCount})`);

  // Preview Campaign 2 (VIP Segment: 750 contacts):
  // All 750 are active, consented, valid email, not suppressed.
  const previewSegment = await EmailAudienceResolver.resolvePreview(tenantA.id, {
    segmentId: segmentAttribute.id,
    type: EmailType.PROMOTIONAL,
  });

  testAssert(previewSegment.totalAudience === 750, `VIP Segment total audience is 750 (actual: ${previewSegment.totalAudience})`);
  testAssert(previewSegment.eligibleCount === 750, `VIP Segment eligible count is 750 (actual: ${previewSegment.eligibleCount})`);
  testAssert(previewSegment.suppressedCount === 0, "VIP Segment has 0 suppressed candidates");
  testAssert(previewSegment.unsubscribedCount === 0, "VIP Segment has 0 unsubscribed candidates");

  // ---------------------------------------------------------------------------
  // 6. Preview Count Equals Snapshot Count at the Same Point in Time
  // ---------------------------------------------------------------------------
  console.log("\n⚖️  [6/10] Verifying Preview Count EQUALS Snapshot Count (Campaign 1)...");

  const snapshotList = await EmailAudienceResolver.createRecipientSnapshot(tenantA.id, {
    id: campaignList.id,
    listId: listAlpha.id,
    type: EmailType.PROMOTIONAL,
  });

  testAssert(
    previewList.totalAudience === snapshotList.totalAudience,
    `Preview total audience (${previewList.totalAudience}) === Snapshot total audience (${snapshotList.totalAudience})`
  );
  testAssert(
    previewList.eligibleCount === snapshotList.eligibleCount,
    `Preview eligible count (${previewList.eligibleCount}) === Snapshot eligible count (${snapshotList.eligibleCount})`
  );
  testAssert(
    previewList.suppressedCount === snapshotList.suppressedCount,
    `Preview suppressed count (${previewList.suppressedCount}) === Snapshot suppressed count (${snapshotList.suppressedCount})`
  );
  testAssert(
    previewList.unsubscribedCount === snapshotList.unsubscribedCount,
    `Preview unsubscribed count (${previewList.unsubscribedCount}) === Snapshot unsubscribed count (${snapshotList.unsubscribedCount})`
  );
  testAssert(
    previewList.invalidCount === snapshotList.invalidCount,
    `Preview invalid count (${previewList.invalidCount}) === Snapshot invalid count (${snapshotList.invalidCount})`
  );
  testAssert(
    snapshotList.snapshotRecipients.length === previewList.eligibleCount,
    `Persisted snapshot recipient records (${snapshotList.snapshotRecipients.length}) strictly matches preview eligible count (${previewList.eligibleCount})`
  );

  // Verify database record count
  const dbRecipientCount = await prisma.emailCampaignRecipient.count({
    where: { campaignId: campaignList.id },
  });
  testAssert(dbRecipientCount === 1000, `Database contains exactly 1,000 persisted recipient rows for Campaign 1 (actual: ${dbRecipientCount})`);

  // Verify campaign totalRecipients field was updated atomically
  const refreshedCampaignList = await prisma.emailCampaign.findUnique({
    where: { id: campaignList.id },
  });
  testAssert(refreshedCampaignList?.totalRecipients === 1000, `EmailCampaign.totalRecipients atomically updated to 1,000 (actual: ${refreshedCampaignList?.totalRecipients})`);

  // ---------------------------------------------------------------------------
  // 7. Deduplication & Duplicate Prevention Across Overlapping Sources
  // ---------------------------------------------------------------------------
  console.log("\n🔄 [7/10] Verifying Deduplication in Union of List & Segment (Campaign 3)...");

  // In Campaign 3:
  // - List has 1,200 members (1,000 eligible: 600 VIP + 400 STANDARD)
  // - Segment has 750 VIP contacts (600 overlap with List, 150 are NOT in the List)
  // Total unique eligible candidates = 1,000 (from list) + 150 (additional from VIP segment) = 1,150.
  const previewUnion = await EmailAudienceResolver.resolvePreview(tenantA.id, {
    listId: listAlpha.id,
    segmentId: segmentAttribute.id,
    type: EmailType.PROMOTIONAL,
  });

  testAssert(previewUnion.eligibleCount === 1150, `Union preview correctly deduplicates overlapping VIP members: 1,150 unique eligible (actual: ${previewUnion.eligibleCount})`);

  const snapshotUnion = await EmailAudienceResolver.createRecipientSnapshot(tenantA.id, {
    id: campaignUnion.id,
    listId: listAlpha.id,
    segmentId: segmentAttribute.id,
    type: EmailType.PROMOTIONAL,
  });

  testAssert(
    previewUnion.eligibleCount === snapshotUnion.eligibleCount,
    `Union Preview eligible (${previewUnion.eligibleCount}) === Union Snapshot eligible (${snapshotUnion.eligibleCount})`
  );
  testAssert(
    snapshotUnion.snapshotRecipients.length === 1150,
    `Persisted snapshot has exactly 1,150 deduplicated recipient records (actual: ${snapshotUnion.snapshotRecipients.length})`
  );

  // Check no duplicates in database
  const unionEmails = snapshotUnion.snapshotRecipients.map((r) => r.email);
  const uniqueUnionEmails = new Set(unionEmails);
  testAssert(
    unionEmails.length === uniqueUnionEmails.size,
    "Zero duplicate emails in union campaign recipient snapshot"
  );

  // ---------------------------------------------------------------------------
  // 8. Immutability of Recipient Metadata Snapshot After Launch
  // ---------------------------------------------------------------------------
  console.log("\n🔒 [8/10] Verifying Recipient Metadata Snapshot Immutability...");

  // Pick an individual snapshot recipient
  const targetRecipient = snapshotList.snapshotRecipients[0];
  testAssert(Boolean(targetRecipient), "Found snapshot record for immutability verification");

  const originalMetadata = JSON.parse(targetRecipient.metadataSnapshot || "{}");
  const targetEmail = targetRecipient.email;
  const originalFirstName = originalMetadata.firstName;
  const originalTier = originalMetadata.tier;

  // Now, maliciously or legitimately mutate the contact in the live EmailContact table:
  // - Change name
  // - Change tier from original to BANNED
  // - Revoke marketing consent
  // - Change email status to UNSUBSCRIBED
  await prisma.emailContact.updateMany({
    where: { clientId: tenantA.id, email: targetEmail },
    data: {
      firstName: "HackedName",
      lastName: "HackedLast",
      hasMarketingConsent: false,
      status: EmailContactStatus.UNSUBSCRIBED,
      metadata: JSON.stringify({ tier: "BANNED", city: "Nowhere" }),
    },
  });

  // Re-fetch the recipient record from the database
  const refreshedRecipient = await prisma.emailCampaignRecipient.findUnique({
    where: { id: targetRecipient.id },
  });

  testAssert(Boolean(refreshedRecipient), "Retrieved recipient record after contact mutation");
  const frozenMetadata = JSON.parse(refreshedRecipient!.metadataSnapshot || "{}");

  testAssert(frozenMetadata.firstName === originalFirstName, `Snapshot firstName remained immutable ('${originalFirstName}') despite contact table update`);
  testAssert(frozenMetadata.tier === originalTier, `Snapshot tier attribute remained immutable ('${originalTier}')`);
  testAssert(refreshedRecipient!.status === "PENDING", "Recipient record remains valid and pending in campaign");

  // Restore contact back to active subscribed state for downstream tests
  await prisma.emailContact.updateMany({
    where: { clientId: tenantA.id, email: targetEmail },
    data: {
      firstName: originalFirstName,
      hasMarketingConsent: true,
      status: EmailContactStatus.SUBSCRIBED,
      metadata: JSON.stringify({ tier: originalTier, city: "New York" }),
    },
  });

  // ---------------------------------------------------------------------------
  // 9. Safe Concurrent Snapshot Creation (Advisory Locks & Idempotency)
  // ---------------------------------------------------------------------------
  console.log("\n⚡ [9/10] Verifying Concurrent Snapshot Safety (Advisory Locks)...");

  // Create Campaign 4 with no prior snapshot
  const campaignConcurrent = await prisma.emailCampaign.create({
    data: {
      clientId: tenantA.id,
      name: "Campaign Concurrent Race",
      type: EmailType.PROMOTIONAL,
      status: EmailCampaignStatus.DRAFT,
      templateVersionId: version.id,
      segmentId: segmentAttribute.id, // 750 VIP recipients
    },
  });

  // Fire 3 simultaneous concurrent invocations of createRecipientSnapshot
  const concurrentPromises = [
    EmailAudienceResolver.createRecipientSnapshot(tenantA.id, {
      id: campaignConcurrent.id,
      segmentId: segmentAttribute.id,
      type: EmailType.PROMOTIONAL,
    }),
    EmailAudienceResolver.createRecipientSnapshot(tenantA.id, {
      id: campaignConcurrent.id,
      segmentId: segmentAttribute.id,
      type: EmailType.PROMOTIONAL,
    }),
    EmailAudienceResolver.createRecipientSnapshot(tenantA.id, {
      id: campaignConcurrent.id,
      segmentId: segmentAttribute.id,
      type: EmailType.PROMOTIONAL,
    }),
  ];

  const results = await Promise.all(concurrentPromises);

  testAssert(
    results[0].eligibleCount === 750 &&
    results[1].eligibleCount === 750 &&
    results[2].eligibleCount === 750,
    "All 3 concurrent snapshot invocations succeeded without error and returned 750 eligible"
  );

  const concurrentDbCount = await prisma.emailCampaignRecipient.count({
    where: { campaignId: campaignConcurrent.id },
  });

  testAssert(
    concurrentDbCount === 750,
    `Concurrent execution created exactly 750 recipient records without race duplication (actual: ${concurrentDbCount})`
  );

  // ---------------------------------------------------------------------------
  // 10. Multi-Tenant Isolation & Deterministic Ordering
  // ---------------------------------------------------------------------------
  console.log("\n🏢 [10/10] Verifying Multi-Tenant Isolation & Deterministic Ordering...");

  // Tenant B attempts to resolve Campaign 1 (belongs to Tenant A)
  let tenantCrossAccessBlocked = false;
  try {
    await EmailCampaignService.previewCampaign(tenantB.id, campaignList.id);
  } catch (err: any) {
    if (err.message.includes("not found for tenant")) {
      tenantCrossAccessBlocked = true;
    }
  }
  testAssert(tenantCrossAccessBlocked, "Tenant Beta strictly blocked from previewing Tenant Alpha campaign");

  // Tenant B creates its own campaign targeting Tenant B's contacts
  const campaignBeta = await prisma.emailCampaign.create({
    data: {
      clientId: tenantB.id,
      name: "Beta Promotional Blast",
      type: EmailType.PROMOTIONAL,
      status: EmailCampaignStatus.DRAFT,
      templateVersionId: version.id,
    },
  });

  // Tenant B preview with criteria matching Tenant B contacts
  const segmentBeta = await prisma.emailSegment.create({
    data: {
      clientId: tenantB.id,
      name: "Beta Segment",
      criteria: JSON.stringify({
        conjunction: "AND",
        conditions: [
          { field: "status", operator: "EQUALS", value: "SUBSCRIBED" },
        ],
      }),
    },
  });

  const previewBeta = await EmailAudienceResolver.resolvePreview(tenantB.id, {
    segmentId: segmentBeta.id,
    type: EmailType.PROMOTIONAL,
  });

  testAssert(previewBeta.totalAudience === 500, `Tenant Beta audience is exactly 500 (actual: ${previewBeta.totalAudience})`);
  testAssert(previewBeta.eligibleCount === 500, "Zero leakage of Tenant Alpha's 2,050 contacts into Tenant Beta");

  // Verify Deterministic Ordering of Snapshot Recipients
  const snapshotBeta = await EmailAudienceResolver.createRecipientSnapshot(tenantB.id, {
    id: campaignBeta.id,
    segmentId: segmentBeta.id,
    type: EmailType.PROMOTIONAL,
  });

  let isSorted = true;
  for (let i = 1; i < snapshotBeta.snapshotRecipients.length; i++) {
    if (snapshotBeta.snapshotRecipients[i].id < snapshotBeta.snapshotRecipients[i - 1].id) {
      isSorted = false;
      break;
    }
  }
  testAssert(isSorted, "Recipient snapshot records strictly preserve deterministic ordering (id: asc)");

  // Clean up
  console.log("\n🧹 Cleaning up test artifacts...");
  await cleanDatabase();

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------
  console.log("\n==================================================================");
  console.log(`Audience Scale Suite Summary: ${passed} PASSED, ${failed} FAILED`);
  console.log("==================================================================\n");

  if (failed > 0) {
    process.exit(1);
  }
}

runAudienceScaleSuite().catch((err) => {
  console.error("Fatal error during Audience Scale verification:", err);
  process.exit(1);
});
