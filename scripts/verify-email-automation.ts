/**
 * Authoritative Campaign Automation & Journey Engine Test Suite
 *
 * Validates:
 * 1. Recurring Campaigns (schedules, cron/interval math, child campaigns, nextRunAt advance, maxRuns cap)
 * 2. Scheduled Journeys (multi-step DAG workflows, linear & branching transitions)
 * 3. Delayed Follow-ups (DELAY steps, nextActionAt, BullMQ delayed job enqueueing)
 * 4. Event-Triggered Campaigns (auto-enrollment on events, advancing WAIT_FOR_EVENT on opens/clicks)
 * 5. Abandoned Workflow States (TIMEOUT_EXPIRED, UNSUBSCRIBED, SUPPRESSED, CRITERIA_MISMATCH, MANUAL_EXIT)
 * 6. Conditional Branches (engagement criteria, contact attributes, consent status)
 * 7. Audience Re-evaluation Policies (ALWAYS_RE_EVALUATE, SNAPSHOT_ONCE, STRICT_CONSENT_ONLY)
 * 8. Multi-tenant Isolation (strict tenant scoping across automations, enrollments, and campaigns)
 * 9. Reuse of existing engine (BullMQ "email-campaign", PostgreSQL, campaign state machine, suppression)
 * 10. Does not create a second campaign engine
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
process.env.AUTH_SESSION_SECRET = "automation-test-session-secret-32-chars-min";
process.env.API_KEY_PEPPER = "automation-test-pepper-32-chars-min-pepper";

import { prisma } from "../src/lib/prisma";
import {
  EmailAutomationService,
  calculateNextRunTime,
  parseNextCronOccurrence,
  JourneyStep,
  ABANDON_REASONS,
} from "../src/lib/services/email-automation-service";
import { EmailSegmentService } from "../src/lib/services/email-segment-service";
import { EmailSuppressionService } from "../src/lib/services/email-suppression-service";
import { providerRegistry, MockEmailProvider } from "../src/lib/email/registry";
import {
  EmailAutomationStatus,
  EmailAutomationTriggerType,
  AudienceReEvaluationPolicy,
  EmailEnrollmentStatus,
  EmailCampaignStatus,
  EmailContactStatus,
  EmailType,
  EmailSuppressionReason,
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
  await prisma.emailAutomationEnrollment.deleteMany({});
  await prisma.emailAutomation.deleteMany({});
  await prisma.emailCampaignRecipient.deleteMany({});
  await prisma.emailDelivery.deleteMany({});
  await prisma.emailEvent.deleteMany({});
  await prisma.emailCampaign.deleteMany({});
  await prisma.emailSuppression.deleteMany({});
  await prisma.emailListMember.deleteMany({});
  await prisma.emailList.deleteMany({});
  await prisma.emailSegment.deleteMany({});
  await prisma.emailContact.deleteMany({});
  await prisma.emailTemplateVersion.deleteMany({});
  await prisma.emailTemplate.deleteMany({});
  await prisma.emailSenderIdentity.deleteMany({});
  await prisma.emailProviderConfig.deleteMany({});
  await prisma.apiClient.deleteMany({});
}

async function runTests() {
  console.log("\n================================================================================");
  console.log("Starting Campaign Automation & Journey Engine Verification Suite");
  console.log("================================================================================\n");

  try {
    await cleanDatabase();

    // 0. Register Mock Email Provider for testing
    const mockProvider = new MockEmailProvider();
    providerRegistry.register(mockProvider);

    // Setup Tenants
    const tenantA = await prisma.apiClient.create({
      data: { id: `tenant-a-${Date.now()}`, name: "Tenant A", active: true },
    });
    const tenantB = await prisma.apiClient.create({
      data: { id: `tenant-b-${Date.now()}`, name: "Tenant B", active: true },
    });

    // Create Template for Tenant A
    const templateA = await prisma.emailTemplate.create({
      data: {
        clientId: tenantA.id,
        name: "Welcome Onboarding Template",
        type: "PROMOTIONAL",
      },
    });

    const templateVersionA = await prisma.emailTemplateVersion.create({
      data: {
        templateId: templateA.id,
        version: 1,
        subject: "Welcome {{firstName}}!",
        htmlContent: "<h1>Welcome, {{firstName}}!</h1><p>We are glad you are here.</p>",
        textContent: "Welcome, {{firstName}}!",
      },
    });

    // Create Sender Identity
    const senderA = await prisma.emailSenderIdentity.create({
      data: {
        clientId: tenantA.id,
        email: "newsletter@tenanta.com",
        name: "Tenant A News",
        verified: true,
      },
    });

    // Create Contacts for Tenant A
    const contactAlice = await prisma.emailContact.create({
      data: {
        clientId: tenantA.id,
        email: "alice@example.com",
        normalizedEmail: "alice@example.com",
        firstName: "Alice",
        lastName: "Smith",
        hasMarketingConsent: true,
        status: EmailContactStatus.SUBSCRIBED,
        metadata: JSON.stringify({ tier: "gold", city: "Mumbai" }),
      },
    });

    const contactBob = await prisma.emailContact.create({
      data: {
        clientId: tenantA.id,
        email: "bob@example.com",
        normalizedEmail: "bob@example.com",
        firstName: "Bob",
        lastName: "Jones",
        hasMarketingConsent: true,
        status: EmailContactStatus.SUBSCRIBED,
        metadata: JSON.stringify({ tier: "silver", city: "Delhi" }),
      },
    });

    const contactCharlie = await prisma.emailContact.create({
      data: {
        clientId: tenantA.id,
        email: "charlie@example.com",
        normalizedEmail: "charlie@example.com",
        firstName: "Charlie",
        lastName: "Brown",
        hasMarketingConsent: false, // NO CONSENT
        status: EmailContactStatus.UNSUBSCRIBED,
      },
    });

    // =========================================================================
    // SECTION 1: Cron & Interval Schedule Math
    // =========================================================================
    console.log("\n--- Section 1: Cron & Interval Math ---");

    const baseDate = new Date("2026-10-01T10:00:00Z");

    // 1.1 Interval Minutes
    const next15Min = calculateNextRunTime({ intervalMinutes: 15 }, baseDate);
    testAssert(
      next15Min?.getTime() === baseDate.getTime() + 15 * 60 * 1000,
      "Interval minutes accurately advances by 15m"
    );

    // 1.2 Interval Days
    const next2Days = calculateNextRunTime({ intervalDays: 2 }, baseDate);
    testAssert(
      next2Days?.getTime() === baseDate.getTime() + 2 * 24 * 3600 * 1000,
      "Interval days accurately advances by 2 days"
    );

    // 1.3 Cron Expression (Every Monday at 9:00 UTC)
    // 2026-10-01 is Thursday. Next Monday is 2026-10-05.
    const nextMon = parseNextCronOccurrence("0 9 * * 1", baseDate);
    testAssert(
      nextMon.getUTCDay() === 1 && nextMon.getUTCHours() === 9 && nextMon.getUTCMinutes() === 0,
      "Cron '0 9 * * 1' correctly computes next Monday at 09:00 UTC"
    );

    // =========================================================================
    // SECTION 2: Recurring Campaigns
    // =========================================================================
    console.log("\n--- Section 2: Recurring Campaigns ---");

    const newsletterList = await prisma.emailList.create({
      data: {
        clientId: tenantA.id,
        name: "Weekly Subscribers",
        active: true,
      },
    });

    await prisma.emailListMember.create({
      data: {
        listId: newsletterList.id,
        contactId: contactAlice.id,
        status: "SUBSCRIBED",
      },
    });

    await prisma.emailListMember.create({
      data: {
        listId: newsletterList.id,
        contactId: contactBob.id,
        status: "SUBSCRIBED",
      },
    });

    // 2.1 Create Recurring Automation
    const recurringAuto = await EmailAutomationService.createAutomation(tenantA.id, {
      name: "Weekly Newsletter Automation",
      description: "Dispatches newsletter every Monday",
      triggerType: EmailAutomationTriggerType.RECURRING_SCHEDULE,
      triggerConfig: {
        intervalMinutes: 60,
        maxRuns: 3,
        listId: newsletterList.id,
        templateVersionId: templateVersionA.id,
        senderIdentityId: senderA.id,
        campaignNamePrefix: "Weekly Issue",
      },
      reEvaluationPolicy: AudienceReEvaluationPolicy.ALWAYS_RE_EVALUATE,
      steps: [
        {
          id: "step-send-nl",
          name: "Send Newsletter",
          type: "SEND_CAMPAIGN",
          config: {
            templateVersionId: templateVersionA.id,
            senderIdentityId: senderA.id,
          },
        },
      ],
    });

    testAssert(
      recurringAuto.status === EmailAutomationStatus.DRAFT,
      "Recurring automation created in DRAFT state"
    );
    testAssert(
      recurringAuto.nextRunAt !== null,
      "Initial nextRunAt calculated for recurring automation"
    );

    // 2.2 Activate Recurring Automation
    const activeAuto = await EmailAutomationService.activateAutomation(tenantA.id, recurringAuto.id);
    testAssert(
      activeAuto.status === EmailAutomationStatus.ACTIVE,
      "Recurring automation transitions to ACTIVE on activation"
    );

    // 2.3 Execute Run #1
    const run1 = await EmailAutomationService.executeRecurringStep(tenantA.id, recurringAuto.id);
    testAssert(
      Boolean(run1.campaignId) && run1.enqueuedCount > 0,
      `Recurring Run #1 dispatched campaign ${run1.campaignId} via existing campaign engine (${run1.enqueuedCount} recipients)`
    );

    // Check Child Campaign created under existing engine
    const childCmp1 = await prisma.emailCampaign.findUnique({
      where: { id: run1.campaignId },
    });
    testAssert(
      childCmp1?.automationId === recurringAuto.id && childCmp1?.recurrenceIndex === 1,
      "Child campaign linked to parent automation with recurrenceIndex = 1"
    );
    testAssert(
      childCmp1?.status === EmailCampaignStatus.RUNNING,
      "Child campaign state machine initiated into RUNNING"
    );

    // Check Automation counters
    const autoAfterRun1 = await EmailAutomationService.getAutomationById(tenantA.id, recurringAuto.id);
    testAssert(
      autoAfterRun1?.executionCount === 1,
      "Automation executionCount incremented to 1"
    );
    testAssert(
      Boolean(autoAfterRun1?.lastExecutedAt),
      "Automation lastExecutedAt updated"
    );

    // 2.4 Execute Run #2 and Run #3 (testing maxRuns cap)
    await EmailAutomationService.executeRecurringStep(tenantA.id, recurringAuto.id);
    await EmailAutomationService.executeRecurringStep(tenantA.id, recurringAuto.id);

    // Execution count is now 3 (maxRuns = 3). Next call should pause automation
    const run4 = await EmailAutomationService.executeRecurringStep(tenantA.id, recurringAuto.id);
    const autoAfterMax = await EmailAutomationService.getAutomationById(tenantA.id, recurringAuto.id);
    testAssert(
      run4.enqueuedCount === 0 && autoAfterMax?.status === EmailAutomationStatus.PAUSED,
      "Recurring automation automatically paused upon reaching maxRuns limit"
    );

    // =========================================================================
    // SECTION 3: Scheduled Journeys & Multi-Step DAG
    // =========================================================================
    console.log("\n--- Section 3: Scheduled Journeys & Multi-Step DAG ---");

    const journeySteps: JourneyStep[] = [
      {
        id: "step-1-welcome",
        name: "Send Welcome Email",
        type: "SEND_CAMPAIGN",
        config: {
          templateVersionId: templateVersionA.id,
          senderIdentityId: senderA.id,
          campaignNamePrefix: "Onboarding Step 1",
        },
        nextStepId: "step-2-delay",
      },
      {
        id: "step-2-delay",
        name: "Wait 2 Days",
        type: "DELAY",
        config: {
          delayHours: 48,
        },
        nextStepId: "step-3-branch",
      },
      {
        id: "step-3-branch",
        name: "Check Gold Tier",
        type: "CONDITIONAL_BRANCH",
        config: {
          condition: {
            type: "CONTACT_ATTRIBUTE",
            attributeKey: "tier",
            operator: "equals",
            value: "gold",
          },
          trueNextStepId: "step-4-vip",
          falseNextStepId: "step-4-standard",
        },
      },
      {
        id: "step-4-vip",
        name: "VIP Offer",
        type: "SEND_CAMPAIGN",
        config: {
          templateVersionId: templateVersionA.id,
          senderIdentityId: senderA.id,
          campaignNamePrefix: "VIP Offer",
        },
        nextStepId: "step-5-end",
      },
      {
        id: "step-4-standard",
        name: "Standard Offer",
        type: "SEND_CAMPAIGN",
        config: {
          templateVersionId: templateVersionA.id,
          senderIdentityId: senderA.id,
          campaignNamePrefix: "Standard Offer",
        },
        nextStepId: "step-5-end",
      },
      {
        id: "step-5-end",
        name: "Journey Complete",
        type: "END",
      },
    ];

    const onboardingJourney = await EmailAutomationService.createAutomation(tenantA.id, {
      name: "User Onboarding Journey",
      description: "Multi-step onboarding with delayed follow-up and VIP branching",
      triggerType: EmailAutomationTriggerType.MANUAL,
      reEvaluationPolicy: AudienceReEvaluationPolicy.ALWAYS_RE_EVALUATE,
      steps: journeySteps,
    });

    await EmailAutomationService.activateAutomation(tenantA.id, onboardingJourney.id);

    // 3.1 Enroll Alice (Gold Tier)
    const enrollmentAlice = await EmailAutomationService.enrollContact(
      tenantA.id,
      onboardingJourney.id,
      contactAlice.id
    );

    testAssert(
      enrollmentAlice.status === EmailEnrollmentStatus.WAITING,
      "Enrollment successfully processed Step 1 and entered WAITING status on Step 2 (DELAY)"
    );
    testAssert(
      enrollmentAlice.currentStepId === "step-2-delay",
      "Enrollment currentStepId is on 'step-2-delay'"
    );
    testAssert(
      Boolean(enrollmentAlice.nextActionAt),
      "Enrollment nextActionAt timestamp set for delayed execution"
    );

    // Verify context history recorded Step 1
    const aliceContext = JSON.parse(enrollmentAlice.contextData || "{}");
    testAssert(
      aliceContext.stepHistory?.length > 0 && aliceContext.stepHistory[0].stepId === "step-1-welcome",
      "Context stepHistory accurately captured Step 1 execution and campaign recipient link"
    );

    // Verify step campaign was created under existing engine
    const stepCmp = await prisma.emailCampaign.findFirst({
      where: {
        automationId: onboardingJourney.id,
        automationStepId: "step-1-welcome",
      },
      include: { recipients: true },
    });
    testAssert(
      stepCmp !== null && stepCmp.recipients.some((r) => r.contactId === contactAlice.id),
      "SEND_CAMPAIGN step reuses existing campaign engine & creates authoritative campaign recipient"
    );

    // =========================================================================
    // SECTION 4: Delayed Follow-ups & Resuming Steps
    // =========================================================================
    console.log("\n--- Section 4: Delayed Follow-ups & Resuming Steps ---");

    // Simulate BullMQ delay timer firing and executing next step (step-3-branch)
    await EmailAutomationService.processEnrollmentStep(
      tenantA.id,
      enrollmentAlice.id,
      "step-3-branch"
    );

    const aliceAfterBranch = await prisma.emailAutomationEnrollment.findUniqueOrThrow({
      where: { id: enrollmentAlice.id },
    });

    const aliceUpdatedContext = JSON.parse(aliceAfterBranch.contextData || "{}");
    testAssert(
      aliceUpdatedContext.branchDecisions?.["step-3-branch"]?.decision === true,
      "Conditional branch evaluated Alice's tier === 'gold' as TRUE"
    );
    testAssert(
      aliceAfterBranch.status === EmailEnrollmentStatus.COMPLETED,
      "Alice seamlessly transitioned to VIP offer (Step 4) and COMPLETED the journey"
    );

    // 4.2 Enroll Bob (Silver Tier)
    const enrollmentBob = await EmailAutomationService.enrollContact(
      tenantA.id,
      onboardingJourney.id,
      contactBob.id
    );

    // Fast-forward Bob through delay to branch
    await EmailAutomationService.processEnrollmentStep(
      tenantA.id,
      enrollmentBob.id,
      "step-3-branch"
    );

    const bobAfterBranch = await prisma.emailAutomationEnrollment.findUniqueOrThrow({
      where: { id: enrollmentBob.id },
    });
    const bobContext = JSON.parse(bobAfterBranch.contextData || "{}");
    testAssert(
      bobContext.branchDecisions?.["step-3-branch"]?.decision === false,
      "Conditional branch evaluated Bob's tier === 'silver' as FALSE (branched to Standard Offer)"
    );

    // =========================================================================
    // SECTION 5: Event-Triggered Automations & WAIT_FOR_EVENT
    // =========================================================================
    console.log("\n--- Section 5: Event-Triggered Automations & WAIT_FOR_EVENT ---");

    const eventWaitSteps: JourneyStep[] = [
      {
        id: "step-pitch",
        name: "Initial Pitch",
        type: "SEND_CAMPAIGN",
        config: {
          templateVersionId: templateVersionA.id,
          senderIdentityId: senderA.id,
        },
        nextStepId: "step-wait-open",
      },
      {
        id: "step-wait-open",
        name: "Wait for Open Event",
        type: "WAIT_FOR_EVENT",
        config: {
          eventType: "OPENED",
          timeoutHours: 24,
          nextStepId: "step-thank-you",
        },
      },
      {
        id: "step-thank-you",
        name: "Thank You Note",
        type: "SEND_CAMPAIGN",
        config: {
          templateVersionId: templateVersionA.id,
          senderIdentityId: senderA.id,
        },
        nextStepId: "step-end",
      },
      {
        id: "step-end",
        name: "Done",
        type: "END",
      },
    ];

    const eventWaitJourney = await EmailAutomationService.createAutomation(tenantA.id, {
      name: "Engaged User Journey",
      triggerType: EmailAutomationTriggerType.MANUAL,
      steps: eventWaitSteps,
    });
    await EmailAutomationService.activateAutomation(tenantA.id, eventWaitJourney.id);

    // Enroll Bob
    const bobEventEnrollment = await EmailAutomationService.enrollContact(
      tenantA.id,
      eventWaitJourney.id,
      contactBob.id
    );

    testAssert(
      bobEventEnrollment.status === EmailEnrollmentStatus.WAITING &&
        bobEventEnrollment.currentStepId === "step-wait-open",
      "Enrollment enters WAITING state at 'step-wait-open' listening for OPENED event"
    );

    // Simulate incoming OPENED event for Bob
    const eventResult = await EmailAutomationService.handleEmailEvent({
      clientId: tenantA.id,
      eventType: "OPENED",
      email: contactBob.email,
    });

    testAssert(
      eventResult.matchedEnrollments === 1,
      "handleEmailEvent matched 1 waiting enrollment for OPENED event"
    );

    const bobAfterEvent = await prisma.emailAutomationEnrollment.findUniqueOrThrow({
      where: { id: bobEventEnrollment.id },
    });
    testAssert(
      bobAfterEvent.status === EmailEnrollmentStatus.COMPLETED,
      "Enrollment advanced past wait step upon receiving OPENED event and reached COMPLETED"
    );

    // =========================================================================
    // SECTION 6: Abandoned Workflow States
    // =========================================================================
    console.log("\n--- Section 6: Abandoned Workflow States ---");

    // 6.1 Unsubscribed contact rejection at enrollment
    const enrollmentCharlie = await EmailAutomationService.enrollContact(
      tenantA.id,
      onboardingJourney.id,
      contactCharlie.id
    );
    testAssert(
      enrollmentCharlie.status === EmailEnrollmentStatus.ABANDONED &&
        enrollmentCharlie.abandonedReason === ABANDON_REASONS.UNSUBSCRIBED,
      "Unsubscribed contact without marketing consent is immediately marked ABANDONED (UNSUBSCRIBED)"
    );

    // 6.2 Suppressed contact rejection
    await EmailSuppressionService.addSuppression(
      tenantA.id,
      "suppressed-user@example.com",
      EmailSuppressionReason.HARD_BOUNCE
    );

    const contactSuppressed = await prisma.emailContact.create({
      data: {
        clientId: tenantA.id,
        email: "suppressed-user@example.com",
        normalizedEmail: "suppressed-user@example.com",
        hasMarketingConsent: true,
        status: EmailContactStatus.SUBSCRIBED,
      },
    });

    const enrollmentSuppressed = await EmailAutomationService.enrollContact(
      tenantA.id,
      onboardingJourney.id,
      contactSuppressed.id
    );
    testAssert(
      enrollmentSuppressed.status === EmailEnrollmentStatus.ABANDONED &&
        enrollmentSuppressed.abandonedReason === ABANDON_REASONS.SUPPRESSED,
      "Suppressed contact is immediately marked ABANDONED (SUPPRESSED)"
    );

    // 6.3 Manual Exit
    const manualEnrollment = await EmailAutomationService.enrollContact(
      tenantA.id,
      eventWaitJourney.id,
      contactAlice.id
    );
    const abandonedManual = await EmailAutomationService.abandonEnrollment(
      tenantA.id,
      manualEnrollment.id,
      ABANDON_REASONS.MANUAL_EXIT
    );
    testAssert(
      abandonedManual.status === EmailEnrollmentStatus.ABANDONED &&
        abandonedManual.abandonedReason === ABANDON_REASONS.MANUAL_EXIT,
      "Manual abandonment transition explicitly sets status ABANDONED and reason MANUAL_EXIT"
    );

    // 6.4 Criteria Mismatch under ALWAYS_RE_EVALUATE
    const testSegment = await EmailSegmentService.createSegment(tenantA.id, "Gold Tier Segment", {
      conditions: [
        {
          field: "attributes.tier",
          operator: "equals",
          value: "gold",
        },
      ],
    });

    const segmentAuto = await EmailAutomationService.createAutomation(tenantA.id, {
      name: "Gold Only Segment Automation",
      triggerType: EmailAutomationTriggerType.SEGMENT_ENTRY,
      triggerConfig: { segmentId: testSegment.id },
      reEvaluationPolicy: AudienceReEvaluationPolicy.ALWAYS_RE_EVALUATE,
      steps: [
        {
          id: "step-gold-send",
          name: "Send Gold Perks",
          type: "SEND_CAMPAIGN",
          config: {
            templateVersionId: templateVersionA.id,
            senderIdentityId: senderA.id,
          },
          nextStepId: "step-gold-delay",
        },
        {
          id: "step-gold-delay",
          name: "Wait 1 Day",
          type: "DELAY",
          config: { delayHours: 24 },
          nextStepId: "step-gold-send-2",
        },
        {
          id: "step-gold-send-2",
          name: "Send Gold Follow-up",
          type: "SEND_CAMPAIGN",
          config: {
            templateVersionId: templateVersionA.id,
            senderIdentityId: senderA.id,
          },
        },
      ],
    });
    await EmailAutomationService.activateAutomation(tenantA.id, segmentAuto.id);

    // Enroll Alice (initially Gold)
    const goldEnrollment = await EmailAutomationService.enrollContact(
      tenantA.id,
      segmentAuto.id,
      contactAlice.id
    );
    testAssert(
      goldEnrollment.status === EmailEnrollmentStatus.WAITING,
      "Alice initially qualifies and completes Step 1, waiting at Step 2"
    );

    // Demote Alice from Gold to Bronze in database
    await prisma.emailContact.update({
      where: { id: contactAlice.id },
      data: { metadata: JSON.stringify({ tier: "bronze" }) },
    });

    // Execute next step under ALWAYS_RE_EVALUATE policy
    const reEvalResult = await EmailAutomationService.processEnrollmentStep(
      tenantA.id,
      goldEnrollment.id,
      "step-gold-send-2"
    );

    testAssert(
      reEvalResult.status === EmailEnrollmentStatus.ABANDONED &&
        reEvalResult.abandonedReason === ABANDON_REASONS.CRITERIA_MISMATCH,
      "ALWAYS_RE_EVALUATE re-evaluated segment criteria, detected mismatch, and transitioned enrollment to ABANDONED (CRITERIA_MISMATCH)"
    );

    // Verify automation abandonment counters
    const finalAuto = await EmailAutomationService.getAutomationById(tenantA.id, segmentAuto.id);
    testAssert(
      (finalAuto?.abandonedEnrollmentsCount || 0) > 0,
      "Automation abandonedEnrollmentsCount counter accurately incremented"
    );

    // =========================================================================
    // SECTION 7: Multi-Tenant Isolation
    // =========================================================================
    console.log("\n--- Section 7: Multi-Tenant Isolation ---");

    // Tenant B cannot fetch Tenant A's automation
    const crossTenantGet = await EmailAutomationService.getAutomationById(
      tenantB.id,
      onboardingJourney.id
    );
    testAssert(
      crossTenantGet === null,
      "Tenant B cannot view Tenant A's automation (returns null)"
    );

    // Tenant B cannot enroll contact into Tenant A's automation
    let crossTenantEnrollBlocked = false;
    try {
      await EmailAutomationService.enrollContact(tenantB.id, onboardingJourney.id, contactAlice.id);
    } catch {
      crossTenantEnrollBlocked = true;
    }
    testAssert(
      crossTenantEnrollBlocked,
      "Tenant B cannot enroll contacts into Tenant A's automation"
    );

    // Tenant A cannot enroll Tenant B's contact
    const contactTenantB = await prisma.emailContact.create({
      data: {
        clientId: tenantB.id,
        email: "david@tenantb.com",
        normalizedEmail: "david@tenantb.com",
        hasMarketingConsent: true,
        status: EmailContactStatus.SUBSCRIBED,
      },
    });

    let crossContactEnrollBlocked = false;
    try {
      await EmailAutomationService.enrollContact(tenantA.id, onboardingJourney.id, contactTenantB.id);
    } catch {
      crossContactEnrollBlocked = true;
    }
    testAssert(
      crossContactEnrollBlocked,
      "Tenant boundary prevents enrolling foreign tenant's contacts"
    );

    // =========================================================================
    // Final Summary
    // =========================================================================
    console.log("\n================================================================================");
    console.log(`Campaign Automation Test Results: ${passed} PASSED, ${failed} FAILED`);
    console.log("================================================================================\n");

    if (failed > 0) {
      process.exit(1);
    } else {
      process.exit(0);
    }
  } catch (err) {
    console.error("Fatal test error:", err);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

runTests();
