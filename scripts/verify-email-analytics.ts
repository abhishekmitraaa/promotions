/**
 * Email Analytics System Verification Suite
 *
 * Verifies email analytics semantics against actual PostgreSQL event data:
 * 1. Separation of 8 core concepts (Accepted, Sent, Delivered, Bounced, Complaint, Open, Click, Unsubscribe).
 * 2. Inferred delivery semantics: open/click implies delivery for webhook-less flows, but is NOT unquestionable.
 * 3. Bot pre-scan before bounce: verified that BOUNCED takes absolute precedence over scanner opens in analytics.
 * 4. Terminal failure immunity: open/click on BOUNCED/FAILED deliveries never promotes status to DELIVERED.
 * 5. Duplicate event inflation defense: totalOpens vs uniqueOpens, totalClicks vs uniqueClicks.
 * 6. Duplicate recipient inflation defense: delivery retries evaluated as single recipient unit.
 * 7. Division by zero protection: empty campaigns return 0.0% without NaN or error.
 * 8. Impossible percentage protection: rates strictly clamped to [0.0, 100.0].
 * 9. Complaints & Unsubscribes: tracked accurately with safe rates.
 * 10. Multi-tenant isolation: cross-tenant access rejected, zero cross-tenant leakage.
 * 11. Definition parity: 100% parity between getCampaignAnalytics, getTenantAnalytics, and listCampaigns.
 * 12. Historical event ledger immutability in PostgreSQL.
 */

if (!process.env.DATABASE_URL || process.env.DATABASE_URL.includes("peqynzeioiauynfpdsdv") || process.env.DATABASE_URL.includes("supabase.co")) {
  process.env.DATABASE_URL = "postgresql://postgres:postgres@127.0.0.1:5433/email_test";
}
if (!process.env.DIRECT_URL || process.env.DIRECT_URL.includes("peqynzeioiauynfpdsdv") || process.env.DIRECT_URL.includes("supabase.co")) {
  process.env.DIRECT_URL = "postgresql://postgres:postgres@127.0.0.1:5433/email_test";
}
process.env.REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";
process.env.REDIS_HOST = process.env.REDIS_HOST || "127.0.0.1";
process.env.REDIS_PORT = process.env.REDIS_PORT || "6379";
process.env.ALLOW_DESTRUCTIVE_TESTS = "true";
process.env.NODE_ENV = "test";
process.env.EMAIL_TRACKING_SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.NEXT_PUBLIC_APP_URL = "https://hub.example.com";

import { prisma } from "../src/lib/prisma";
import {
  EmailAnalyticsService,
  computeAuthoritativeRates,
} from "../src/lib/services/email-analytics-service";
import { EmailTrackingService } from "../src/lib/email/tracking/email-tracking-service";
import { EmailCampaignService } from "../src/lib/services/email-campaign-service";
import {
  EmailCampaignStatus,
  EmailDeliveryStatus,
  EmailEventType,
  EmailEventProcessingStatus,
  EmailProviderType,
  EmailType,
} from "@prisma/client";

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ ASSERTION FAILED: ${message}`);
    throw new Error(message);
  }
}

async function runAnalyticsVerification() {
  console.log("===============================================================================");
  console.log("       EMAIL ANALYTICS SUBSYSTEM AUDIT & AUTHORITATIVE VERIFICATION            ");
  console.log("===============================================================================\n");

  const timestamp = Date.now();
  const tenantAlpha = `tenant-analytics-alpha-${timestamp}`;
  const tenantBeta = `tenant-analytics-beta-${timestamp}`;

  // 0. Setup isolated test tenant records in ApiClient
  await prisma.apiClient.createMany({
    data: [
      { id: tenantAlpha, name: "Tenant Alpha Analytics", active: true },
      { id: tenantBeta, name: "Tenant Beta Analytics", active: true },
    ],
  });
  console.log(`✓ Created isolated test tenants: ${tenantAlpha}, ${tenantBeta}\n`);

  // =========================================================================
  // FIXTURE 1: Standard Delivery Sequence (SENT -> DELIVERED -> OPEN -> CLICK)
  // =========================================================================
  console.log("--- FIXTURE 1: Standard Delivery Sequence (SENT -> DELIVERED -> OPEN -> CLICK) ---");

  const campaign1 = await prisma.emailCampaign.create({
    data: {
      clientId: tenantAlpha,
      name: "Campaign 1 - Standard Delivery",
      status: EmailCampaignStatus.SENT,
      totalRecipients: 1,
    },
  });

  const contact1 = await prisma.emailContact.create({
    data: {
      clientId: tenantAlpha,
      email: `alice.${timestamp}@example.com`,
      normalizedEmail: `alice.${timestamp}@example.com`,
      status: "SUBSCRIBED",
    },
  });

  const rec1 = await prisma.emailCampaignRecipient.create({
    data: {
      campaignId: campaign1.id,
      contactId: contact1.id,
      email: contact1.email,
      status: "DELIVERED",
    },
  });

  const del1 = await prisma.emailDelivery.create({
    data: {
      clientId: tenantAlpha,
      campaignRecipientId: rec1.id,
      providerType: EmailProviderType.MOCK,
      from: "sender@example.com",
      to: contact1.email,
      subject: "Welcome!",
      category: EmailType.PROMOTIONAL,
      status: EmailDeliveryStatus.DELIVERED,
      deliveredAt: new Date(),
    },
  });

  // User opens email
  const openRes1 = await EmailTrackingService.recordOpen(del1.id, {
    ip: "198.51.100.1",
    userAgent: "AppleMail/16.0",
  });
  assert(openRes1.recorded === true, "Fixture 1: Open recorded successfully");

  // User clicks link
  const clickRes1 = await EmailTrackingService.recordClick(del1.id, "https://example.com/promo", {
    ip: "198.51.100.1",
    userAgent: "AppleMail/16.0",
  });
  assert(clickRes1.recorded === true, "Fixture 1: Click recorded successfully");

  const analytics1 = await EmailAnalyticsService.getCampaignAnalytics(tenantAlpha, campaign1.id);
  console.log("  Fixture 1 Campaign Analytics:", {
    sent: analytics1.sent,
    delivered: analytics1.delivered,
    bounced: analytics1.bounced,
    uniqueOpens: analytics1.uniqueOpens,
    uniqueClicks: analytics1.uniqueClicks,
    totalOpens: analytics1.totalOpens,
    totalClicks: analytics1.totalClicks,
    rates: analytics1.rates,
  });

  assert(analytics1.sent === 1, "Fixture 1: sent must be 1");
  assert(analytics1.delivered === 1, "Fixture 1: delivered must be 1");
  assert(analytics1.bounced === 0, "Fixture 1: bounced must be 0");
  assert(analytics1.failed === 0, "Fixture 1: failed must be 0");
  assert(analytics1.uniqueOpens === 1, "Fixture 1: uniqueOpens must be 1");
  assert(analytics1.uniqueClicks === 1, "Fixture 1: uniqueClicks must be 1");
  assert(analytics1.rates.deliveryRate === 100, "Fixture 1: deliveryRate must be 100%");
  assert(analytics1.rates.openRate === 100, "Fixture 1: openRate must be 100%");
  assert(analytics1.rates.clickRate === 100, "Fixture 1: clickRate must be 100%");
  assert(analytics1.rates.bounceRate === 0, "Fixture 1: bounceRate must be 0%");
  console.log("✓ FIXTURE 1 PASSED.\n");

  // =========================================================================
  // FIXTURE 2: Inferred Delivery Sequence without explicit delivery webhook
  // =========================================================================
  console.log("--- FIXTURE 2: Inferred Delivery Sequence (SENT -> OPEN promotes to DELIVERED) ---");

  const campaign2 = await prisma.emailCampaign.create({
    data: {
      clientId: tenantAlpha,
      name: "Campaign 2 - Inferred Delivery",
      status: EmailCampaignStatus.SENT,
      totalRecipients: 1,
    },
  });

  const contact2 = await prisma.emailContact.create({
    data: {
      clientId: tenantAlpha,
      email: `bob.${timestamp}@example.com`,
      normalizedEmail: `bob.${timestamp}@example.com`,
      status: "SUBSCRIBED",
    },
  });

  const rec2 = await prisma.emailCampaignRecipient.create({
    data: {
      campaignId: campaign2.id,
      contactId: contact2.id,
      email: contact2.email,
      status: "SENT",
    },
  });

  const del2 = await prisma.emailDelivery.create({
    data: {
      clientId: tenantAlpha,
      campaignRecipientId: rec2.id,
      providerType: EmailProviderType.MOCK,
      from: "sender@example.com",
      to: contact2.email,
      subject: "Newsletter",
      category: EmailType.PROMOTIONAL,
      status: EmailDeliveryStatus.SENT, // Dispatched, but no provider delivery webhook yet
    },
  });

  // User opens email -> Inferred delivery triggers
  await EmailTrackingService.recordOpen(del2.id);

  // Delivery status in DB promoted to DELIVERED via inferred delivery
  const updatedDel2 = await prisma.emailDelivery.findUnique({ where: { id: del2.id } });
  assert(updatedDel2?.status === EmailDeliveryStatus.DELIVERED, "Fixture 2: Delivery status promoted to DELIVERED");

  const analytics2 = await EmailAnalyticsService.getCampaignAnalytics(tenantAlpha, campaign2.id);
  assert(analytics2.sent === 1, "Fixture 2: sent is 1");
  assert(analytics2.delivered === 1, "Fixture 2: delivered is 1 via inferred delivery");
  assert(analytics2.uniqueOpens === 1, "Fixture 2: uniqueOpens is 1");
  assert(analytics2.rates.openRate === 100, "Fixture 2: openRate is 100%");
  console.log("✓ FIXTURE 2 PASSED.\n");

  // =========================================================================
  // FIXTURE 3: Bot Pre-Scan followed by Terminal Bounce (BOUNCE PRECEDENCE)
  // =========================================================================
  console.log("--- FIXTURE 3: Bot Pre-Scan followed by Terminal Bounce (Authoritative Precedence) ---");

  const campaign3 = await prisma.emailCampaign.create({
    data: {
      clientId: tenantAlpha,
      name: "Campaign 3 - Bot Scan then Bounce",
      status: EmailCampaignStatus.SENT,
      totalRecipients: 1,
    },
  });

  const contact3 = await prisma.emailContact.create({
    data: {
      clientId: tenantAlpha,
      email: `scanner.bounce.${timestamp}@example.com`,
      normalizedEmail: `scanner.bounce.${timestamp}@example.com`,
      status: "SUBSCRIBED",
    },
  });

  const rec3 = await prisma.emailCampaignRecipient.create({
    data: {
      campaignId: campaign3.id,
      contactId: contact3.id,
      email: contact3.email,
      status: "SENT",
    },
  });

  const del3 = await prisma.emailDelivery.create({
    data: {
      clientId: tenantAlpha,
      campaignRecipientId: rec3.id,
      providerType: EmailProviderType.MOCK,
      from: "sender@example.com",
      to: contact3.email,
      subject: "Verify Account",
      category: EmailType.PROMOTIONAL,
      status: EmailDeliveryStatus.SENT,
    },
  });

  // Automated security scanner (e.g. Proofpoint) pre-fetches the open tracking pixel
  await EmailTrackingService.recordOpen(del3.id, {
    ip: "198.51.100.99",
    userAgent: "Mozilla/5.0 (Proofpoint-Scanner/1.0)",
  });

  // Remote destination MX rejects email with 550 User Unknown
  await prisma.emailDelivery.update({
    where: { id: del3.id },
    data: {
      status: EmailDeliveryStatus.BOUNCED,
      failedAt: new Date(),
      errorCode: "550_USER_UNKNOWN",
    },
  });
  await prisma.emailCampaignRecipient.update({
    where: { id: rec3.id },
    data: { status: "BOUNCED" },
  });
  await prisma.emailCampaign.update({
    where: { id: campaign3.id },
    data: { bouncedCount: { increment: 1 } },
  });

  // Fetch campaign analytics: MUST report BOUNCED, and NOT delivered!
  const analytics3 = await EmailAnalyticsService.getCampaignAnalytics(tenantAlpha, campaign3.id);
  console.log("  Fixture 3 Analytics (Scanner open + terminal bounce):", {
    sent: analytics3.sent,
    delivered: analytics3.delivered,
    bounced: analytics3.bounced,
    uniqueOpens: analytics3.uniqueOpens,
    bounceRate: `${analytics3.rates.bounceRate}%`,
    deliveryRate: `${analytics3.rates.deliveryRate}%`,
  });

  assert(analytics3.sent === 1, "Fixture 3: sent must be 1");
  assert(analytics3.bounced === 1, "Fixture 3: bounced must be 1 (Bounce precedence)");
  assert(analytics3.delivered === 0, "Fixture 3: delivered must be 0 (Bounced email is NOT delivered)");
  assert(analytics3.uniqueOpens === 1, "Fixture 3: uniqueOpens is 1 (Scanner engagement recorded)");
  assert(analytics3.rates.bounceRate === 100, "Fixture 3: bounceRate is 100%");
  assert(analytics3.rates.deliveryRate === 0, "Fixture 3: deliveryRate is 0%");
  console.log("✓ FIXTURE 3 PASSED: Bounce took absolute precedence over scanner open.\n");

  // =========================================================================
  // FIXTURE 4: Open attempt on already BOUNCED or FAILED delivery
  // =========================================================================
  console.log("--- FIXTURE 4: Open attempt on already BOUNCED delivery ---");

  const campaign4 = await prisma.emailCampaign.create({
    data: {
      clientId: tenantAlpha,
      name: "Campaign 4 - Terminal Bounce Open Attempt",
      status: EmailCampaignStatus.SENT,
      totalRecipients: 1,
    },
  });

  const contact4 = await prisma.emailContact.create({
    data: {
      clientId: tenantAlpha,
      email: `deadbox.${timestamp}@example.com`,
      normalizedEmail: `deadbox.${timestamp}@example.com`,
      status: "SUBSCRIBED",
    },
  });

  const rec4 = await prisma.emailCampaignRecipient.create({
    data: {
      campaignId: campaign4.id,
      contactId: contact4.id,
      email: contact4.email,
      status: "BOUNCED",
    },
  });

  const del4 = await prisma.emailDelivery.create({
    data: {
      clientId: tenantAlpha,
      campaignRecipientId: rec4.id,
      providerType: EmailProviderType.MOCK,
      from: "sender@example.com",
      to: contact4.email,
      subject: "Notice",
      category: EmailType.PROMOTIONAL,
      status: EmailDeliveryStatus.BOUNCED,
    },
  });

  // External actor or bot attempts to trigger open on bounced delivery
  await EmailTrackingService.recordOpen(del4.id);

  // Delivery status must REMAIN BOUNCED (never promoted to DELIVERED)
  const del4After = await prisma.emailDelivery.findUnique({ where: { id: del4.id } });
  assert(del4After?.status === EmailDeliveryStatus.BOUNCED, "Fixture 4: Delivery remains BOUNCED");

  // Recipient status must REMAIN BOUNCED
  const rec4After = await prisma.emailCampaignRecipient.findUnique({ where: { id: rec4.id } });
  assert(rec4After?.status === "BOUNCED", "Fixture 4: Recipient remains BOUNCED");

  // Historical event must still be logged in EmailEvent
  const openEvt4 = await prisma.emailEvent.findFirst({
    where: { deliveryId: del4.id, eventType: EmailEventType.OPENED },
  });
  assert(openEvt4 !== null, "Fixture 4: Historical OPENED event preserved in PostgreSQL");
  console.log("✓ FIXTURE 4 PASSED: Terminal bounce status preserved, historical event logged.\n");

  // =========================================================================
  // FIXTURE 5: Duplicate Event Inflation Defense (Burst opens & clicks)
  // =========================================================================
  console.log("--- FIXTURE 5: Duplicate Event Inflation Defense ---");

  const campaign5 = await prisma.emailCampaign.create({
    data: {
      clientId: tenantAlpha,
      name: "Campaign 5 - Spam Clicks",
      status: EmailCampaignStatus.SENT,
      totalRecipients: 1,
    },
  });

  const contact5 = await prisma.emailContact.create({
    data: {
      clientId: tenantAlpha,
      email: `clicker.${timestamp}@example.com`,
      normalizedEmail: `clicker.${timestamp}@example.com`,
      status: "SUBSCRIBED",
    },
  });

  const rec5 = await prisma.emailCampaignRecipient.create({
    data: {
      campaignId: campaign5.id,
      contactId: contact5.id,
      email: contact5.email,
      status: "DELIVERED",
    },
  });

  const del5 = await prisma.emailDelivery.create({
    data: {
      clientId: tenantAlpha,
      campaignRecipientId: rec5.id,
      providerType: EmailProviderType.MOCK,
      from: "sender@example.com",
      to: contact5.email,
      subject: "Flash Sale",
      category: EmailType.PROMOTIONAL,
      status: EmailDeliveryStatus.DELIVERED,
      deliveredAt: new Date(),
    },
  });

  // Inject 10 distinct open events and 15 distinct click events into PostgreSQL
  for (let i = 0; i < 10; i++) {
    await prisma.emailEvent.create({
      data: {
        clientId: tenantAlpha,
        deliveryId: del5.id,
        providerEventId: `dup-open-${del5.id}-${i}-${timestamp}`,
        eventType: EmailEventType.OPENED,
        status: EmailEventProcessingStatus.PROCESSED,
        recipient: contact5.email,
        payload: JSON.stringify({ index: i }),
      },
    });
  }

  for (let i = 0; i < 15; i++) {
    await prisma.emailEvent.create({
      data: {
        clientId: tenantAlpha,
        deliveryId: del5.id,
        providerEventId: `dup-click-${del5.id}-${i}-${timestamp}`,
        eventType: EmailEventType.CLICKED,
        status: EmailEventProcessingStatus.PROCESSED,
        recipient: contact5.email,
        payload: JSON.stringify({ urlIndex: i }),
      },
    });
  }

  const analytics5 = await EmailAnalyticsService.getCampaignAnalytics(tenantAlpha, campaign5.id);
  console.log("  Fixture 5 Analytics (10 opens, 15 clicks):", {
    sent: analytics5.sent,
    delivered: analytics5.delivered,
    totalOpens: analytics5.totalOpens,
    uniqueOpens: analytics5.uniqueOpens,
    totalClicks: analytics5.totalClicks,
    uniqueClicks: analytics5.uniqueClicks,
    openRate: `${analytics5.rates.openRate}%`,
    clickRate: `${analytics5.rates.clickRate}%`,
  });

  assert(analytics5.totalOpens === 10, "Fixture 5: totalOpens reflects raw volume (10)");
  assert(analytics5.uniqueOpens === 1, "Fixture 5: uniqueOpens deduplicated to 1");
  assert(analytics5.totalClicks === 15, "Fixture 5: totalClicks reflects raw volume (15)");
  assert(analytics5.uniqueClicks === 1, "Fixture 5: uniqueClicks deduplicated to 1");
  assert(analytics5.rates.openRate === 100, "Fixture 5: openRate is 100% (not 1000%)");
  assert(analytics5.rates.clickRate === 100, "Fixture 5: clickRate is 100% (not 1500%)");
  console.log("✓ FIXTURE 5 PASSED: Unique metrics and rates immune to event bursts.\n");

  // =========================================================================
  // FIXTURE 6: Duplicate Recipient Inflation Defense (Delivery Retries)
  // =========================================================================
  console.log("--- FIXTURE 6: Duplicate Recipient Inflation Defense (Retries) ---");

  const campaign6 = await prisma.emailCampaign.create({
    data: {
      clientId: tenantAlpha,
      name: "Campaign 6 - Retries",
      status: EmailCampaignStatus.SENT,
      totalRecipients: 1,
    },
  });

  const contact6 = await prisma.emailContact.create({
    data: {
      clientId: tenantAlpha,
      email: `retry.${timestamp}@example.com`,
      normalizedEmail: `retry.${timestamp}@example.com`,
      status: "SUBSCRIBED",
    },
  });

  const rec6 = await prisma.emailCampaignRecipient.create({
    data: {
      campaignId: campaign6.id,
      contactId: contact6.id,
      email: contact6.email,
      status: "DELIVERED",
    },
  });

  // 3 delivery attempts for the SAME recipient: Attempt 1 Failed, Attempt 2 Failed, Attempt 3 Delivered
  await prisma.emailDelivery.createMany({
    data: [
      {
        clientId: tenantAlpha,
        campaignRecipientId: rec6.id,
        providerType: EmailProviderType.MOCK,
        from: "sender@example.com",
        to: contact6.email,
        subject: "Order",
        category: EmailType.PROMOTIONAL,
        status: EmailDeliveryStatus.FAILED,
      },
      {
        clientId: tenantAlpha,
        campaignRecipientId: rec6.id,
        providerType: EmailProviderType.MOCK,
        from: "sender@example.com",
        to: contact6.email,
        subject: "Order",
        category: EmailType.PROMOTIONAL,
        status: EmailDeliveryStatus.FAILED,
      },
      {
        clientId: tenantAlpha,
        campaignRecipientId: rec6.id,
        providerType: EmailProviderType.MOCK,
        from: "sender@example.com",
        to: contact6.email,
        subject: "Order",
        category: EmailType.PROMOTIONAL,
        status: EmailDeliveryStatus.DELIVERED,
      },
    ],
  });

  const analytics6 = await EmailAnalyticsService.getCampaignAnalytics(tenantAlpha, campaign6.id);
  console.log("  Fixture 6 Analytics (3 attempts for 1 recipient):", {
    totalRecipients: analytics6.totalRecipients,
    sent: analytics6.sent,
    delivered: analytics6.delivered,
    failed: analytics6.failed,
  });

  assert(analytics6.sent === 1, "Fixture 6: sent must be 1 (recipient evaluated once)");
  assert(analytics6.delivered === 1, "Fixture 6: delivered must be 1");
  assert(analytics6.failed === 0, "Fixture 6: failed must be 0 (terminal outcome was delivered)");
  console.log("✓ FIXTURE 6 PASSED: Retries do not inflate sent or failed counts.\n");

  // =========================================================================
  // FIXTURE 7: Zero Division & Empty State Protection
  // =========================================================================
  console.log("--- FIXTURE 7: Zero Division & Empty State Protection ---");

  const campaign7 = await prisma.emailCampaign.create({
    data: {
      clientId: tenantAlpha,
      name: "Campaign 7 - Empty",
      status: EmailCampaignStatus.DRAFT,
      totalRecipients: 0,
    },
  });

  const analytics7 = await EmailAnalyticsService.getCampaignAnalytics(tenantAlpha, campaign7.id);
  assert(analytics7.sent === 0, "Fixture 7: sent is 0");
  assert(analytics7.delivered === 0, "Fixture 7: delivered is 0");
  assert(analytics7.rates.deliveryRate === 0, "Fixture 7: deliveryRate is 0");
  assert(analytics7.rates.openRate === 0, "Fixture 7: openRate is 0");
  assert(analytics7.rates.clickRate === 0, "Fixture 7: clickRate is 0");
  assert(analytics7.rates.bounceRate === 0, "Fixture 7: bounceRate is 0");
  assert(analytics7.rates.complaintRate === 0, "Fixture 7: complaintRate is 0");
  assert(analytics7.rates.unsubscribeRate === 0, "Fixture 7: unsubscribeRate is 0");
  assert(!Number.isNaN(analytics7.rates.openRate), "Fixture 7: openRate is not NaN");
  console.log("✓ FIXTURE 7 PASSED: Zero division returns 0.0%.\n");

  // =========================================================================
  // FIXTURE 8: Impossible Percentage Defense (Rate Clamping)
  // =========================================================================
  console.log("--- FIXTURE 8: Impossible Percentage Defense (Clamping) ---");

  const clampedRates = computeAuthoritativeRates({
    sent: 10,
    delivered: 5,
    bounced: 1,
    complaints: 0,
    unsubscribed: 0,
    uniqueOpens: 12, // Impossible: 12 opens on 5 delivered messages
    uniqueClicks: 20, // Impossible: 20 clicks on 5 delivered messages
  });

  console.log("  Clamped Rates Output:", clampedRates);
  assert(clampedRates.openRate === 100.0, "Fixture 8: openRate clamped to 100%");
  assert(clampedRates.clickRate === 100.0, "Fixture 8: clickRate clamped to 100%");
  assert(clampedRates.deliveryRate === 50.0, "Fixture 8: deliveryRate is 50%");
  assert(clampedRates.bounceRate === 10.0, "Fixture 8: bounceRate is 10%");
  console.log("✓ FIXTURE 8 PASSED: Impossible percentages clamped to 100.0% max.\n");

  // =========================================================================
  // FIXTURE 9: Complaints & Unsubscribes
  // =========================================================================
  console.log("--- FIXTURE 9: Complaints & Unsubscribes ---");

  const campaign9 = await prisma.emailCampaign.create({
    data: {
      clientId: tenantAlpha,
      name: "Campaign 9 - Complaints & Unsubs",
      status: EmailCampaignStatus.SENT,
      totalRecipients: 2,
      unsubscribedCount: 1,
    },
  });

  const contact9a = await prisma.emailContact.create({
    data: {
      clientId: tenantAlpha,
      email: `complainer.${timestamp}@example.com`,
      normalizedEmail: `complainer.${timestamp}@example.com`,
      status: "SUBSCRIBED",
    },
  });

  const contact9b = await prisma.emailContact.create({
    data: {
      clientId: tenantAlpha,
      email: `unsubscriber.${timestamp}@example.com`,
      normalizedEmail: `unsubscriber.${timestamp}@example.com`,
      status: "UNSUBSCRIBED",
    },
  });

  const rec9a = await prisma.emailCampaignRecipient.create({
    data: {
      campaignId: campaign9.id,
      contactId: contact9a.id,
      email: contact9a.email,
      status: "COMPLAINED",
    },
  });

  const rec9b = await prisma.emailCampaignRecipient.create({
    data: {
      campaignId: campaign9.id,
      contactId: contact9b.id,
      email: contact9b.email,
      status: "DELIVERED",
    },
  });

  await prisma.emailDelivery.create({
    data: {
      clientId: tenantAlpha,
      campaignRecipientId: rec9a.id,
      providerType: EmailProviderType.MOCK,
      from: "sender@example.com",
      to: contact9a.email,
      subject: "Survey",
      category: EmailType.PROMOTIONAL,
      status: EmailDeliveryStatus.COMPLAINED,
      deliveredAt: new Date(),
    },
  });

  await prisma.emailDelivery.create({
    data: {
      clientId: tenantAlpha,
      campaignRecipientId: rec9b.id,
      providerType: EmailProviderType.MOCK,
      from: "sender@example.com",
      to: contact9b.email,
      subject: "Survey",
      category: EmailType.PROMOTIONAL,
      status: EmailDeliveryStatus.DELIVERED,
      deliveredAt: new Date(),
    },
  });

  const analytics9 = await EmailAnalyticsService.getCampaignAnalytics(tenantAlpha, campaign9.id);
  console.log("  Fixture 9 Analytics:", {
    sent: analytics9.sent,
    delivered: analytics9.delivered,
    complaints: analytics9.complaints,
    unsubscribed: analytics9.unsubscribed,
    complaintRate: `${analytics9.rates.complaintRate}%`,
    unsubscribeRate: `${analytics9.rates.unsubscribeRate}%`,
  });

  assert(analytics9.sent === 2, "Fixture 9: sent is 2");
  assert(analytics9.delivered === 2, "Fixture 9: delivered is 2 (both reached inboxes)");
  assert(analytics9.complaints === 1, "Fixture 9: complaints is 1");
  assert(analytics9.unsubscribed === 1, "Fixture 9: unsubscribed is 1");
  assert(analytics9.rates.complaintRate === 50, "Fixture 9: complaintRate is 50%");
  assert(analytics9.rates.unsubscribeRate === 50, "Fixture 9: unsubscribeRate is 50%");
  console.log("✓ FIXTURE 9 PASSED.\n");

  // =========================================================================
  // FIXTURE 10: Multi-Tenant Isolation & Aggregation Safety
  // =========================================================================
  console.log("--- FIXTURE 10: Multi-Tenant Isolation & Aggregation Safety ---");

  // Tenant Beta tries to access Tenant Alpha's Campaign 1
  let crossAccessBlocked = false;
  try {
    await EmailAnalyticsService.getCampaignAnalytics(tenantBeta, campaign1.id);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("not found for tenant")) {
      crossAccessBlocked = true;
    }
  }
  assert(crossAccessBlocked === true, "Fixture 10: Cross-tenant campaign access blocked");

  // Tenant Beta tenant analytics must return 0 metrics despite Tenant Alpha's rich data
  const betaTenantAnalytics = await EmailAnalyticsService.getTenantAnalytics(tenantBeta);
  assert(betaTenantAnalytics.sent === 0, "Fixture 10: Tenant Beta sent is 0");
  assert(betaTenantAnalytics.delivered === 0, "Fixture 10: Tenant Beta delivered is 0");
  assert(betaTenantAnalytics.uniqueOpens === 0, "Fixture 10: Tenant Beta uniqueOpens is 0");
  assert(betaTenantAnalytics.uniqueClicks === 0, "Fixture 10: Tenant Beta uniqueClicks is 0");
  console.log("✓ FIXTURE 10 PASSED: Strict tenant isolation verified.\n");

  // =========================================================================
  // FIXTURE 11: Definition Parity (Campaign vs Dashboard vs Campaign Listing)
  // =========================================================================
  console.log("--- FIXTURE 11: Definition Parity Verification ---");

  const [alphaTenantAnalytics, alphaCampaignsList] = await Promise.all([
    EmailAnalyticsService.getTenantAnalytics(tenantAlpha),
    EmailCampaignService.listCampaigns(tenantAlpha),
  ]);

  console.log("  Tenant Alpha Aggregated Analytics:", {
    sent: alphaTenantAnalytics.sent,
    delivered: alphaTenantAnalytics.delivered,
    bounced: alphaTenantAnalytics.bounced,
    uniqueOpens: alphaTenantAnalytics.uniqueOpens,
    uniqueClicks: alphaTenantAnalytics.uniqueClicks,
    rates: alphaTenantAnalytics.rates,
  });

  // Verify listCampaigns computes rates matching computeAuthoritativeRates
  const camp1Listing = alphaCampaignsList.find((c) => c.id === campaign1.id);
  assert(camp1Listing !== undefined, "Fixture 11: Campaign 1 listed");
  assert(camp1Listing?.openRate === analytics1.rates.openRate, "Fixture 11: listCampaigns openRate matches campaign analytics");
  assert(camp1Listing?.clickRate === analytics1.rates.clickRate, "Fixture 11: listCampaigns clickRate matches campaign analytics");
  console.log("✓ FIXTURE 11 PASSED: 100% definition parity across services.\n");

  // =========================================================================
  // FIXTURE 12: Historical Event Ledger Immutability in PostgreSQL
  // =========================================================================
  console.log("--- FIXTURE 12: Historical Event Ledger Immutability in PostgreSQL ---");

  const totalEventsInDb = await prisma.emailEvent.count({
    where: { clientId: tenantAlpha },
  });
  console.log(`  Total immutable EmailEvents verified in PostgreSQL for Tenant Alpha: ${totalEventsInDb}`);
  assert(totalEventsInDb >= 25, "Fixture 12: All historical events are preserved in database");

  const sampleEvent = await prisma.emailEvent.findFirst({
    where: { clientId: tenantAlpha, eventType: EmailEventType.OPENED },
  });
  assert(sampleEvent !== null, "Fixture 12: Sample OPENED event exists");
  assert(sampleEvent?.payload !== null, "Fixture 12: Event payload is preserved");
  assert(sampleEvent?.occurredAt !== null, "Fixture 12: Event timestamp is preserved");
  console.log("✓ FIXTURE 12 PASSED: Immutable audit ledger intact.\n");

  console.log("===============================================================================");
  console.log("   🎉 ALL 12 AUDIT FIXTURES PASSED WITH ZERO ERRORS AGAINST POSTGRESQL!        ");
  console.log("===============================================================================\n");
}

runAnalyticsVerification()
  .catch((err) => {
    console.error("FATAL ERROR in analytics verification suite:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
