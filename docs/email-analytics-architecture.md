# Email Analytics Architecture & Authoritative Semantics

This document establishes the formal analytics semantics, delivery state machine relationships, metric definitions, and technical limitations of the email analytics subsystem.

---

## 1. Core Lifecycle Concepts Separation

The email subsystem strictly separates transport-layer dispatch and delivery from application-layer user engagement. The eight core lifecycle concepts are:

| Concept | Layer | System Status / Event | Definition & Authority |
| :--- | :--- | :--- | :--- |
| **Provider Accepted** | Transport | `EmailDeliveryStatus.QUEUED` / `PROCESSING` | The email payload was validated and enqueued for provider dispatch, or accepted by the provider API/SMTP server for transmission. |
| **Sent** | Transport | `EmailDeliveryStatus.SENT` | The email was dispatched by the Mail Transfer Agent (MTA) or email provider over SMTP towards the destination MX. |
| **Delivered** | Transport | `EmailDeliveryStatus.DELIVERED` | The destination mail server confirmed receipt and accepted the message into the recipient's mailbox (SMTP 250 OK or explicit delivery webhook). |
| **Bounced** | Transport | `EmailDeliveryStatus.BOUNCED` | The destination mail server rejected delivery (5xx Hard Bounce e.g., mailbox unknown; or 4xx Soft Bounce e.g., mailbox full, DNS timeout). |
| **Complaint** | Transport / Abuse | `EmailDeliveryStatus.COMPLAINED` | The recipient marked the email as spam or reported abuse via an ISP Feedback Loop (FBL) or List-Unsubscribe mechanism. |
| **Open** | Engagement | `EmailEventType.OPENED` | An HTTP GET request was received for the 1x1 transparent tracking pixel embedded in the email HTML. |
| **Click** | Engagement | `EmailEventType.CLICKED` | An HTTP GET request was received for a tracked URL, verified via cryptographic HMAC token, and redirected to target destination. |
| **Unsubscribe** | Preference | `EmailSuppressionReason.UNSUBSCRIBED` | The recipient requested removal from marketing communications via one-click List-Unsubscribe (RFC 8058) or unsubscribe link. |

---

## 2. Inferred Delivery Semantics & Transport Hierarchy

### The Inferred Delivery Problem
In email protocols, transport delivery confirmation depends on provider capabilities:
- Enterprise providers (e.g. AWS SES, SendGrid, Postmark) provide asynchronous delivery webhooks when the remote MX accepts the message.
- Standard SMTP relays or personal API connections (e.g. Gmail API without DSN) do not provide explicit delivery webhooks after dispatch.

To support tracking across heterogeneous providers, the system implements an **Inferred Delivery Semantic**:
> When an email is in `SENT` status (dispatched), receipt of an authenticated `OPENED` or `CLICKED` event serves as an *inferred delivery signal*, promoting the delivery status from `SENT` to `DELIVERED`.

### Critical Rule: Inferred Delivery is Heuristic and Subordinate to Transport Truth
An open or click is **NOT** unquestionable proof of provider delivery:
1. **Automated Security Gateways**: Enterprise firewalls and spam filters (Proofpoint, Barracuda, Microsoft Defender, Mimecast) regularly pre-fetch images and test links *before* message delivery or during quarantine.
2. **Apple Mail Privacy Protection (MPP)**: Apple proxy servers automatically download remote images in the background regardless of user action.

Therefore, the system enforces the following non-negotiable invariants:
- **Terminal Failure Immunity**: If a delivery or recipient is already marked `BOUNCED` or `FAILED`, subsequent open or click events are recorded in `EmailEvent` for historical auditability, but **MUST NEVER** mutate the delivery status to `DELIVERED`.
- **Bounce Precedence in Analytics**: In campaign and dashboard analytics, transport failure (`BOUNCED`, `FAILED`) takes absolute priority over engagement. Even if a bot triggered an open pixel on a bounced message, the recipient is counted as `BOUNCED` and **NEVER** as `DELIVERED`.
- **Delivered Count Reconciliation**: Analytics will never artificially inflate delivered counts or mask bounce rates due to scanner opens.

---

## 3. Historical Event Preservation

Delivery state changes are monotonic, but event history is **immutable**:
- Every interaction (`OPENED`, `CLICKED`, `BOUNCED`, `COMPLAINT`, `DELIVERED`) is recorded in the `EmailEvent` table as an append-only audit ledger.
- Each event preserves:
  - Timestamp (`occurredAt`, `createdAt`, `processedAt`)
  - Recipient normalized email address
  - Provider event ID / deduplication token
  - Client IP and User Agent headers
  - Full raw payload JSON
- If a delivery state changes (e.g. `SENT` -> `DELIVERED`), previous transport and engagement events remain fully preserved in PostgreSQL.

---

## 4. Authoritative Metric Definitions

Both Campaign Analytics (`EmailAnalyticsService.getCampaignAnalytics`) and Tenant Dashboard Analytics (`EmailAnalyticsService.getTenantAnalytics`) adhere to identical metric definitions:

### Count Metrics
- **Total Sent (`sent`)**: Total unique recipients (or deliveries) that were dispatched to the MTA/provider (`SENT`, `DELIVERED`, `BOUNCED`, `COMPLAINED`, `FAILED`). Excludes messages still pending in `QUEUED` or `PROCESSING`.
- **Delivered (`delivered`)**: Total recipients whose message was successfully received in the destination inbox without bouncing or failing. Includes messages that were delivered and subsequently generated a complaint.
- **Failed (`failed`)**: Total recipients whose delivery failed prior to transmission or due to fatal transport failure.
- **Bounced (`bounced`)**: Total recipients whose delivery was rejected by the destination MX (Hard or Soft Bounce).
- **Complaints (`complaints`)**: Total recipients who submitted a spam or abuse complaint.
- **Unsubscribed (`unsubscribed`)**: Total recipients who opted out of communications.
- **Unique Opens (`uniqueOpens`)**: Distinct recipients who opened at least once.
- **Unique Clicks (`uniqueClicks`)**: Distinct recipients who clicked at least one link.
- **Total Opens (`totalOpens`)**: Raw cumulative count of all open pixel requests.
- **Total Clicks (`totalClicks`)**: Raw cumulative count of all link click requests.

### Percentage Rates & Safeguards
All rates are calculated via the shared `computeAuthoritativeRates(metrics)` utility:

$$\text{Delivery Rate} = \frac{\text{delivered}}{\text{sent}} \times 100$$

$$\text{Bounce Rate} = \frac{\text{bounced}}{\text{sent}} \times 100$$

$$\text{Open Rate} = \frac{\text{uniqueOpens}}{\max(\text{delivered}, \text{sent})} \times 100$$

$$\text{Click Rate} = \frac{\text{uniqueClicks}}{\max(\text{delivered}, \text{sent})} \times 100$$

$$\text{Complaint Rate} = \frac{\text{complaints}}{\max(\text{delivered}, \text{sent})} \times 100$$

$$\text{Unsubscribe Rate} = \frac{\text{unsubscribed}}{\max(\text{delivered}, \text{sent})} \times 100$$

### Mathematical Safeguards
1. **Division by Zero Protection**: If denominator $\le 0$, the rate returns `0.0`.
2. **Impossible Percentage Clamping**: All rates are strictly clamped:
   $$\text{Rate} = \min(100.0, \max(0.0, \text{Rate}))$$
   This prevents rates $> 100\%$ if external scanner opens exceed confirmed delivery receipts.
3. **NaN / Infinity Defense**: Non-finite numbers are filtered before computation.
4. **Precision**: All percentages are rounded to 2 decimal places.

---

## 5. Inflation & Multi-Tenant Defenses

- **Duplicate Event Inflation**: `uniqueOpens` and `uniqueClicks` evaluate unique recipients. Multiple clicks on multiple links by the same recipient count as 1 unique click.
- **Duplicate Recipient Inflation**: If retries occur for a recipient, the recipient is evaluated as a single unit in campaign analytics based on terminal outcome.
- **Cross-Tenant Aggregation**: Every database query explicitly filters by `clientId`. Queries for another tenant's campaign ID return `404 Not Found`.

---

## 6. Documented Technical Limitations

All open and click analytics are subject to known internet and email protocol limitations:

### 1. Apple Mail Privacy Protection (MPP)
- **Impact**: Since iOS 15, iPadOS 15, and macOS Monterey, Apple Mail automatically routes remote content through proxy servers (Cloudflare / Akamai) and pre-fetches images in the background upon receipt.
- **Consequence**: Generates false-positive opens even if the recipient never read the email. Masks recipient IP address, geographic location, and device details. Open rates for Apple Mail users are inflated.

### 2. Image Caching & Proxy Servers
- **Impact**: Major webmail providers (Google Gmail Image Proxy, Yahoo Mail) download tracking pixels once and cache them on their edge servers.
- **Consequence**: Subsequent opens by the user from the same webmail interface may load the image directly from the provider's proxy cache without contacting our server, causing total opens to be under-counted.

### 3. Automated Bot & Security Scanners
- **Impact**: Enterprise mail filters (Microsoft Defender for Office 365, Proofpoint, Barracuda, Mimecast) inspect incoming messages for malicious payloads and phishing links. They execute automated HTTP GET requests on embedded images and hyperlinks before delivering to the user.
- **Consequence**: Can generate instant opens and clicks seconds after dispatch. If the scanner subsequently rejects the message, our system records the terminal `BOUNCED` status and overrides any inferred delivery.

### 4. Blocked Remote Images
- **Impact**: Privacy-conscious email clients (Thunderbird, Outlook desktop default settings) disable remote images by default unless the recipient clicks "Download pictures" or adds the sender to their safe senders list.
- **Consequence**: If a recipient reads the email without enabling images and does not click any links, the open event cannot be recorded (false negative).
