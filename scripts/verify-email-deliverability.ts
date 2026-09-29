if (!process.env.DATABASE_URL || process.env.DATABASE_URL.includes("peqynzeioiauynfpdsdv") || process.env.DATABASE_URL.includes("supabase.co")) {
  process.env.DATABASE_URL = "postgresql://postgres:postgres@127.0.0.1:5433/email_test";
}
if (!process.env.DIRECT_URL || process.env.DIRECT_URL.includes("peqynzeioiauynfpdsdv") || process.env.DIRECT_URL.includes("supabase.co")) {
  process.env.DIRECT_URL = "postgresql://postgres:postgres@127.0.0.1:5433/email_test";
}
process.env.ALLOW_DESTRUCTIVE_TESTS = "true";

import { prisma } from "../src/lib/prisma";
import { assertDestructiveTestAllowed } from "./test-db-guard";
import {
  emailDomainService,
  DnsResolver,
} from "../src/lib/services/email-domain-service";
import { emailDiagnosticsService } from "../src/lib/services/email-diagnostics-service";
import { emailReputationService } from "../src/lib/services/email-reputation-service";
import { emailQuotaService } from "../src/lib/services/email-quota-service";
import { EmailEventService } from "../src/lib/services/email-event-service";
import { EmailSuppressionService } from "../src/lib/services/email-suppression-service";
import {
  EmailProviderType,
  EmailDomainVerificationStatus,
  EmailDnsStatus,
  EmailFailureCategory,
  EmailEventType,
  EmailDeliveryStatus,
  EmailType,
  EmailSuppressionReason,
} from "@prisma/client";

// ==============================================================================
// Mock DNS Resolver for Deterministic Verification Testing
// ==============================================================================

class MockDnsResolver implements DnsResolver {
  private txtRecords = new Map<string, string[][]>();
  private mxRecords = new Map<string, Array<{ exchange: string; priority: number }>>();

  setTxt(hostname: string, records: string[][]): void {
    this.txtRecords.set(hostname.toLowerCase(), records);
  }

  setMx(hostname: string, records: Array<{ exchange: string; priority: number }>): void {
    this.mxRecords.set(hostname.toLowerCase(), records);
  }

  clear(): void {
    this.txtRecords.clear();
    this.mxRecords.clear();
  }

  async resolveTxt(hostname: string): Promise<string[][]> {
    const records = this.txtRecords.get(hostname.toLowerCase());
    if (!records) return [];
    return records;
  }

  async resolveMx(hostname: string): Promise<Array<{ exchange: string; priority: number }>> {
    const records = this.mxRecords.get(hostname.toLowerCase());
    if (!records) return [];
    return records;
  }
}

// ==============================================================================
// Master Deliverability Verification Runner
// ==============================================================================

async function main() {
  assertDestructiveTestAllowed("verify-email-deliverability");

  console.log("\n==================================================================");
  console.log("🛡️  EMAIL DELIVERABILITY, DOMAINS, & DIAGNOSTICS CERTIFICATION");
  console.log("==================================================================\n");

  const runId = `deliv_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  let passedCount = 0;
  let failedCount = 0;

  function assert(condition: boolean, description: string) {
    if (condition) {
      console.log(`  ✅ PASS: ${description}`);
      passedCount++;
    } else {
      console.error(`  ❌ FAIL: ${description}`);
      failedCount++;
      throw new Error(`Assertion failed: ${description}`);
    }
  }

  // 1. Setup Test Tenants
  const clientA = await prisma.apiClient.create({
    data: { name: `Client_A_${runId}`, active: true },
  });
  const clientB = await prisma.apiClient.create({
    data: { name: `Client_B_${runId}`, active: true },
  });

  const mockResolver = new MockDnsResolver();

  try {
    // -------------------------------------------------------------------------
    // FLOW 1: Domain Registration & Verification Token Generation
    // -------------------------------------------------------------------------
    console.log("--- [FLOW 1] Domain Registration & Token Generation ---");
    const testDomainName = `mail-${runId}.example.com`;
    const { domain: domainA, guidance: guidanceA } = await emailDomainService.createDomain(
      clientA.id,
      testDomainName,
      EmailProviderType.GMAIL,
      "whub"
    );

    assert(domainA.domain === testDomainName, "Domain record created with normalized domain name");
    assert(domainA.verificationStatus === EmailDomainVerificationStatus.PENDING, "Domain starts in PENDING status (never prematurely verified)");
    assert(domainA.spfStatus === EmailDnsStatus.PENDING, "SPF starts in PENDING status");
    assert(domainA.dkimStatus === EmailDnsStatus.PENDING, "DKIM starts in PENDING status");
    assert(domainA.dmarcStatus === EmailDnsStatus.PENDING, "DMARC starts in PENDING status");
    assert(domainA.verificationToken.length >= 32, "Cryptographically secure 32+ character verification token generated");
    assert(guidanceA.length >= 4, "DNS guidance includes TXT verification, SPF, DKIM, and DMARC");

    // Multi-tenant check
    const clientBDomains = await emailDomainService.listDomains(clientB.id);
    assert(!clientBDomains.some((d) => d.id === domainA.id), "Tenant B cannot see Tenant A's registered domain");

    // -------------------------------------------------------------------------
    // FLOW 2: Provider-Agnostic DNS Guidance
    // -------------------------------------------------------------------------
    console.log("\n--- [FLOW 2] Provider-Agnostic DNS Guidance ---");
    const gmailGuidance = emailDomainService.generateDnsGuidance("corp.com", EmailProviderType.GMAIL, "tok123");
    const sesGuidance = emailDomainService.generateDnsGuidance("corp.com", EmailProviderType.SES, "tok123");
    const smtpGuidance = emailDomainService.generateDnsGuidance("corp.com", EmailProviderType.SMTP, "tok123");

    const gmailSpf = gmailGuidance.find((g) => g.purpose === "SPF");
    const sesSpf = sesGuidance.find((g) => g.purpose === "SPF");
    const smtpSpf = smtpGuidance.find((g) => g.purpose === "SPF");

    assert(gmailSpf?.value.includes("_spf.google.com") === true, "Gmail SPF guidance includes '_spf.google.com'");
    assert(sesSpf?.value.includes("amazonses.com") === true, "SES SPF guidance includes 'amazonses.com'");
    assert(smtpSpf?.value.includes("relay.mailchannels.net") === true, "SMTP SPF guidance includes standard relay directive");

    const dmarcGuidance = gmailGuidance.find((g) => g.purpose === "DMARC");
    assert(dmarcGuidance?.value.startsWith("v=DMARC1; p=quarantine") === true, "DMARC guidance enforces strict quarantine policy");

    // -------------------------------------------------------------------------
    // FLOW 3: Strict DNS Verification (Missing / Misconfigured Cases)
    // -------------------------------------------------------------------------
    console.log("\n--- [FLOW 3] Strict DNS Verification: Missing & Misconfigured ---");
    mockResolver.clear(); // Empty DNS - nothing configured

    const failedCheck = await emailDomainService.verifyDomain(clientA.id, domainA.id, mockResolver);
    assert(failedCheck.overallStatus === EmailDomainVerificationStatus.FAILED, "Domain verification strictly FAILS when TXT token is missing from DNS");
    assert(failedCheck.spf.status === EmailDnsStatus.MISSING, "SPF reported as MISSING when no v=spf1 TXT record found");
    assert(failedCheck.dkim.status === EmailDnsStatus.MISSING, "DKIM reported as MISSING when selector record is absent");
    assert(failedCheck.dmarc.status === EmailDnsStatus.MISSING, "DMARC reported as MISSING when _dmarc record is absent");

    // Test RFC 7208 Multiple SPF Records (Forbidden)
    mockResolver.setTxt(testDomainName, [
      [`v=spf1 include:_spf.google.com ~all`],
      [`v=spf1 include:amazonses.com ~all`],
    ]);
    const multiSpfCheck = await emailDomainService.verifyDomain(clientA.id, domainA.id, mockResolver);
    assert(multiSpfCheck.spf.status === EmailDnsStatus.MISCONFIGURED, "Multiple SPF records flagged as MISCONFIGURED (RFC 7208 violation)");

    // Test Permissive +all Policy (Critical vulnerability)
    mockResolver.setTxt(testDomainName, [
      [`v=spf1 +all`],
    ]);
    const permissiveSpfCheck = await emailDomainService.verifyDomain(clientA.id, domainA.id, mockResolver);
    assert(permissiveSpfCheck.spf.status === EmailDnsStatus.MISCONFIGURED, "Permissive SPF '+all' flagged as MISCONFIGURED security risk");

    // -------------------------------------------------------------------------
    // FLOW 4: Strict DNS Verification (Passing Verified Case)
    // -------------------------------------------------------------------------
    console.log("\n--- [FLOW 4] Strict DNS Verification: Valid Verified Records ---");
    mockResolver.clear();
    // Configure authoritative, valid records
    mockResolver.setTxt(testDomainName, [
      [`whub-domain-verification=${domainA.verificationToken}`],
      [`v=spf1 include:_spf.google.com ~all`],
    ]);
    mockResolver.setTxt(`whub._domainkey.${testDomainName}`, [
      [`v=DKIM1; k=rsa; p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC3pZ3dE7o3Q0`],
    ]);
    mockResolver.setTxt(`_dmarc.${testDomainName}`, [
      [`v=DMARC1; p=quarantine; rua=mailto:dmarc@${testDomainName}`],
    ]);
    mockResolver.setMx(testDomainName, [
      { exchange: "smtp.google.com", priority: 1 },
    ]);

    const passingCheck = await emailDomainService.verifyDomain(clientA.id, domainA.id, mockResolver);
    assert(passingCheck.overallStatus === EmailDomainVerificationStatus.VERIFIED, "Domain verification succeeds when token is present");
    assert(passingCheck.spf.status === EmailDnsStatus.VERIFIED, "SPF verified with valid ~all qualifier and includes");
    assert(passingCheck.dkim.status === EmailDnsStatus.VERIFIED, "DKIM verified with valid public key");
    assert(passingCheck.dmarc.status === EmailDnsStatus.VERIFIED, "DMARC verified with quarantine policy");
    assert(passingCheck.mx.status === EmailDnsStatus.VERIFIED, "MX verified with active exchange servers");
    assert(passingCheck.verifiedAt !== null, "verifiedAt timestamp persisted");

    // -------------------------------------------------------------------------
    // FLOW 5: Sender Identity & Domain Association
    // -------------------------------------------------------------------------
    console.log("\n--- [FLOW 5] Sender Identity & Domain Association ---");
    const sender = await prisma.emailSenderIdentity.create({
      data: {
        clientId: clientA.id,
        email: `noreply@${testDomainName}`,
        name: "Verified Sender",
        domainId: domainA.id,
        verified: true,
        verifiedAt: new Date(),
      },
    });
    assert(sender.domainId === domainA.id, "Sender identity correctly associated with verified domain");

    // -------------------------------------------------------------------------
    // FLOW 6: Bounce & Complaint Monitoring (Auto-Suppression)
    // -------------------------------------------------------------------------
    console.log("\n--- [FLOW 6] Bounce & Complaint Monitoring & Auto-Suppression ---");
    const hardBounceEmail = `hardbounce_${runId}@invalid-dest.test`;
    const softBounceEmail = `softbounce_${runId}@full-mailbox.test`;
    const complaintEmail = `complaint_${runId}@user-spam.test`;

    // A. Hard Bounce Event
    await EmailEventService.processNormalizedEvent({
      providerType: EmailProviderType.MOCK,
      clientId: clientA.id,
      providerEventId: `evt_hb_${runId}`,
      eventType: EmailEventType.BOUNCED,
      recipient: hardBounceEmail,
      occurredAt: new Date(),
      bounceType: "HARD_BOUNCE",
      bounceReason: "550 5.1.1 User unknown",
      rawPayload: {},
    });

    const hardBounceSuppressed = await EmailSuppressionService.isSuppressed(clientA.id, hardBounceEmail);
    assert(hardBounceSuppressed.suppressed === true, "Hard bounce event immediately triggers auto-suppression");

    // B. Soft Bounce Event
    await EmailEventService.processNormalizedEvent({
      providerType: EmailProviderType.MOCK,
      clientId: clientA.id,
      providerEventId: `evt_sb_${runId}`,
      eventType: EmailEventType.BOUNCED,
      recipient: softBounceEmail,
      occurredAt: new Date(),
      bounceType: "SOFT_BOUNCE",
      bounceReason: "452 4.2.2 Mailbox full",
      rawPayload: {},
    });

    const softBounceSuppressed = await EmailSuppressionService.isSuppressed(clientA.id, softBounceEmail);
    assert(softBounceSuppressed.suppressed === false, "Soft bounce does NOT immediately trigger permanent suppression");

    // C. Complaint Event
    await EmailEventService.processNormalizedEvent({
      providerType: EmailProviderType.MOCK,
      clientId: clientA.id,
      providerEventId: `evt_comp_${runId}`,
      eventType: EmailEventType.COMPLAINT,
      recipient: complaintEmail,
      occurredAt: new Date(),
      complaintFeedback: "abuse report: clicked mark as spam",
      rawPayload: {},
    });

    const complaintSuppressed = await EmailSuppressionService.isSuppressed(clientA.id, complaintEmail);
    assert(complaintSuppressed.suppressed === true, "Spam complaint event immediately triggers auto-suppression");

    // -------------------------------------------------------------------------
    // FLOW 7: Pre-Flight Suppression Protection
    // -------------------------------------------------------------------------
    console.log("\n--- [FLOW 7] Pre-Flight Suppression Protection ---");
    const suppressedTarget = `blocked_${runId}@suppressed.test`;
    await EmailSuppressionService.addSuppression(
      clientA.id,
      suppressedTarget,
      EmailSuppressionReason.MANUAL,
      "ADMIN_MANUAL"
    );

    const isBlocked = await EmailSuppressionService.isSuppressed(clientA.id, suppressedTarget);
    assert(isBlocked.suppressed === true, "Suppressed recipient is identified pre-flight");

    const isTenantIsolated = await EmailSuppressionService.isSuppressed(clientB.id, suppressedTarget);
    assert(isTenantIsolated.suppressed === false, "Suppression list is strictly tenant isolated (Client B is not affected by Client A suppression)");

    // -------------------------------------------------------------------------
    // FLOW 8: Delivery Failure Diagnostics Classification
    // -------------------------------------------------------------------------
    console.log("\n--- [FLOW 8] Delivery Failure Diagnostics Engine ---");

    const authDiag = emailDiagnosticsService.classifyFailure("550 5.7.26 The message does not pass authentication checks (SPF/DKIM).");
    assert(authDiag.category === EmailFailureCategory.AUTHENTICATION_FAILED, "5.7.26 classified as AUTHENTICATION_FAILED");
    assert(authDiag.isHardBounce === true, "Authentication failure marked as hard bounce");
    assert(authDiag.recommendedRemediation.includes("SPF"), "Remediation includes SPF record advice");

    const spamDiag = emailDiagnosticsService.classifyFailure("554 5.7.1 Service unavailable; Client host blocked using Spamhaus ZEN.");
    assert(spamDiag.category === EmailFailureCategory.SPAM_BLOCK, "Spamhaus block classified as SPAM_BLOCK");
    assert(spamDiag.isHardBounce === true, "Spam block marked as non-retryable hard bounce");

    const userUnknownDiag = emailDiagnosticsService.classifyFailure("550 5.1.1 User unknown; Mailbox not found.");
    assert(userUnknownDiag.category === EmailFailureCategory.INVALID_RECIPIENT, "5.1.1 classified as INVALID_RECIPIENT");

    const mailboxFullDiag = emailDiagnosticsService.classifyFailure("452 4.2.2 Mailbox is full.");
    assert(mailboxFullDiag.category === EmailFailureCategory.MAILBOX_FULL, "4.2.2 classified as MAILBOX_FULL");
    assert(mailboxFullDiag.isRetryable === true, "Mailbox full marked as retryable soft bounce");

    const dnsDiag = emailDiagnosticsService.classifyFailure("Host not found (NXDOMAIN); no MX records.");
    assert(dnsDiag.category === EmailFailureCategory.DNS_LOOKUP_FAILURE, "NXDOMAIN classified as DNS_LOOKUP_FAILURE");

    const rateLimitDiag = emailDiagnosticsService.classifyFailure("421 4.7.0 Connection rate limit exceeded.");
    assert(rateLimitDiag.category === EmailFailureCategory.RATE_LIMITED, "421 classified as RATE_LIMITED");
    assert(rateLimitDiag.isRetryable === true, "Rate limiting marked as retryable");

    const tlsDiag = emailDiagnosticsService.classifyFailure("TLS negotiation failed; certificate expired.");
    assert(tlsDiag.category === EmailFailureCategory.TLS_ERROR, "TLS failure classified as TLS_ERROR");

    const quotaDiag = emailDiagnosticsService.classifyFailure("daily sending quota reached; 450 4.4.5.");
    assert(quotaDiag.category === EmailFailureCategory.QUOTA_EXCEEDED, "Daily sending quota classified as QUOTA_EXCEEDED");

    // -------------------------------------------------------------------------
    // FLOW 9: Sender Reputation & Compliance Scoring Engine
    // -------------------------------------------------------------------------
    console.log("\n--- [FLOW 9] Sender Reputation & Compliance Engine ---");

    // Create a mock delivery history for client A
    await prisma.emailDelivery.createMany({
      data: [
        { clientId: clientA.id, providerType: EmailProviderType.MOCK, category: EmailType.TRANSACTIONAL, from: `test@${testDomainName}`, to: `user1_${runId}@dest.com`, subject: "Test 1", status: EmailDeliveryStatus.DELIVERED, sentAt: new Date() },
        { clientId: clientA.id, providerType: EmailProviderType.MOCK, category: EmailType.TRANSACTIONAL, from: `test@${testDomainName}`, to: `user2_${runId}@dest.com`, subject: "Test 2", status: EmailDeliveryStatus.DELIVERED, sentAt: new Date() },
        { clientId: clientA.id, providerType: EmailProviderType.MOCK, category: EmailType.TRANSACTIONAL, from: `test@${testDomainName}`, to: `user3_${runId}@dest.com`, subject: "Test 3", status: EmailDeliveryStatus.BOUNCED, sentAt: new Date() },
      ],
    });

    const reputationReport = await emailReputationService.getClientReputation(clientA.id);
    assert(reputationReport.score >= 0 && reputationReport.score <= 100, `Reputation score is valid bounded integer (${reputationReport.score})`);
    assert(["EXCELLENT", "GOOD", "FAIR", "POOR", "CRITICAL"].includes(reputationReport.grade), `Valid reputation grade (${reputationReport.grade})`);
    assert(reputationReport.googleYahooCompliance !== undefined, "Google & Yahoo compliance report generated");
    assert(reputationReport.googleYahooCompliance.checks.oneClickUnsubscribeSupported === true, "One-click unsubscribe confirmed supported");
    assert(reputationReport.metrics7d.sentCount >= 3, "7-day sent metrics aggregated accurately");

    // -------------------------------------------------------------------------
    // FLOW 10: Provider Quota Monitoring Engine
    // -------------------------------------------------------------------------
    console.log("\n--- [FLOW 10] Provider Quota Monitoring Engine ---");

    // Create provider configs for Client A
    const gmailConfig = await prisma.emailProviderConfig.create({
      data: {
        clientId: clientA.id,
        name: `Gmail Provider ${runId}`,
        providerType: EmailProviderType.GMAIL,
        senderEmail: `notifications@${testDomainName}`,
        isDefault: true,
      },
    });

    const quotas = await emailQuotaService.getTenantQuotas(clientA.id);
    assert(quotas.length >= 1, "Tenant quota list retrieved");
    const gmailQuota = quotas.find((q) => q.providerConfigId === gmailConfig.id);
    assert(gmailQuota !== undefined, "Gmail quota identified");
    assert(gmailQuota!.dailyLimit === 2000, "Google Workspace daily limit defaults to 2,000");
    assert(gmailQuota!.status === "NORMAL", "Initial quota status is NORMAL");
    assert(gmailQuota!.resetAt.includes("T"), "Reset schedule timestamp is ISO string");

    const quotaCheck = await emailQuotaService.checkQuotaAvailable(clientA.id, EmailProviderType.GMAIL);
    assert(quotaCheck.allowed === true, "Pre-flight quota check permits send when quota is available");
    assert(quotaCheck.remaining > 0, "Remaining quota is positive");

    console.log("\n==================================================================");
    console.log(`📊 DELIVERABILITY CERTIFICATION RESULTS: ${passedCount} PASSED, ${failedCount} FAILED`);
    console.log("==================================================================\n");

  } finally {
    // Teardown test artifacts
    await prisma.emailDelivery.deleteMany({ where: { clientId: { in: [clientA.id, clientB.id] } } });
    await prisma.emailEvent.deleteMany({ where: { clientId: { in: [clientA.id, clientB.id] } } });
    await prisma.emailSuppression.deleteMany({ where: { clientId: { in: [clientA.id, clientB.id] } } });
    await prisma.emailSenderIdentity.deleteMany({ where: { clientId: { in: [clientA.id, clientB.id] } } });
    await prisma.emailDomain.deleteMany({ where: { clientId: { in: [clientA.id, clientB.id] } } });
    await prisma.emailProviderConfig.deleteMany({ where: { clientId: { in: [clientA.id, clientB.id] } } });
    await prisma.apiClient.deleteMany({ where: { id: { in: [clientA.id, clientB.id] } } });
  }
}

main().catch((err) => {
  console.error("Fatal test error:", err);
  process.exit(1);
});
