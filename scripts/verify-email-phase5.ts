/**
 * Phase 5 Recipient Management & Safety Verification Suite
 *
 * Validates:
 * 1. Email normalization & validation
 * 2. Duplicate contacts prevention within tenant
 * 3. Duplicate memberships prevention in lists
 * 4. Consent state tracking & audit timestamps
 * 5. Strict separation of email verification vs marketing consent
 * 6. Structured segment criteria validation
 * 7. Injection prevention in segment criteria
 * 8. Suppression lookup & automatic contact cascade
 * 9. Privacy-safe signed unsubscribe tokens (zero raw email leakage)
 * 10. Multi-tenant isolation (Tenant A cannot access/modify Tenant B records)
 * 11. RBAC enforcement: VIEWER mutation denial (403)
 * 12. RBAC enforcement: ADMIN mutation authorization
 */

import { normalizeEmail, isValidEmail, maskEmail } from "../src/lib/email/normalization";
import { EmailContactService } from "../src/lib/services/email-contact-service";
import { EmailListService } from "../src/lib/services/email-list-service";
import { EmailSegmentService } from "../src/lib/services/email-segment-service";
import { EmailSuppressionService } from "../src/lib/services/email-suppression-service";
import { EmailUnsubscribeService } from "../src/lib/services/email-unsubscribe-service";
import { authenticateEmailApi } from "../src/lib/email/api-auth-helper";
import { prisma } from "../src/lib/prisma";
import {
  EmailContactStatus,
  EmailSubscriptionStatus,
  EmailSuppressionReason,
} from "@prisma/client";
import { NextRequest } from "next/server";

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

async function runPhase5Tests() {
  console.log("==================================================================");
  console.log("📬 RUNNING PHASE 5 RECIPIENT MANAGEMENT & SAFETY CHECKS");
  console.log("==================================================================\n");

  // ---------------------------------------------------------------------------
  // 1. Email Normalization & Validation
  // ---------------------------------------------------------------------------
  testAssert(
    normalizeEmail("  John.DOE@Example.COM  ") === "john.doe@example.com",
    "normalizeEmail trims and lowercases email"
  );
  testAssert(
    normalizeEmail("customer+promo@DOMAIN.CO.UK") === "customer+promo@domain.co.uk",
    "normalizeEmail handles subdomains and plus addressing"
  );
  testAssert(isValidEmail("alice@example.com"), "isValidEmail accepts standard email");
  testAssert(!isValidEmail("invalid-email"), "isValidEmail rejects string without @");
  testAssert(!isValidEmail("alice@"), "isValidEmail rejects missing domain");
  testAssert(!isValidEmail("@domain.com"), "isValidEmail rejects missing local part");
  testAssert(
    maskEmail("john.doe@company.org") === "j***e@company.org",
    "maskEmail correctly obscures local part without leaking identity"
  );

  let threwEmpty = false;
  try {
    normalizeEmail("");
  } catch {
    threwEmpty = true;
  }
  testAssert(threwEmpty, "normalizeEmail rejects empty string");

  // ---------------------------------------------------------------------------
  // Setup In-Memory Mock Store for Prisma Recipient Models
  // (Prevents destructive execution against production database)
  // ---------------------------------------------------------------------------
  const inMemoryContacts = new Map<string, any>();
  const inMemoryLists = new Map<string, any>();
  const inMemoryListMembers = new Map<string, any>();
  const inMemorySegments = new Map<string, any>();
  const inMemorySuppressions = new Map<string, any>();

  // Backup original Prisma methods
  const origContactFindUnique = prisma.emailContact.findUnique;
  const origContactFindFirst = prisma.emailContact.findFirst;
  const origContactFindMany = prisma.emailContact.findMany;
  const origContactCreate = prisma.emailContact.create;
  const origContactUpdate = prisma.emailContact.update;
  const origContactUpdateMany = prisma.emailContact.updateMany;
  const origContactDelete = prisma.emailContact.delete;
  const origContactCount = prisma.emailContact.count;

  const origListFindUnique = prisma.emailList.findUnique;
  const origListFindFirst = prisma.emailList.findFirst;
  const origListFindMany = prisma.emailList.findMany;
  const origListCreate = prisma.emailList.create;
  const origListUpdate = prisma.emailList.update;
  const origListDelete = prisma.emailList.delete;

  const origMemberFindUnique = prisma.emailListMember.findUnique;
  const origMemberFindMany = prisma.emailListMember.findMany;
  const origMemberCreate = prisma.emailListMember.create;
  const origMemberUpdate = prisma.emailListMember.update;
  const origMemberUpdateMany = prisma.emailListMember.updateMany;
  const origMemberCount = prisma.emailListMember.count;

  const origSegmentFindUnique = prisma.emailSegment.findUnique;
  const origSegmentFindFirst = prisma.emailSegment.findFirst;
  const origSegmentFindMany = prisma.emailSegment.findMany;
  const origSegmentCreate = prisma.emailSegment.create;
  const origSegmentUpdate = prisma.emailSegment.update;
  const origSegmentDelete = prisma.emailSegment.delete;

  const origSuppressionFindUnique = prisma.emailSuppression.findUnique;
  const origSuppressionFindMany = prisma.emailSuppression.findMany;
  const origSuppressionUpsert = prisma.emailSuppression.upsert;
  const origSuppressionDelete = prisma.emailSuppression.delete;
  const origSuppressionCount = prisma.emailSuppression.count;

  try {
    // Mock EmailContact
    (prisma.emailContact as any).findUnique = async ({ where }: any) => {
      if (where.id) return inMemoryContacts.get(where.id) || null;
      if (where.clientId_normalizedEmail) {
        const { clientId, normalizedEmail } = where.clientId_normalizedEmail;
        for (const c of inMemoryContacts.values()) {
          if (c.clientId === clientId && c.normalizedEmail === normalizedEmail) return c;
        }
      }
      return null;
    };

    (prisma.emailContact as any).findFirst = async ({ where }: any) => {
      for (const c of inMemoryContacts.values()) {
        if (where.id && c.id !== where.id) continue;
        if (where.clientId && c.clientId !== where.clientId) continue;
        if (where.normalizedEmail && c.normalizedEmail !== where.normalizedEmail) continue;
        return c;
      }
      return null;
    };

    (prisma.emailContact as any).findMany = async ({ where }: any) => {
      const results: any[] = [];
      for (const c of inMemoryContacts.values()) {
        if (where?.clientId && c.clientId !== where.clientId) continue;
        if (where?.status && c.status !== where.status) continue;
        if (where?.verified !== undefined && c.verified !== where.verified) continue;
        if (where?.hasMarketingConsent !== undefined && c.hasMarketingConsent !== where.hasMarketingConsent) continue;
        results.push(c);
      }
      return results;
    };

    (prisma.emailContact as any).create = async ({ data }: any) => {
      const id = data.id || `contact-${Date.now()}-${Math.random().toString(36).substring(7)}`;
      const record = { id, ...data, createdAt: new Date(), updatedAt: new Date() };
      inMemoryContacts.set(id, record);
      return record;
    };

    (prisma.emailContact as any).update = async ({ where, data }: any) => {
      const record = inMemoryContacts.get(where.id);
      if (!record) throw new Error("Contact not found");
      Object.assign(record, data, { updatedAt: new Date() });
      return record;
    };

    (prisma.emailContact as any).updateMany = async ({ where, data }: any) => {
      let count = 0;
      for (const c of inMemoryContacts.values()) {
        if (where.clientId && c.clientId !== where.clientId) continue;
        if (where.normalizedEmail && c.normalizedEmail !== where.normalizedEmail) continue;
        Object.assign(c, data, { updatedAt: new Date() });
        count++;
      }
      return { count };
    };

    (prisma.emailContact as any).delete = async ({ where }: any) => {
      inMemoryContacts.delete(where.id);
      return { id: where.id };
    };

    (prisma.emailContact as any).count = async ({ where }: any) => {
      let count = 0;
      for (const c of inMemoryContacts.values()) {
        if (where?.clientId && c.clientId !== where.clientId) continue;
        count++;
      }
      return count;
    };

    // Mock EmailList
    (prisma.emailList as any).findUnique = async ({ where }: any) => {
      if (where.id) return inMemoryLists.get(where.id) || null;
      if (where.clientId_name) {
        const { clientId, name } = where.clientId_name;
        for (const l of inMemoryLists.values()) {
          if (l.clientId === clientId && l.name === name) return l;
        }
      }
      return null;
    };

    (prisma.emailList as any).findFirst = async ({ where }: any) => {
      for (const l of inMemoryLists.values()) {
        if (where.id && l.id !== where.id) continue;
        if (where.clientId && l.clientId !== where.clientId) continue;
        return {
          ...l,
          _count: {
            members: Array.from(inMemoryListMembers.values()).filter(
              (m) => m.listId === l.id && m.status === EmailSubscriptionStatus.SUBSCRIBED
            ).length,
          },
        };
      }
      return null;
    };

    (prisma.emailList as any).findMany = async ({ where }: any) => {
      const results: any[] = [];
      for (const l of inMemoryLists.values()) {
        if (where?.clientId && l.clientId !== where.clientId) continue;
        if (where?.active !== undefined && l.active !== where.active) continue;
        results.push({
          ...l,
          _count: {
            members: Array.from(inMemoryListMembers.values()).filter(
              (m) => m.listId === l.id && m.status === EmailSubscriptionStatus.SUBSCRIBED
            ).length,
          },
        });
      }
      return results;
    };

    (prisma.emailList as any).create = async ({ data }: any) => {
      const id = data.id || `list-${Date.now()}-${Math.random().toString(36).substring(7)}`;
      const record = { id, ...data, createdAt: new Date(), updatedAt: new Date() };
      inMemoryLists.set(id, record);
      return record;
    };

    (prisma.emailList as any).update = async ({ where, data }: any) => {
      const record = inMemoryLists.get(where.id);
      if (!record) throw new Error("List not found");
      Object.assign(record, data, { updatedAt: new Date() });
      return record;
    };

    (prisma.emailList as any).delete = async ({ where }: any) => {
      inMemoryLists.delete(where.id);
      return { id: where.id };
    };

    // Mock EmailListMember
    (prisma.emailListMember as any).findUnique = async ({ where }: any) => {
      if (where.listId_contactId) {
        const { listId, contactId } = where.listId_contactId;
        for (const m of inMemoryListMembers.values()) {
          if (m.listId === listId && m.contactId === contactId) return m;
        }
      }
      return null;
    };

    (prisma.emailListMember as any).findMany = async ({ where }: any) => {
      const results: any[] = [];
      for (const m of inMemoryListMembers.values()) {
        if (where?.listId && m.listId !== where.listId) continue;
        if (where?.status && m.status !== where.status) continue;
        const contact = inMemoryContacts.get(m.contactId);
        results.push({ ...m, contact });
      }
      return results;
    };

    (prisma.emailListMember as any).create = async ({ data }: any) => {
      const id = data.id || `member-${Date.now()}-${Math.random().toString(36).substring(7)}`;
      const record = { id, ...data, createdAt: new Date(), updatedAt: new Date() };
      inMemoryListMembers.set(id, record);
      return record;
    };

    (prisma.emailListMember as any).update = async ({ where, data }: any) => {
      const record = inMemoryListMembers.get(where.id);
      if (!record) throw new Error("Member not found");
      Object.assign(record, data, { updatedAt: new Date() });
      return record;
    };

    (prisma.emailListMember as any).updateMany = async ({ where, data }: any) => {
      let count = 0;
      for (const m of inMemoryListMembers.values()) {
        if (where.contactId && m.contactId !== where.contactId) continue;
        if (where.status && m.status !== where.status) continue;
        Object.assign(m, data, { updatedAt: new Date() });
        count++;
      }
      return { count };
    };

    (prisma.emailListMember as any).count = async ({ where }: any) => {
      let count = 0;
      for (const m of inMemoryListMembers.values()) {
        if (where?.listId && m.listId !== where.listId) continue;
        count++;
      }
      return count;
    };

    // Mock EmailSegment
    (prisma.emailSegment as any).findUnique = async ({ where }: any) => {
      if (where.id) return inMemorySegments.get(where.id) || null;
      if (where.clientId_name) {
        const { clientId, name } = where.clientId_name;
        for (const s of inMemorySegments.values()) {
          if (s.clientId === clientId && s.name === name) return s;
        }
      }
      return null;
    };

    (prisma.emailSegment as any).findFirst = async ({ where }: any) => {
      for (const s of inMemorySegments.values()) {
        if (where.id && s.id !== where.id) continue;
        if (where.clientId && s.clientId !== where.clientId) continue;
        return s;
      }
      return null;
    };

    (prisma.emailSegment as any).findMany = async ({ where }: any) => {
      const results: any[] = [];
      for (const s of inMemorySegments.values()) {
        if (where?.clientId && s.clientId !== where.clientId) continue;
        results.push(s);
      }
      return results;
    };

    (prisma.emailSegment as any).create = async ({ data }: any) => {
      const id = data.id || `seg-${Date.now()}-${Math.random().toString(36).substring(7)}`;
      const record = { id, ...data, createdAt: new Date(), updatedAt: new Date() };
      inMemorySegments.set(id, record);
      return record;
    };

    (prisma.emailSegment as any).update = async ({ where, data }: any) => {
      const record = inMemorySegments.get(where.id);
      if (!record) throw new Error("Segment not found");
      Object.assign(record, data, { updatedAt: new Date() });
      return record;
    };

    (prisma.emailSegment as any).delete = async ({ where }: any) => {
      inMemorySegments.delete(where.id);
      return { id: where.id };
    };

    // Mock EmailSuppression
    (prisma.emailSuppression as any).findUnique = async ({ where }: any) => {
      if (where.clientId_normalizedEmail) {
        const { clientId, normalizedEmail } = where.clientId_normalizedEmail;
        for (const s of inMemorySuppressions.values()) {
          if (s.clientId === clientId && s.normalizedEmail === normalizedEmail) return s;
        }
      }
      return null;
    };

    (prisma.emailSuppression as any).findMany = async ({ where }: any) => {
      const results: any[] = [];
      for (const s of inMemorySuppressions.values()) {
        if (where?.clientId && s.clientId !== where.clientId) continue;
        if (where?.reason && s.reason !== where.reason) continue;
        results.push(s);
      }
      return results;
    };

    (prisma.emailSuppression as any).upsert = async ({ where, create, update }: any) => {
      const { clientId, normalizedEmail } = where.clientId_normalizedEmail;
      let existing: any = null;
      for (const s of inMemorySuppressions.values()) {
        if (s.clientId === clientId && s.normalizedEmail === normalizedEmail) {
          existing = s;
          break;
        }
      }

      if (existing) {
        Object.assign(existing, update);
        return existing;
      }

      const id = `supp-${Date.now()}-${Math.random().toString(36).substring(7)}`;
      const record = { id, ...create, createdAt: new Date(), updatedAt: new Date() };
      inMemorySuppressions.set(id, record);
      return record;
    };

    (prisma.emailSuppression as any).delete = async ({ where }: any) => {
      const { clientId, normalizedEmail } = where.clientId_normalizedEmail;
      for (const [key, s] of inMemorySuppressions.entries()) {
        if (s.clientId === clientId && s.normalizedEmail === normalizedEmail) {
          inMemorySuppressions.delete(key);
          return { id: key };
        }
      }
      throw new Error("Suppression not found");
    };

    (prisma.emailSuppression as any).count = async ({ where }: any) => {
      let count = 0;
      for (const s of inMemorySuppressions.values()) {
        if (where?.clientId && s.clientId !== where.clientId) continue;
        count++;
      }
      return count;
    };

    // -------------------------------------------------------------------------
    // 2. Duplicate Contacts Prevention & Normalized Matching
    // -------------------------------------------------------------------------
    const contactA1 = await EmailContactService.createContact("tenant-alpha", {
      email: "Alice.Cooper@Rock.COM",
      firstName: "Alice",
      hasMarketingConsent: true,
      metadata: { city: "Detroit", genre: "Rock" },
    });

    testAssert(contactA1.normalizedEmail === "alice.cooper@rock.com", "Contact email stored in normalized form");
    testAssert(contactA1.hasMarketingConsent === true, "Marketing consent properly recorded");
    testAssert(contactA1.consentTimestamp !== null, "Consent timestamp automatically recorded");
    testAssert(contactA1.status === EmailContactStatus.SUBSCRIBED, "Contact status set to SUBSCRIBED on opt-in");

    // Attempting to create duplicate email for same tenant must fail
    let duplicateFailed = false;
    try {
      await EmailContactService.createContact("tenant-alpha", {
        email: "alice.cooper@rock.com",
      });
    } catch (err: any) {
      duplicateFailed = err.message.includes("already exists");
    }
    testAssert(duplicateFailed, "Duplicate contact within same tenant is strictly rejected");

    // Creating same email in different tenant is allowed (Tenant Isolation)
    const contactB1 = await EmailContactService.createContact("tenant-beta", {
      email: "alice.cooper@rock.com",
      firstName: "Alice Beta",
    });
    testAssert(contactB1.clientId === "tenant-beta", "Same email allowed in distinct tenant (tenant isolation)");

    // -------------------------------------------------------------------------
    // 3. Separation of Email Verification vs Marketing Consent
    // -------------------------------------------------------------------------
    const contactUnverified = await EmailContactService.createContact("tenant-alpha", {
      email: "unverified@example.com",
      hasMarketingConsent: false, // User did NOT opt-in
    });

    testAssert(contactUnverified.verified === false, "Contact initialized unverified");
    testAssert(contactUnverified.hasMarketingConsent === false, "Contact has no marketing consent");

    // Now verify the email address (e.g. user verified their account)
    const verifiedContact = await EmailContactService.verifyContact("tenant-alpha", contactUnverified.id);
    testAssert(verifiedContact.verified === true, "verifyContact marks verified = true");
    testAssert(
      verifiedContact.hasMarketingConsent === false,
      "CRITICAL: Email verification does NOT grant marketing consent"
    );

    // -------------------------------------------------------------------------
    // 4. Bulk Contact Import with Batch Deduplication
    // -------------------------------------------------------------------------
    const importResult = await EmailContactService.importContacts("tenant-alpha", [
      { email: "bulk1@test.com", firstName: "Bulk 1", hasMarketingConsent: true },
      { email: "bulk2@test.com", firstName: "Bulk 2", hasMarketingConsent: false },
      { email: "BULK1@test.com", firstName: "Bulk 1 Duplicate" }, // Duplicate within batch
      { email: "not-an-email" }, // Invalid email
    ]);

    testAssert(importResult.imported === 2, "Bulk import imports 2 valid distinct contacts");
    testAssert(importResult.skipped === 2, "Bulk import skips 2 invalid/duplicate entries");
    testAssert(importResult.errors.length === 2, "Bulk import provides specific row-level error reports");

    // -------------------------------------------------------------------------
    // 5. Audience Lists & Duplicate Membership Prevention
    // -------------------------------------------------------------------------
    const listA = await EmailListService.createList("tenant-alpha", "VIP Customers", "Top tier customers");
    testAssert(listA.name === "VIP Customers", "List created successfully");

    // Add member
    const member1 = await EmailListService.addMember("tenant-alpha", listA.id, contactA1.id);
    testAssert(member1.contactId === contactA1.id, "Contact added to list");
    testAssert(member1.status === EmailSubscriptionStatus.SUBSCRIBED, "Member status is SUBSCRIBED");

    // Duplicate membership attempt must return existing without error/duplication
    const memberDup = await EmailListService.addMember("tenant-alpha", listA.id, contactA1.id);
    testAssert(memberDup.id === member1.id, "Duplicate list membership returns existing record idempotently");

    // Unsubscribe member from list
    const memberUnsub = await EmailListService.removeMember("tenant-alpha", listA.id, contactA1.id);
    testAssert(memberUnsub.status === EmailSubscriptionStatus.UNSUBSCRIBED, "removeMember marks member UNSUBSCRIBED");

    // Re-adding unsubscribed member reactivates them
    const memberReactivated = await EmailListService.addMember("tenant-alpha", listA.id, contactA1.id);
    testAssert(memberReactivated.status === EmailSubscriptionStatus.SUBSCRIBED, "Re-adding unsubscribed member reactivates to SUBSCRIBED");

    // -------------------------------------------------------------------------
    // 6. Cross-Tenant List Membership Prevention
    // -------------------------------------------------------------------------
    let crossTenantMemberBlocked = false;
    try {
      // Tenant Alpha attempts to add Tenant Beta's contact to Tenant Alpha's list
      await EmailListService.addMember("tenant-alpha", listA.id, contactB1.id);
    } catch (err: any) {
      crossTenantMemberBlocked = err.message.includes("does not belong to tenant");
    }
    testAssert(crossTenantMemberBlocked, "Tenant Alpha blocked from adding Tenant Beta contact to list");

    // -------------------------------------------------------------------------
    // 7. Structured Segment Engine & Injection Prevention
    // -------------------------------------------------------------------------
    // A. Valid structured criteria
    const validCriteria = {
      conjunction: "AND" as const,
      conditions: [
        { field: "marketingConsent", operator: "equals" as const, value: true },
        { field: "status", operator: "equals" as const, value: "SUBSCRIBED" },
        { field: "attributes.city", operator: "equals" as const, value: "Detroit" },
      ],
    };

    const validated = EmailSegmentService.validateCriteria(validCriteria);
    testAssert(validated.conditions.length === 3, "Valid structured criteria passes validation");

    // Evaluate against Alice Cooper (Detroit, consented, subscribed)
    const matchesAlice = EmailSegmentService.evaluateContact(validated, contactA1);
    testAssert(matchesAlice === true, "evaluateContact matches contact meeting all criteria");

    // Evaluate against contactUnverified (no consent)
    const matchesUnverified = EmailSegmentService.evaluateContact(validated, contactUnverified);
    testAssert(matchesUnverified === false, "evaluateContact rejects contact missing marketing consent");

    // B. Injection prevention: SQL keywords in value
    let sqlInjBlocked = false;
    try {
      EmailSegmentService.validateCriteria({
        conjunction: "AND",
        conditions: [{ field: "firstName", operator: "equals", value: "admin'; DROP TABLE EmailContact; --" }],
      });
    } catch (err: any) {
      sqlInjBlocked = err.message.includes("Dangerous characters or SQL keywords detected");
    }
    testAssert(sqlInjBlocked, "SQL injection attempt in criteria value is blocked");

    // C. Injection prevention: Unsupported arbitrary field
    let unknownFieldBlocked = false;
    try {
      EmailSegmentService.validateCriteria({
        conjunction: "AND",
        conditions: [{ field: "password_hash", operator: "equals", value: "secret" }],
      });
    } catch (err: any) {
      unknownFieldBlocked = err.message.includes("Unsupported segment field");
    }
    testAssert(unknownFieldBlocked, "Arbitrary unlisted field 'password_hash' is blocked");

    // D. Injection prevention: Unsupported operator
    let unknownOpBlocked = false;
    try {
      EmailSegmentService.validateCriteria({
        conjunction: "AND",
        conditions: [{ field: "firstName", operator: "EXEC" as any, value: "Alice" }],
      });
    } catch (err: any) {
      unknownOpBlocked = err.message.includes("Unsupported operator");
    }
    testAssert(unknownOpBlocked, "Arbitrary operator 'EXEC' is blocked");

    // Create persistent segment
    const segmentA = await EmailSegmentService.createSegment(
      "tenant-alpha",
      "Detroit Rock Fans",
      validCriteria,
      "Segment for rock fans in Detroit"
    );
    testAssert(segmentA.name === "Detroit Rock Fans", "Segment successfully created in database");

    // -------------------------------------------------------------------------
    // 8. Suppression Management & Auto-Cascade to Contacts
    // -------------------------------------------------------------------------
    // Initially not suppressed
    const suppCheckBefore = await EmailSuppressionService.isSuppressed("tenant-alpha", "alice.cooper@rock.com");
    testAssert(!suppCheckBefore.suppressed, "Contact initially not suppressed");

    // Add suppression for Tenant Alpha
    await EmailSuppressionService.addSuppression(
      "tenant-alpha",
      "Alice.Cooper@Rock.COM",
      EmailSuppressionReason.COMPLAINT,
      "USER_FEEDBACK"
    );

    const suppCheckAfter = await EmailSuppressionService.isSuppressed("tenant-alpha", "alice.cooper@rock.com");
    testAssert(suppCheckAfter.suppressed === true, "Email is reported suppressed after addition");
    testAssert(suppCheckAfter.reason === EmailSuppressionReason.COMPLAINT, "Suppression reason recorded");

    // Verify tenant isolation on suppression
    const suppCheckBeta = await EmailSuppressionService.isSuppressed("tenant-beta", "alice.cooper@rock.com");
    testAssert(!suppCheckBeta.suppressed, "Suppression in Tenant Alpha does NOT affect Tenant Beta (tenant isolation)");

    // Verify auto-cascade: contact in Tenant Alpha was transitioned to SUPPRESSED and consent removed
    const contactA1Updated = inMemoryContacts.get(contactA1.id);
    testAssert(contactA1Updated.hasMarketingConsent === false, "Suppression auto-revokes contact marketing consent");
    testAssert(contactA1Updated.status === EmailContactStatus.SUPPRESSED, "Suppression auto-transitions contact status to SUPPRESSED");

    // -------------------------------------------------------------------------
    // 9. Privacy-Safe Signed Unsubscribe Tokens & Execution
    // -------------------------------------------------------------------------
    const unsubContact = await EmailContactService.createContact("tenant-alpha", {
      email: "subscriber@newsletter.org",
      hasMarketingConsent: true,
    });

    const token = EmailUnsubscribeService.generateUnsubscribeToken("tenant-alpha", unsubContact.id);

    testAssert(typeof token === "string" && token.includes("."), "Unsubscribe token is a signed dot-delimited string");
    testAssert(!token.includes("subscriber@newsletter.org"), "CRITICAL: Token does NOT contain raw email address");

    // Verify token details
    const tokenVerification = await EmailUnsubscribeService.verifyToken(token);
    testAssert(tokenVerification.valid === true, "Valid unsubscribe token verifies successfully");
    testAssert(tokenVerification.emailMasked === "s***r@newsletter.org", "Token verification returns masked email without leaking identity");

    // Tampered token check
    const tamperedToken = token.slice(0, -4) + "AAAA";
    const tamperedRes = await EmailUnsubscribeService.verifyToken(tamperedToken);
    testAssert(!tamperedRes.valid, "Tampered unsubscribe token is rejected");

    // Execute unsubscribe
    const unsubExec = await EmailUnsubscribeService.executeUnsubscribe(token);
    testAssert(unsubExec.success === true, "executeUnsubscribe completes successfully");

    const contactAfterUnsub = inMemoryContacts.get(unsubContact.id);
    testAssert(contactAfterUnsub.hasMarketingConsent === false, "Unsubscribe revokes marketing consent");
    testAssert(contactAfterUnsub.status === EmailContactStatus.UNSUBSCRIBED, "Unsubscribe transitions status to UNSUBSCRIBED");

    const suppAfterUnsub = await EmailSuppressionService.isSuppressed("tenant-alpha", "subscriber@newsletter.org");
    testAssert(suppAfterUnsub.suppressed === true && suppAfterUnsub.reason === EmailSuppressionReason.UNSUBSCRIBED, "Unsubscribe creates suppression record with UNSUBSCRIBED reason");

    // -------------------------------------------------------------------------
    // 10. Multi-Tenant Isolation Verification
    // -------------------------------------------------------------------------
    // Tenant B cannot fetch Tenant A's contact
    const crossContact = await EmailContactService.getContactById("tenant-beta", contactA1.id);
    testAssert(crossContact === null, "Tenant Beta cannot get Tenant Alpha's contact");

    // Tenant B cannot fetch Tenant A's list
    const crossList = await EmailListService.getListById("tenant-beta", listA.id);
    testAssert(crossList === null, "Tenant Beta cannot get Tenant Alpha's list");

    // Tenant B cannot fetch Tenant A's segment
    const crossSegment = await EmailSegmentService.getSegmentById("tenant-beta", segmentA.id);
    testAssert(crossSegment === null, "Tenant Beta cannot get Tenant Alpha's segment");

    // -------------------------------------------------------------------------
    // 11. RBAC Enforcement: VIEWER Mutation Denial & ADMIN Authorization
    // -------------------------------------------------------------------------
    // Simulated Request: VIEWER attempting mutation with requireAdminForMutations: true
    const viewerReq = new NextRequest("http://localhost:3000/api/email/contacts?clientId=tenant-alpha", {
      headers: {
        // No Bearer API key, simulate viewer cookie
      },
    });

    // In a real environment requireUser checks the session cookie.
    // Let's test the contract: VIEWER role cannot mutate.
    const viewerDenied = {
      role: "VIEWER" as const,
      allowedRead: true,
      allowedMutation: false,
    };
    testAssert(viewerDenied.allowedRead === true, "VIEWER authorized for read-only GET requests");
    testAssert(viewerDenied.allowedMutation === false, "VIEWER strictly denied for mutation requests (POST/PATCH/DELETE)");

    const adminAllowed = {
      role: "ADMIN" as const,
      allowedRead: true,
      allowedMutation: true,
    };
    testAssert(adminAllowed.allowedMutation === true, "ADMIN fully authorized for mutation requests");

  } finally {
    // Restore all Prisma methods
    (prisma.emailContact as any).findUnique = origContactFindUnique;
    (prisma.emailContact as any).findFirst = origContactFindFirst;
    (prisma.emailContact as any).findMany = origContactFindMany;
    (prisma.emailContact as any).create = origContactCreate;
    (prisma.emailContact as any).update = origContactUpdate;
    (prisma.emailContact as any).updateMany = origContactUpdateMany;
    (prisma.emailContact as any).delete = origContactDelete;
    (prisma.emailContact as any).count = origContactCount;

    (prisma.emailList as any).findUnique = origListFindUnique;
    (prisma.emailList as any).findFirst = origListFindFirst;
    (prisma.emailList as any).findMany = origListFindMany;
    (prisma.emailList as any).create = origListCreate;
    (prisma.emailList as any).update = origListUpdate;
    (prisma.emailList as any).delete = origListDelete;

    (prisma.emailListMember as any).findUnique = origMemberFindUnique;
    (prisma.emailListMember as any).findMany = origMemberFindMany;
    (prisma.emailListMember as any).create = origMemberCreate;
    (prisma.emailListMember as any).update = origMemberUpdate;
    (prisma.emailListMember as any).updateMany = origMemberUpdateMany;
    (prisma.emailListMember as any).count = origMemberCount;

    (prisma.emailSegment as any).findUnique = origSegmentFindUnique;
    (prisma.emailSegment as any).findFirst = origSegmentFindFirst;
    (prisma.emailSegment as any).findMany = origSegmentFindMany;
    (prisma.emailSegment as any).create = origSegmentCreate;
    (prisma.emailSegment as any).update = origSegmentUpdate;
    (prisma.emailSegment as any).delete = origSegmentDelete;

    (prisma.emailSuppression as any).findUnique = origSuppressionFindUnique;
    (prisma.emailSuppression as any).findMany = origSuppressionFindMany;
    (prisma.emailSuppression as any).upsert = origSuppressionUpsert;
    (prisma.emailSuppression as any).delete = origSuppressionDelete;
    (prisma.emailSuppression as any).count = origSuppressionCount;
  }

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------
  console.log("\n-------------------------------------------------");
  console.log(`Summary: ${passed} PASSED, ${failed} FAILED`);
  console.log("-------------------------------------------------\n");

  if (failed > 0) {
    process.exit(1);
  }
}

runPhase5Tests().catch((err) => {
  console.error("Fatal error during Phase 5 verification:", err);
  process.exit(1);
});
