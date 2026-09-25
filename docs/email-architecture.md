# Email Infrastructure & Architecture Guide

This document details the architectural foundation, data models, worker topology, provider abstraction, security enforcement, and lifecycle of the Email system.

---

## 1. High-Level Architecture

The Email platform is designed as an enterprise-grade multi-tenant messaging infrastructure capable of handling high-volume promotional campaigns as well as latency-sensitive transactional communications (OTPs, password resets, verification links, and billing alerts).

```
 ┌──────────────────────┐         ┌───────────────────────────┐
 │ External API Clients │         │   Admin Dashboard UI      │
 │ (POST /api/v1/email) │         │ (/dashboard/email/*)      │
 └──────────┬───────────┘         └─────────────┬─────────────┘
            │                                   │
            ▼                                   ▼
 ┌────────────────────────────────────────────────────────────┐
 │                  Next.js App / API Layer                   │
 │                                                            │
 │  * ApiKey / RBAC Authentication & Tenant Resolution        │
 │  * Explicit Type Validation (TRANSACTIONAL vs PROMOTIONAL) │
 │  * Suppression & Consent Gatekeeping                       │
 │  * Rate Limiting (Sliding Window)                          │
 │  * Security Audit Logging with Secret Redaction            │
 └──────────────────────────────┬─────────────────────────────┘
                                │
                                ▼ Enqueue
 ┌────────────────────────────────────────────────────────────┐
 │               Redis BullMQ Queue Infrastructure            │
 │                                                            │
 │  * email-deliveries: Single dispatches & delivery attempts │
 │  * email-campaigns: Scheduled batches & fan-out jobs       │
 └──────────────────────────────┬─────────────────────────────┘
                                │
                                ▼ Dequeue & Process
 ┌────────────────────────────────────────────────────────────┐
 │               Dedicated BullMQ Email Worker                │
 │                  (`npm run worker:email`)                  │
 │                                                            │
 │  * Audience Resolution (Lists + Segments)                  │
 │  * Deduplication & Suppression Filtering                   │
 │  * Safe Template Rendering (Variable substitution)         │
 │  * Provider Abstraction (Gmail, SMTP, etc.)                │
 │  * RFC 8058 One-Click Unsubscribe Headers                  │
 │  * Automatic Retry & Backoff for Transient Failures        │
 └──────────────────────────────┬─────────────────────────────┘
                                │
                                ▼ HTTPS / API
 ┌────────────────────────────────────────────────────────────┐
 │                     Email Providers                        │
 │            (Google Workspace / Gmail API)                  │
 └──────────────────────────────┬─────────────────────────────┘
                                │
                                ▼ Webhook Delivery Feedback
 ┌────────────────────────────────────────────────────────────┐
 │         Provider Webhook Ingestion & Normalization         │
 │             (/api/email/webhooks/:provider)                │
 │                                                            │
 │  * Timing-safe Signature Verification                      │
 │  * Event Deduplication (Idempotency)                       │
 │  * Delivery State Updates (Delivered, Bounced, Complained) │
 │  * Automated Suppression on Hard Bounces & Complaints      │
 └────────────────────────────────────────────────────────────┘
```

---

## 2. Provider Abstraction Layer

All outbound email transmission is isolated behind the normalized `EmailProvider` interface:

```typescript
export interface EmailProvider {
  readonly name: string;
  send(options: EmailSendOptions): Promise<EmailSendResult>;
  verifyConnection(): Promise<ProviderHealthResult>;
}
```

### Gmail / Google Workspace Provider
- **Authentication**: OAuth 2.0 with offline access tokens and refresh tokens.
- **Security**: Tokens are stored AES-256-GCM encrypted in the database.
- **Protocol**: Transmits raw RFC 2822 MIME messages formatted in base64url via the Gmail REST API (`POST https://gmail.googleapis.com/gmail/v1/users/me/messages/send`).
- **Token Lifecycle**: Automatically checks token expiry and performs silent refresh using Google's token endpoint before dispatching.

---

## 3. Asynchronous BullMQ Queue Architecture

The email platform uses dedicated Redis-backed queues:

| Queue Name | Purpose | Concurrency | Retry Strategy |
|---|---|---|---|
| `email-deliveries` | Latency-critical transactional sends and campaign batch chunks | 5 | Exponential backoff (3 attempts: 2s, 10s, 30s) |
| `email-campaigns` | Campaign scheduling, audience fan-out, and dispatch coordination | 2 | Exponential backoff (3 attempts) |

### Key Queue Invariants:
1. **Idempotency**: All jobs use deterministic IDs (e.g., `delivery_{deliveryId}` or `campaign_{campaignId}_{timestamp}`). Duplicate jobs are rejected by Redis.
2. **Permanent Error Protection**: Unrecoverable errors (e.g. invalid recipient syntax, recipient suppressed, unauthorized credentials) are flagged immediately and never retried endlessly.
3. **No Serverless Workers**: Workers run as persistent Node.js daemons (`npm run worker:email`), never as Netlify serverless functions.

---

## 4. Audience Management & Safe Segmentation

### Email Contacts
- Contacts are strictly scoped to a tenant (`clientId`).
- Emails are normalized via `normalizeEmail()` (lowercased, trimmed, dot-normalized for Gmail).
- Separate consent tracking: `emailVerified` (identity verified) is decoupled from `hasMarketingConsent` (explicit opt-in to marketing).

### Email Lists & Memberships
- Support static groups (e.g. "Newsletter Subscribers", "VIP Customers").
- Enforces composite unique constraints (`listId_contactId`) preventing duplicate memberships.

### Safe Dynamic Segments
- Filter criteria are stored as structured JSON objects:
  ```json
  {
    "conditions": [
      { "field": "status", "operator": "EQUALS", "value": "SUBSCRIBED" },
      { "field": "tags", "operator": "CONTAINS", "value": "vip" }
    ],
    "matchType": "ALL"
  }
  ```
- **Zero Raw SQL**: Segments are translated into parameterized Prisma queries. Arbitrary SQL injection is architecturally impossible.

---

## 5. Campaign Lifecycle & Scheduling

1. **Drafting**: Campaigns are created in `DRAFT` state with an audience target (list or segment) and an immutable template version.
2. **Scheduling**: Transitioned to `SCHEDULED` with a UTC dispatch timestamp.
3. **Audience Resolution**: The worker resolves eligible recipients:
   - Evaluates list or segment memberships.
   - Filters out duplicates.
   - Evaluates suppression records for the tenant.
   - Evaluates marketing consent (for promotional campaigns).
4. **Execution**: Chunks recipients into delivery batches and enqueues individual deliveries into `email-deliveries`.
5. **Completion**: Updates aggregate metrics (`sentCount`, `deliveredCount`, `bouncedCount`, etc.).

---

## 6. Suppression & Unsubscribe Compliance

### RFC 8058 One-Click Unsubscribe
All promotional emails automatically inject mandatory compliance headers:
```http
List-Unsubscribe: <https://hub.yourdomain.com/api/email/unsubscribe?token=...>, <mailto:unsubscribe@domain.com?subject=unsubscribe>
List-Unsubscribe-Post: List-Unsubscribe=One-Click
```

### Suppression Reasons
Addresses can be suppressed per tenant for:
- `HARD_BOUNCE`: Mailbox does not exist or permanently rejected.
- `COMPLAINT`: Recipient marked email as spam.
- `UNSUBSCRIBE`: Recipient opted out via link or header.
- `MANUAL`: Administrator manually suppressed address.

---

## 7. Webhook Ingestion & Deduplication

Inbound webhooks (`/api/email/webhooks/:provider`) process provider delivery feedback:
1. **Signature Verification**: Validates HMAC or provider signature before processing payload.
2. **Deduplication**: Ingests provider event ID against `EmailEvent` unique constraint (`provider_eventId`). Duplicate webhook dispatches return HTTP 200 immediately without reprocessing.
3. **Metric Updates**: Automatically recalculates delivery status and increments campaign analytics counters.
4. **Automatic Suppression**: If event is a hard bounce or spam complaint, recipient is added to `EmailSuppression` table immediately.

---

## 8. Multi-Tenant Isolation (9-Domain Invariant)

Every query and mutation strictly enforces the tenant boundary (`clientId`):
1. **Contacts**: Tenant B cannot view or modify Tenant A's contacts.
2. **Lists**: Tenant B cannot view or modify Tenant A's lists.
3. **Segments**: Tenant B cannot view or modify Tenant A's segments.
4. **Templates**: Tenant B cannot view or modify Tenant A's templates or versions.
5. **Campaigns**: Tenant B cannot view or modify Tenant A's campaigns.
6. **Deliveries**: Tenant B cannot view or modify Tenant A's delivery logs.
7. **Providers**: Tenant B cannot view or modify Tenant A's provider credentials.
8. **Sender Identities**: Tenant B cannot view or modify Tenant A's sender configurations.
9. **Suppressions**: Tenant B cannot view or modify Tenant A's suppression lists.

---

## 9. Security Matrix (RBAC) & Audit Logging

| Feature / Action | ADMIN Role | VIEWER Role | API Key |
|---|---|---|---|
| View Dashboard & Metrics | Allowed | Allowed | N/A |
| View Templates & Contacts | Allowed | Allowed | N/A |
| Create / Edit / Archive Templates | Allowed | 403 Forbidden | N/A |
| Create / Import / Edit Contacts | Allowed | 403 Forbidden | N/A |
| Create / Schedule / Cancel Campaigns | Allowed | 403 Forbidden | N/A |
| Connect / Revoke Providers | Allowed | 403 Forbidden | N/A |
| Manage Suppression Records | Allowed | 403 Forbidden | N/A |
| Dispatch Email via Public API | N/A | N/A | Allowed (Scoped to Tenant) |

### Audit Logging
All high-impact admin operations (`PROVIDER_CONNECTED`, `SENDER_CHANGED`, `CAMPAIGN_SCHEDULED`, `CAMPAIGN_CANCELLED`, `SUPPRESSION_MANUALLY_ADDED`) are recorded via `EmailAuditLogger`. Sensitive keys (`refreshToken`, `accessToken`, `clientSecret`, `apiKey`, `password`) are automatically redacted with `[REDACTED]` prior to logging.
