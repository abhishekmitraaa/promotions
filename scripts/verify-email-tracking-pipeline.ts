/**
 * Complete Email Tracking Pipeline Integration Verification Suite
 *
 * Real disposable PostgreSQL + Redis integration test suite validating:
 * 1. Campaign rendered HTML contains an open pixel
 * 2. Eligible links are converted to tracking URLs (mailto, anchors, unsafe protocols, unsubscribe skipped)
 * 3. Raw recipient email is strictly absent from tracking tokens and query params
 * 4. Tracking tokens expire (expired tokens are rejected)
 * 5. Tampering fails (modified signature or payload rejected via timing-safe check)
 * 6. Unsafe redirects fail (CRLF injection, javascript:, data: protocols blocked)
 * 7. Click events are recorded (EmailEvent persisted, delivery transitioned to DELIVERED)
 * 8. Open events are recorded (EmailEvent persisted, delivery transitioned to DELIVERED)
 * 9. Duplicate tracking requests do not inflate unique counts incorrectly
 * 10. Campaign analytics reflect real events and match stored database records
 */

process.env.DATABASE_URL = "postgresql://postgres:postgres@127.0.0.1:5433/email_test";
process.env.DIRECT_URL = "postgresql://postgres:postgres@127.0.0.1:5433/email_test";
process.env.REDIS_URL = "redis://127.0.0.1:6379";
process.env.REDIS_HOST = "127.0.0.1";
process.env.REDIS_PORT = "6379";
process.env.ALLOW_DESTRUCTIVE_TESTS = "true";
process.env.NODE_ENV = "test";
process.env.EMAIL_TRACKING_SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.NEXT_PUBLIC_APP_URL = "https://hub.example.com";

import { prisma } from "../src/lib/prisma";
import { EmailTrackingService } from "../src/lib/email/tracking/email-tracking-service";
import { EmailAnalyticsService } from "../src/lib/services/email-analytics-service";
import { EmailCampaignService } from "../src/lib/services/email-campaign-service";
import { processCampaignRecipientJob } from "../src/lib/email/queue/campaign-worker";
import { EmailProvider, EmailSendRequest, EmailSendResult } from "../src/lib/email/types";
import {
  EmailCampaignStatus,
  EmailDeliveryStatus,
  EmailEventType,
  EmailEventProcessingStatus,
  EmailProviderType,
  EmailType,
} from "@prisma/client";
import { parse } from "node-html-parser";

// In-memory capture mock provider
class TrackingCaptureEmailProvider implements EmailProvider {
  name = "MockTrackingProvider";
  providerType = EmailProviderType.MOCK;
  sentEmails: EmailSendRequest[] = [];

  async send(request: EmailSendRequest): Promise<EmailSendResult> {
    this.sentEmails.push(request);
    return {
      accepted: true,
      providerMessageId: `msg-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      status: "SENT",
    };
  }

  reset() {
    this.sentEmails = [];
  }
}

async function cleanupTestData(tenantId: string) {
  try {
    await prisma.emailEvent.deleteMany({ where: { clientId: tenantId } });
    await prisma.emailDelivery.deleteMany({ where: { clientId: tenantId } });
    await prisma.emailCampaignRecipient.deleteMany({ where: { campaign: { clientId: tenantId } } });
    await prisma.emailCampaign.deleteMany({ where: { clientId: tenantId } });
    await prisma.emailTemplateVersion.deleteMany({ where: { template: { clientId: tenantId } } });
    await prisma.emailTemplate.deleteMany({ where: { clientId: tenantId } });
    await prisma.emailContact.deleteMany({ where: { clientId: tenantId } });
    await prisma.apiClient.deleteMany({ where: { id: tenantId } });
  } catch (err) {
    console.warn("[Cleanup] Warning during cleanup:", err);
  }
}

async function runTests() {
  console.log("=== Starting Email Tracking Pipeline Verification Suite ===\n");
  let tenantId = "";
  const mockProvider = new TrackingCaptureEmailProvider();

  try {
    // 0. Setup Tenant, Template, and Contact
    console.log("Setting up tenant and initial test entities...");
    const client = await prisma.apiClient.create({
      data: {
        name: "Tracking Test Tenant",
        active: true,
      },
    });
    tenantId = client.id;

    const template = await prisma.emailTemplate.create({
      data: {
        clientId: tenantId,
        name: "Tracking Test Template",
        type: "PROMOTIONAL",
      },
    });

    // Template with varied links: eligible, mailto, anchor, unsubscribe, crlf, and javascript
    const rawHtml = `<!DOCTYPE html>
<html>
<head><title>Spring Sale</title></head>
<body>
  <h1>Exclusive Spring Deals</h1>
  <p>Hello, check out our deals below:</p>
  <p><a id="deal-link" href="https://store.example.com/deals?ref=spring">Shop Spring Deals</a></p>
  <p><a id="catalog-link" href="http://store.example.com/catalog">Browse Catalog</a></p>
  <p><a id="mailto-link" href="mailto:support@example.com">Contact Support</a></p>
  <p><a id="anchor-link" href="#terms-and-conditions">Terms & Conditions</a></p>
  <p><a id="js-link" href="javascript:alert('malicious')">Dangerous JS</a></p>
  <p><a id="data-link" href="data:text/html,<h1>bad</h1>">Data URI</a></p>
  <p><a id="crlf-link" href="https://example.com/evil\r\npath">CRLF Link</a></p>
  <p><a id="unsub-link" href="https://hub.example.com/api/email/unsubscribe?token=sample">Unsubscribe</a></p>
  <p><a id="skip-track-link" data-skip-track="true" href="https://example.com/do-not-track">Skip Track Link</a></p>
  <div id="terms-and-conditions"><p>Terms go here</p></div>
</body>
</html>`;

    const version = await prisma.emailTemplateVersion.create({
      data: {
        templateId: template.id,
        version: 1,
        subject: "Exclusive Spring Deals for {{email}}",
        htmlContent: rawHtml,
        textContent: "Exclusive Spring Deals",
        status: "ACTIVE",
      },
    });

    await prisma.emailTemplate.update({
      where: { id: template.id },
      data: { activeVersionId: version.id },
    });

    const contact1 = await prisma.emailContact.create({
      data: {
        clientId: tenantId,
        email: "alice.buyer@example.com",
        normalizedEmail: "alice.buyer@example.com",
        status: "SUBSCRIBED",
        hasMarketingConsent: true,
      },
    });

    const campaign = await prisma.emailCampaign.create({
      data: {
        clientId: tenantId,
        name: "Spring Sale 2026",
        status: EmailCampaignStatus.RUNNING,
        type: EmailType.PROMOTIONAL,
        templateVersionId: version.id,
        totalRecipients: 1,
      },
    });

    const recipient1 = await prisma.emailCampaignRecipient.create({
      data: {
        campaignId: campaign.id,
        contactId: contact1.id,
        email: contact1.email,
        status: "PENDING",
      },
    });

    console.log("Initial setup complete.\n");

    // =========================================================================
    // Test 1: Campaign rendered HTML contains an open pixel
    // =========================================================================
    console.log("TEST 1: Campaign rendered HTML contains an open pixel");
    mockProvider.reset();

    const jobMock = {
      id: `job-rec-1-${Date.now()}`,
      name: "PROCESS_CAMPAIGN_RECIPIENT",
      data: {
        campaignId: campaign.id,
        campaignRecipientId: recipient1.id,
        clientId: tenantId,
      },
    } as any;

    const result1 = await processCampaignRecipientJob(jobMock, { providerOverride: mockProvider });
    if (!result1.success) {
      throw new Error(`Test 1 Failed: Recipient job did not succeed: ${JSON.stringify(result1)}`);
    }

    if (mockProvider.sentEmails.length !== 1) {
      throw new Error(`Test 1 Failed: Expected 1 sent email, got ${mockProvider.sentEmails.length}`);
    }

    const sentEmail = mockProvider.sentEmails[0];
    const parsedHtml = parse(sentEmail.html);

    // Find <img> tag that points to /api/email/track/open/
    const allImages = parsedHtml.querySelectorAll("img");
    const openPixels = allImages.filter((img) =>
      (img.getAttribute("src") || "").includes("/api/email/track/open/")
    );

    if (openPixels.length !== 1) {
      throw new Error(`Test 1 Failed: Expected 1 open tracking pixel, found ${openPixels.length}`);
    }

    const pixelImg = openPixels[0];
    const pixelSrc = pixelImg.getAttribute("src")!;
    console.log(`  Dispatched open pixel: ${pixelSrc}`);

    // Verify application base URL used
    if (!pixelSrc.startsWith("https://hub.example.com/api/email/track/open/")) {
      throw new Error(`Test 1 Failed: Open pixel does not use configured base URL. Got: ${pixelSrc}`);
    }

    // Verify cache buster query parameter exists
    if (!pixelSrc.includes("?cb=") || pixelSrc.split("?cb=")[1].length === 0) {
      throw new Error("Test 1 Failed: Open pixel missing cache-busting (?cb=) query param");
    }

    // Verify pixel dimensions and hidden styling
    if (pixelImg.getAttribute("width") !== "1" || pixelImg.getAttribute("height") !== "1") {
      throw new Error("Test 1 Failed: Open pixel width/height is not 1x1");
    }

    // Verify HTML validity: document has <body>, <h1>, and ends properly
    if (!parsedHtml.querySelector("body") || !parsedHtml.querySelector("h1")) {
      throw new Error("Test 1 Failed: HTML structure corrupted after injection");
    }

    console.log("✓ TEST 1 PASSED: Open pixel correctly injected into campaign HTML with cache-busting.\n");

    // =========================================================================
    // Test 2: Links are converted to tracking URLs
    // =========================================================================
    console.log("TEST 2: Links are converted to tracking URLs");

    const dealLink = parsedHtml.querySelector("#deal-link");
    const catalogLink = parsedHtml.querySelector("#catalog-link");
    const mailtoLink = parsedHtml.querySelector("#mailto-link");
    const anchorLink = parsedHtml.querySelector("#anchor-link");
    const jsLink = parsedHtml.querySelector("#js-link");
    const dataLink = parsedHtml.querySelector("#data-link");
    const crlfLink = parsedHtml.querySelector("#crlf-link");
    const unsubLink = parsedHtml.querySelector("#unsub-link");
    const skipTrackLink = parsedHtml.querySelector("#skip-track-link");

    // Eligible links MUST be converted to tracking URLs
    const dealHref = dealLink?.getAttribute("href") || "";
    const catalogHref = catalogLink?.getAttribute("href") || "";

    if (!dealHref.startsWith("https://hub.example.com/api/email/track/click/")) {
      throw new Error(`Test 2 Failed: deal-link was not converted to tracking URL. Got: ${dealHref}`);
    }
    if (!catalogHref.startsWith("https://hub.example.com/api/email/track/click/")) {
      throw new Error(`Test 2 Failed: catalog-link was not converted to tracking URL. Got: ${catalogHref}`);
    }

    // Ineligible links MUST NOT be converted
    if (mailtoLink?.getAttribute("href") !== "mailto:support@example.com") {
      throw new Error(`Test 2 Failed: mailto link was modified: ${mailtoLink?.getAttribute("href")}`);
    }
    if (anchorLink?.getAttribute("href") !== "#terms-and-conditions") {
      throw new Error(`Test 2 Failed: anchor link was modified: ${anchorLink?.getAttribute("href")}`);
    }
    if (jsLink?.getAttribute("href") !== "javascript:alert('malicious')") {
      throw new Error(`Test 2 Failed: javascript: link was modified: ${jsLink?.getAttribute("href")}`);
    }
    if (dataLink?.getAttribute("href") !== "data:text/html,<h1>bad</h1>") {
      throw new Error(`Test 2 Failed: data: link was modified: ${dataLink?.getAttribute("href")}`);
    }
    if (crlfLink?.getAttribute("href") !== "https://example.com/evil\r\npath") {
      throw new Error(`Test 2 Failed: CRLF link was modified: ${crlfLink?.getAttribute("href")}`);
    }
    if (!unsubLink?.getAttribute("href")?.includes("/api/email/unsubscribe")) {
      throw new Error(`Test 2 Failed: unsubscribe link was modified: ${unsubLink?.getAttribute("href")}`);
    }
    if (skipTrackLink?.getAttribute("href") !== "https://example.com/do-not-track") {
      throw new Error(`Test 2 Failed: skip-track link was modified: ${skipTrackLink?.getAttribute("href")}`);
    }

    console.log("✓ TEST 2 PASSED: Eligible links wrapped; mailto, anchors, unsafe protocols, CRLF, and unsubscribe skipped.\n");

    // =========================================================================
    // Test 3: Raw recipient email is absent from tracking tokens
    // =========================================================================
    console.log("TEST 3: Raw recipient email is absent from tracking tokens");

    // Extract tokens
    const openTokenWithCb = pixelSrc.replace("https://hub.example.com/api/email/track/open/", "");
    const openToken = openTokenWithCb.split("?")[0];
    const clickToken = dealHref.replace("https://hub.example.com/api/email/track/click/", "");

    if (openToken.includes(contact1.email) || pixelSrc.includes(contact1.email)) {
      throw new Error(`Test 3 Failed: Raw email found in open pixel URL: ${pixelSrc}`);
    }
    if (clickToken.includes(contact1.email) || dealHref.includes(contact1.email)) {
      throw new Error(`Test 3 Failed: Raw email found in click tracking URL: ${dealHref}`);
    }

    // Inspect open token payload
    const [openPayloadStr] = openToken.split(".");
    const openPayload = JSON.parse(Buffer.from(openPayloadStr, "base64url").toString("utf8"));
    console.log("  Decoded open token payload:", openPayload);

    if (openPayload.email || openPayload.recipient || openPayload.to) {
      throw new Error(`Test 3 Failed: Raw email found inside open token payload: ${JSON.stringify(openPayload)}`);
    }
    if (!openPayload.deliveryId || !openPayload.clientId || !openPayload.exp) {
      throw new Error(`Test 3 Failed: Open token missing required fields: ${JSON.stringify(openPayload)}`);
    }

    // Inspect click token payload
    const [clickPayloadStr] = clickToken.split(".");
    const clickPayload = JSON.parse(Buffer.from(clickPayloadStr, "base64url").toString("utf8"));
    console.log("  Decoded click token payload:", clickPayload);

    if (clickPayload.email || clickPayload.recipient || clickPayload.to) {
      throw new Error(`Test 3 Failed: Raw email found inside click token payload: ${JSON.stringify(clickPayload)}`);
    }
    if (clickPayload.targetUrl !== "https://store.example.com/deals?ref=spring") {
      throw new Error(`Test 3 Failed: Original target URL not preserved: ${clickPayload.targetUrl}`);
    }

    console.log("✓ TEST 3 PASSED: Raw recipient email is completely absent from all tokens and payloads.\n");

    // =========================================================================
    // Test 4: Tracking tokens expire
    // =========================================================================
    console.log("TEST 4: Tracking tokens expire");

    // Generate expired tokens (ttlMs = -1000)
    const expiredOpenToken = EmailTrackingService.generateOpenToken(tenantId, openPayload.deliveryId, -1000);
    const openExpResult = EmailTrackingService.verifyOpenToken(expiredOpenToken);
    if (openExpResult.valid || openExpResult.error !== "Token has expired") {
      throw new Error(`Test 4 Failed: Expired open token was not rejected. Result: ${JSON.stringify(openExpResult)}`);
    }

    const expiredClickToken = EmailTrackingService.generateClickToken(
      tenantId,
      openPayload.deliveryId,
      "https://example.com/page",
      -1000
    );
    const clickExpResult = EmailTrackingService.verifyClickToken(expiredClickToken);
    if (clickExpResult.valid || clickExpResult.error !== "Token has expired") {
      throw new Error(`Test 4 Failed: Expired click token was not rejected. Result: ${JSON.stringify(clickExpResult)}`);
    }

    console.log("✓ TEST 4 PASSED: Expired open and click tokens are strictly rejected.\n");

    // =========================================================================
    // Test 5: Tampering fails
    // =========================================================================
    console.log("TEST 5: Tampering fails");

    // 1. Tamper open signature
    const [oP, oSig] = openToken.split(".");
    const tamperedOpenSig = `${oP}.${oSig.slice(0, -1)}X`;
    const openTamperResult = EmailTrackingService.verifyOpenToken(tamperedOpenSig);
    if (openTamperResult.valid || !openTamperResult.error?.includes("signature")) {
      throw new Error(`Test 5 Failed: Tampered open signature accepted: ${JSON.stringify(openTamperResult)}`);
    }

    // 2. Tamper open payload (attempt cross-tenant or delivery ID swapping)
    const forgedOpenPayload = { ...openPayload, deliveryId: "victim-delivery-id" };
    const forgedOpenP = Buffer.from(JSON.stringify(forgedOpenPayload)).toString("base64url");
    const tamperedOpenPayload = `${forgedOpenP}.${oSig}`;
    const openPayloadTamperResult = EmailTrackingService.verifyOpenToken(tamperedOpenPayload);
    if (openPayloadTamperResult.valid || !openPayloadTamperResult.error?.includes("signature")) {
      throw new Error(`Test 5 Failed: Tampered open payload accepted: ${JSON.stringify(openPayloadTamperResult)}`);
    }

    // 3. Tamper click signature
    const [cP, cSig] = clickToken.split(".");
    const tamperedClickSig = `${cP}.${cSig.slice(0, -1)}Z`;
    const clickTamperResult = EmailTrackingService.verifyClickToken(tamperedClickSig);
    if (clickTamperResult.valid || !clickTamperResult.error?.includes("signature")) {
      throw new Error(`Test 5 Failed: Tampered click signature accepted: ${JSON.stringify(clickTamperResult)}`);
    }

    // 4. Tamper click payload (change destination URL to phishing domain)
    const forgedClickPayload = { ...clickPayload, targetUrl: "https://phishing.attacker.com" };
    const forgedClickP = Buffer.from(JSON.stringify(forgedClickPayload)).toString("base64url");
    const tamperedClickPayload = `${forgedClickP}.${cSig}`;
    const clickPayloadTamperResult = EmailTrackingService.verifyClickToken(tamperedClickPayload);
    if (clickPayloadTamperResult.valid || !clickPayloadTamperResult.error?.includes("signature")) {
      throw new Error(`Test 5 Failed: Tampered click target URL accepted: ${JSON.stringify(clickPayloadTamperResult)}`);
    }

    console.log("✓ TEST 5 PASSED: Signature and payload tampering are securely rejected.\n");

    // =========================================================================
    // Test 6: Unsafe redirects fail
    // =========================================================================
    console.log("TEST 6: Unsafe redirects fail");

    const unsafeUrls = [
      "javascript:alert(document.cookie)",
      "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
      "file:///etc/passwd",
      "https://example.com/redirect\r\nSet-Cookie: session=evil",
      "https://example.com/redirect\nLocation: https://evil.com",
      "vbscript:msgbox(1)",
      "not-a-valid-url",
    ];

    for (const unsafeUrl of unsafeUrls) {
      let rejected = false;
      try {
        EmailTrackingService.validateTargetUrl(unsafeUrl);
      } catch (err) {
        rejected = true;
      }
      if (!rejected) {
        throw new Error(`Test 6 Failed: Unsafe URL was not rejected by validateTargetUrl: '${unsafeUrl}'`);
      }

      // Also ensure generateClickToken rejects unsafe URLs immediately
      let genRejected = false;
      try {
        EmailTrackingService.generateClickToken(tenantId, openPayload.deliveryId, unsafeUrl);
      } catch (err) {
        genRejected = true;
      }
      if (!genRejected) {
        throw new Error(`Test 6 Failed: generateClickToken accepted unsafe URL: '${unsafeUrl}'`);
      }
    }

    console.log("✓ TEST 6 PASSED: All unsafe protocols, CRLF injections, and invalid schemes fail.\n");

    // =========================================================================
    // Test 7: Click events are recorded
    // =========================================================================
    console.log("TEST 7: Click events are recorded");

    const deliveryRecord = await prisma.emailDelivery.findUnique({
      where: { id: openPayload.deliveryId },
    });
    if (!deliveryRecord) {
      throw new Error(`Test 7 Failed: Delivery ${openPayload.deliveryId} not found in DB`);
    }
    if (deliveryRecord.status !== EmailDeliveryStatus.SENT) {
      throw new Error(`Test 7 Failed: Expected initial delivery status SENT, got ${deliveryRecord.status}`);
    }

    // Verify click token authenticity
    const clickVerify = EmailTrackingService.verifyClickToken(clickToken);
    if (!clickVerify.valid || !clickVerify.targetUrl || !clickVerify.deliveryId) {
      throw new Error(`Test 7 Failed: Valid click token failed verification: ${JSON.stringify(clickVerify)}`);
    }

    // Record click event
    const clickRecordResult = await EmailTrackingService.recordClick(
      clickVerify.deliveryId,
      clickVerify.targetUrl,
      { ip: "203.0.113.42", userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }
    );

    if (!clickRecordResult.recorded) {
      throw new Error("Test 7 Failed: recordClick returned recorded: false on first attempt");
    }

    // Verify EmailEvent in database
    const clickEvent = await prisma.emailEvent.findFirst({
      where: {
        deliveryId: clickVerify.deliveryId,
        eventType: EmailEventType.CLICKED,
      },
    });

    if (!clickEvent) {
      throw new Error("Test 7 Failed: CLICKED EmailEvent was not persisted to database");
    }
    if (clickEvent.status !== EmailEventProcessingStatus.PROCESSED) {
      throw new Error(`Test 7 Failed: Expected event status PROCESSED, got ${clickEvent.status}`);
    }

    const clickEventPayload = JSON.parse(clickEvent.payload);
    if (clickEventPayload.targetUrl !== "https://store.example.com/deals?ref=spring") {
      throw new Error(`Test 7 Failed: Payload targetUrl mismatch: ${clickEventPayload.targetUrl}`);
    }
    if (clickEventPayload.ip !== "203.0.113.42") {
      throw new Error(`Test 7 Failed: Payload IP mismatch: ${clickEventPayload.ip}`);
    }

    // Verify EmailDelivery was promoted from SENT to DELIVERED
    const updatedDeliveryAfterClick = await prisma.emailDelivery.findUnique({
      where: { id: openPayload.deliveryId },
    });
    if (updatedDeliveryAfterClick?.status !== EmailDeliveryStatus.DELIVERED) {
      throw new Error(
        `Test 7 Failed: Delivery status was not transitioned to DELIVERED. Current: ${updatedDeliveryAfterClick?.status}`
      );
    }

    console.log("✓ TEST 7 PASSED: Click event recorded, payload verified, delivery promoted to DELIVERED.\n");

    // =========================================================================
    // Test 8: Open events are recorded
    // =========================================================================
    console.log("TEST 8: Open events are recorded");

    const openVerify = EmailTrackingService.verifyOpenToken(openToken);
    if (!openVerify.valid || !openVerify.deliveryId) {
      throw new Error(`Test 8 Failed: Valid open token failed verification: ${JSON.stringify(openVerify)}`);
    }

    // Record open event
    const openRecordResult = await EmailTrackingService.recordOpen(
      openVerify.deliveryId,
      { ip: "203.0.113.42", userAgent: "Thunderbird/115.0" }
    );

    if (!openRecordResult.recorded) {
      throw new Error("Test 8 Failed: recordOpen returned recorded: false on first attempt");
    }

    // Verify EmailEvent in database
    const openEvent = await prisma.emailEvent.findFirst({
      where: {
        deliveryId: openVerify.deliveryId,
        eventType: EmailEventType.OPENED,
      },
    });

    if (!openEvent) {
      throw new Error("Test 8 Failed: OPENED EmailEvent was not persisted to database");
    }
    if (openEvent.status !== EmailEventProcessingStatus.PROCESSED) {
      throw new Error(`Test 8 Failed: Expected event status PROCESSED, got ${openEvent.status}`);
    }

    const openEventPayload = JSON.parse(openEvent.payload);
    if (openEventPayload.userAgent !== "Thunderbird/115.0") {
      throw new Error(`Test 8 Failed: Payload userAgent mismatch: ${openEventPayload.userAgent}`);
    }

    console.log("✓ TEST 8 PASSED: Open event recorded, metadata verified in database.\n");

    // =========================================================================
    // Test 9: Duplicate tracking requests do not inflate unique counts incorrectly
    // =========================================================================
    console.log("TEST 9: Duplicate tracking requests do not inflate unique counts incorrectly");

    // Attempt second open within deduplication window
    const dupOpenResult = await EmailTrackingService.recordOpen(openVerify.deliveryId);
    if (dupOpenResult.recorded !== false) {
      throw new Error("Test 9 Failed: Duplicate recordOpen should have returned recorded: false");
    }

    // Attempt second click on same URL within window
    const dupClickResult = await EmailTrackingService.recordClick(
      clickVerify.deliveryId,
      clickVerify.targetUrl
    );
    if (dupClickResult.recorded !== false) {
      throw new Error("Test 9 Failed: Duplicate recordClick should have returned recorded: false");
    }

    // Simulate additional open events in database across distinct time windows
    await prisma.emailEvent.create({
      data: {
        clientId: tenantId,
        deliveryId: openPayload.deliveryId,
        providerEventId: `simulated-open-window-2-${Date.now()}`,
        eventType: EmailEventType.OPENED,
        status: EmailEventProcessingStatus.PROCESSED,
        recipient: contact1.email,
        payload: JSON.stringify({ window: 2 }),
      },
    });

    await prisma.emailEvent.create({
      data: {
        clientId: tenantId,
        deliveryId: openPayload.deliveryId,
        providerEventId: `simulated-open-window-3-${Date.now()}`,
        eventType: EmailEventType.OPENED,
        status: EmailEventProcessingStatus.PROCESSED,
        recipient: contact1.email,
        payload: JSON.stringify({ window: 3 }),
      },
    });

    // Also simulate additional click event
    await prisma.emailEvent.create({
      data: {
        clientId: tenantId,
        deliveryId: openPayload.deliveryId,
        providerEventId: `simulated-click-window-2-${Date.now()}`,
        eventType: EmailEventType.CLICKED,
        status: EmailEventProcessingStatus.PROCESSED,
        recipient: contact1.email,
        payload: JSON.stringify({ window: 2, targetUrl: "https://store.example.com/catalog" }),
      },
    });

    // Fetch analytics and assert unique counts
    const singleRecipientAnalytics = await EmailAnalyticsService.getCampaignAnalytics(tenantId, campaign.id);
    console.log("  Single-recipient analytics with duplicate events:", {
      totalOpens: singleRecipientAnalytics.totalOpens,
      uniqueOpens: singleRecipientAnalytics.uniqueOpens,
      totalClicks: singleRecipientAnalytics.totalClicks,
      uniqueClicks: singleRecipientAnalytics.uniqueClicks,
      openRate: singleRecipientAnalytics.rates.openRate,
      clickRate: singleRecipientAnalytics.rates.clickRate,
    });

    if (singleRecipientAnalytics.totalOpens !== 3) {
      throw new Error(`Test 9 Failed: Expected 3 total opens, got ${singleRecipientAnalytics.totalOpens}`);
    }
    if (singleRecipientAnalytics.uniqueOpens !== 1) {
      throw new Error(`Test 9 Failed: Unique opens inflated! Expected 1, got ${singleRecipientAnalytics.uniqueOpens}`);
    }
    if (singleRecipientAnalytics.totalClicks !== 2) {
      throw new Error(`Test 9 Failed: Expected 2 total clicks, got ${singleRecipientAnalytics.totalClicks}`);
    }
    if (singleRecipientAnalytics.uniqueClicks !== 1) {
      throw new Error(`Test 9 Failed: Unique clicks inflated! Expected 1, got ${singleRecipientAnalytics.uniqueClicks}`);
    }
    if (singleRecipientAnalytics.rates.openRate !== 100) {
      throw new Error(`Test 9 Failed: Expected 100% open rate, got ${singleRecipientAnalytics.rates.openRate}%`);
    }

    console.log("✓ TEST 9 PASSED: Duplicate open and click events do NOT inflate unique metrics.\n");

    // =========================================================================
    // Test 10: Campaign analytics reflect real events
    // =========================================================================
    console.log("TEST 10: Campaign analytics reflect real events");

    // Create Recipient 2 (Opens only, does not click)
    const contact2 = await prisma.emailContact.create({
      data: {
        clientId: tenantId,
        email: "bob.reader@example.com",
        normalizedEmail: "bob.reader@example.com",
        status: "SUBSCRIBED",
        hasMarketingConsent: true,
      },
    });

    const recipient2 = await prisma.emailCampaignRecipient.create({
      data: {
        campaignId: campaign.id,
        contactId: contact2.id,
        email: contact2.email,
        status: "PENDING",
      },
    });

    // Create Recipient 3 (Bounces)
    const contact3 = await prisma.emailContact.create({
      data: {
        clientId: tenantId,
        email: "charlie.bounced@example.com",
        normalizedEmail: "charlie.bounced@example.com",
        status: "SUBSCRIBED",
        hasMarketingConsent: true,
      },
    });

    const recipient3 = await prisma.emailCampaignRecipient.create({
      data: {
        campaignId: campaign.id,
        contactId: contact3.id,
        email: contact3.email,
        status: "PENDING",
      },
    });

    // Update campaign totalRecipients
    await prisma.emailCampaign.update({
      where: { id: campaign.id },
      data: { totalRecipients: 3 },
    });

    // Dispatch Recipient 2
    const jobMock2 = {
      id: `job-rec-2-${Date.now()}`,
      name: "PROCESS_CAMPAIGN_RECIPIENT",
      data: {
        campaignId: campaign.id,
        campaignRecipientId: recipient2.id,
        clientId: tenantId,
      },
    } as any;
    const r2Result = await processCampaignRecipientJob(jobMock2, { providerOverride: mockProvider });
    if (!r2Result.success || !r2Result.deliveryId) {
      throw new Error(`Test 10 Failed: Dispatching recipient 2 failed: ${JSON.stringify(r2Result)}`);
    }

    // Recipient 2 opens
    await EmailTrackingService.recordOpen(r2Result.deliveryId);

    // Dispatch Recipient 3
    const jobMock3 = {
      id: `job-rec-3-${Date.now()}`,
      name: "PROCESS_CAMPAIGN_RECIPIENT",
      data: {
        campaignId: campaign.id,
        campaignRecipientId: recipient3.id,
        clientId: tenantId,
      },
    } as any;
    const r3Result = await processCampaignRecipientJob(jobMock3, { providerOverride: mockProvider });
    if (!r3Result.success || !r3Result.deliveryId) {
      throw new Error(`Test 10 Failed: Dispatching recipient 3 failed: ${JSON.stringify(r3Result)}`);
    }

    // Recipient 3 bounces
    await prisma.emailDelivery.update({
      where: { id: r3Result.deliveryId },
      data: {
        status: EmailDeliveryStatus.BOUNCED,
        failedAt: new Date(),
        errorCode: "550_USER_UNKNOWN",
      },
    });
    await prisma.emailCampaignRecipient.update({
      where: { id: recipient3.id },
      data: { status: "BOUNCED" },
    });
    await prisma.emailCampaign.update({
      where: { id: campaign.id },
      data: { bouncedCount: { increment: 1 } },
    });

    // Query authoritative analytics via EmailAnalyticsService
    const analytics = await EmailAnalyticsService.getCampaignAnalytics(tenantId, campaign.id);
    console.log("  Final authoritative campaign analytics:", {
      totalRecipients: analytics.totalRecipients,
      sent: analytics.sent,
      delivered: analytics.delivered,
      bounced: analytics.bounced,
      uniqueOpens: analytics.uniqueOpens,
      uniqueClicks: analytics.uniqueClicks,
      openRate: `${analytics.rates.openRate}%`,
      clickRate: `${analytics.rates.clickRate}%`,
      bounceRate: `${analytics.rates.bounceRate}%`,
    });

    // Assert exact real numbers:
    // 3 sent, 2 delivered (recipient 1 & recipient 2), 1 bounced (recipient 3)
    if (analytics.sent !== 3) {
      throw new Error(`Test 10 Failed: Expected 3 sent, got ${analytics.sent}`);
    }
    if (analytics.delivered !== 2) {
      throw new Error(`Test 10 Failed: Expected 2 delivered, got ${analytics.delivered}`);
    }
    if (analytics.bounced !== 1) {
      throw new Error(`Test 10 Failed: Expected 1 bounced, got ${analytics.bounced}`);
    }
    // 2 unique opens (recipient 1 and recipient 2)
    if (analytics.uniqueOpens !== 2) {
      throw new Error(`Test 10 Failed: Expected 2 unique opens, got ${analytics.uniqueOpens}`);
    }
    // 1 unique click (recipient 1 only)
    if (analytics.uniqueClicks !== 1) {
      throw new Error(`Test 10 Failed: Expected 1 unique click, got ${analytics.uniqueClicks}`);
    }
    // Rates: openRate = 2/2 = 100%, clickRate = 1/2 = 50%, bounceRate = 1/3 = 33.33%
    if (analytics.rates.openRate !== 100) {
      throw new Error(`Test 10 Failed: Expected openRate 100%, got ${analytics.rates.openRate}%`);
    }
    if (analytics.rates.clickRate !== 50) {
      throw new Error(`Test 10 Failed: Expected clickRate 50%, got ${analytics.rates.clickRate}%`);
    }
    if (analytics.rates.bounceRate !== 33.33) {
      throw new Error(`Test 10 Failed: Expected bounceRate 33.33%, got ${analytics.rates.bounceRate}%`);
    }

    // Query listCampaigns
    const listResults = await EmailCampaignService.listCampaigns(tenantId);
    const listedCampaign = listResults.find((c) => c.id === campaign.id);
    if (!listedCampaign) {
      throw new Error("Test 10 Failed: Campaign not found in listCampaigns");
    }

    console.log("  listCampaigns engagement summary:", {
      uniqueOpens: listedCampaign.uniqueOpens,
      uniqueClicks: listedCampaign.uniqueClicks,
      openRate: `${listedCampaign.openRate}%`,
      clickRate: `${listedCampaign.clickRate}%`,
    });

    if (listedCampaign.uniqueOpens !== 2 || listedCampaign.uniqueClicks !== 1) {
      throw new Error("Test 10 Failed: listCampaigns engagement numbers do not match real events");
    }
    if (listedCampaign.openRate !== 100 || listedCampaign.clickRate !== 50) {
      throw new Error("Test 10 Failed: listCampaigns rates do not match real calculated rates");
    }

    console.log("✓ TEST 10 PASSED: Campaign analytics and campaign listing strictly reflect real database events.\n");

    console.log("==================================================================");
    console.log("ALL 10 EMAIL TRACKING PIPELINE TESTS PASSED CLEANLY!");
    console.log("==================================================================");
  } finally {
    console.log("\nCleaning up test data...");
    await cleanupTestData(tenantId);
    await prisma.$disconnect();
  }
}

runTests().catch((err) => {
  console.error("\n❌ SUITE EXECUTION FAILED:", err);
  process.exit(1);
});
