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
 │  * Provider Abstraction (Google Workspace / Gmail API)     │
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

## 2. Provider Abstraction Layer & Near-Term Strategy

All outbound email transmission is isolated behind the normalized `EmailProvider` interface:

```typescript
export interface EmailProvider {
  readonly id: string;
  readonly name: string;
  readonly providerType: EmailProviderType;

  send(request: EmailSendRequest): Promise<EmailSendResult>;
  verifyCredentials?(): Promise<{ valid: boolean; error?: string }>;
  checkHealth?(): Promise<EmailProviderHealthResult>;
}
```

### Production Strategy: Gmail-Only
Based on an architectural audit of operational adapters, the production email infrastructure is standardized strictly on **Google Workspace / Gmail API via OAuth 2.0**:

1. **Google Workspace / Gmail (Supported & Active)**:
   - **Authentication**: OAuth 2.0 with offline access tokens and refresh tokens.
   - **Scope**: Narrowest practical sending permission (`https://www.googleapis.com/auth/gmail.send`).
   - **Security**: Tokens are stored AES-256-GCM encrypted in the database. Tokens and secrets are never logged.
   - **Protocol**: Transmits raw RFC 2822 MIME messages formatted in base64url via the Gmail REST API (`POST https://gmail.googleapis.com/gmail/v1/users/me/messages/send`).
   - **Token Lifecycle**: Automatically checks token expiry and performs silent refresh using Google's token endpoint before dispatching.
   - **Health Verification**: Built-in `checkHealth()` verifies token acquisition against Google OAuth token endpoint and reports round-trip latency.

2. **Amazon SES & Generic SMTP (Explicitly Unavailable)**:
   - Operational sending adapters for SES and SMTP are not implemented.
   - Creating or requesting SES or SMTP provider configurations via API returns HTTP 400 (`PROVIDER_UNAVAILABLE`).
   - The provider registry throws `ProviderUnavailableError` if SES or SMTP is requested.
   - Dashboards display SES and SMTP as unavailable roadmap items to remove misleading claims of operational support.

3. **MOCK Provider (Strictly Test-Only)**:
   - Restricted exclusively to automated test suites (`NODE_ENV !== "production"`).
   - Attempting to configure, register, or resolve the MOCK provider in production throws `MockProviderForbiddenError` and returns HTTP 400 (`MOCK_PROVIDER_FORBIDDEN`).

4. **Zero Silent Fallback**:
   - The system prohibits silent fallback from one provider to another.
   - If an explicit `providerConfigId` is requested, the system resolves only that configuration; if inactive or missing, it fails explicitly with `ProviderNotFoundError`.
   - When resolving the tenant default provider, if multiple active providers exist and none is marked `isDefault: true`, resolution fails explicitly with `ProviderAmbiguityError` rather than arbitrarily picking one.
   - Provider delivery failures are classified and surfaced honestly—never silently rerouted.

---

## 3. Asynchronous BullMQ Queue Architecture

The email platform uses dedicated Redis-backed queues partitioned by delivery profile:

| Queue Name | Purpose | Concurrency | Retry Strategy |
|---|---|---|---|
| `email-transactional` | Latency-critical transactional sends (OTPs, notifications, password resets) | 5 | Exponential backoff (3 attempts: 2s, 10s, 30s) |
| `email-campaign` | Promotional single sends and campaign recipient jobs | 5 | Exponential backoff (3 attempts: 2s, 10s, 30s) |
| `email-events` | Webhook delivery feedback processing (delivered, bounced, complained) | 3 | Exponential backoff (3 attempts) |

### Key Queue Invariants:
1. **Idempotency & Business Keys**: All jobs use deterministic IDs (e.g., `email-transactional-{deliveryId}`, `email-promotional-{deliveryId}`, `email-campaign-{recipientId}`). Redis strictly rejects duplicate active jobs.
2. **Permanent Error Protection**: Unrecoverable errors (e.g. invalid recipient syntax, recipient suppressed, unauthorized credentials) throw `UnrecoverableError` / `PermanentEmailError` immediately and are never retried.
3. **Transient Failure Handling**: Network timeouts, 429 rate limits, and 503 service unavailabilities throw `RetryableEmailError`, triggering automatic BullMQ backoff retry.
4. **Honest Queue Reporting**: If Redis is unreachable during send or schedule operations, the API returns HTTP 500 (`QUEUE_ERROR`) and records `EmailDelivery` as `FAILED` (`QUEUE_ENQUEUE_FAILED`). The API never falsely claims a job was queued.
5. **No Serverless Workers**: Workers run as persistent Node.js daemons (`npm run worker:email`), never as serverless functions.

---

## 4. Scalable Audience Management & Resolution Engine

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
- **Zero Raw SQL**: Segments are validated against an explicit allowlist of fields (`email`, `status`, `firstName`, `lastName`, `tags`, `attributes.*`) and operators (`equals`, `contains`, `starts_with`, `ends_with`, `greater_than`, `less_than`, `is_empty`, etc.). Arbitrary SQL injection is architecturally impossible.

### High-Performance Audience Resolution (`EmailAudienceResolver`)
1. **Parameterized Prisma Query Pushdown**: Directly filterable conditions on top-level contact fields (`status`, `email`, `firstName`, `lastName`) are compiled directly into parameterized PostgreSQL `WHERE` clauses.
2. **Streaming Keyset Cursor Pagination**: Evaluates candidates in bounded batches (`DEFAULT_BATCH_SIZE = 500`) using keyset pagination (`id > cursorId ORDER BY id ASC`). Memory consumption remains constant $O(1)$ regardless of whether the audience contains 100 or 100,000 contacts.
3. **Transaction-Level Advisory Locks**: During campaign launch or scheduled trigger, snapshot creation acquires a PostgreSQL advisory lock:
   ```sql
   SELECT pg_advisory_xact_lock(hashtext('campaign_snapshot_' || campaignId));
   ```
   This prevents concurrent execution or multiple workers from creating duplicate snapshot recipient rows.
4. **Frozen Metadata Snapshots**: At the moment a campaign launches, recipient attributes (`firstName`, `lastName`, metadata attributes) are serialized into `EmailCampaignRecipient.metadataSnapshot`. Subsequent mutations to contact records never alter what was sent in historical campaigns.
5. **Exact Preview Matching**: The preview endpoint (`GET /api/email/campaigns/preview` or `/api/email/campaigns/[id]/preview`) uses the exact same streaming resolution logic, guaranteeing that preview counts (`totalCandidates`, `suppressedCount`, `unsubscribedCount`, `eligibleRecipients`) match the persisted snapshot rows 1:1.

---

## 5. Campaign Lifecycle & State Machine

Campaigns progress through a deterministic, strictly guarded state machine:

```
[DRAFT] ───► [SCHEDULED] ───► [RUNNING] ───► [COMPLETED]
   │                             │   ▲
   │                             ▼   │
   ├─────────────────────────► [PAUSED]
   ▼
[CANCELLED]
```

### Lifecycle Operations:
- **Scheduling**: Campaign status transitions to `SCHEDULED`. BullMQ delayed trigger job is enqueued to `email-campaign` queue. If executed prematurely, worker throws a retryable error until `scheduledAt` has arrived.
- **Launch / Fan-Out**: When due or triggered via "Send Now", the trigger worker acquires the advisory lock, snapshots eligible recipients, and transitions status to `RUNNING`. Each recipient is enqueued with a deterministic job ID (`email-campaign-{recipientId}`).
- **Pause (`POST /pause`)**: Transitions campaign to `PAUSED`. If recipient jobs arrive at the worker while paused, the worker skips execution and leaves the recipient in `PENDING` status.
- **Resume (`POST /resume`)**: Transitions campaign back to `RUNNING` and requeues any unsent `PENDING` recipients. Already `SENT` recipients are skipped to guarantee zero duplicate sends.
- **Cancel (`POST /cancel`)**: Transitions campaign to `CANCELLED`. Any delayed trigger jobs in BullMQ are removed. All unexecuted `PENDING` snapshot recipients are transitioned to `CANCELLED`. Already transmitted `SENT` emails remain acknowledged and immutable.
- **Deterministic Auto-Completion**: Whenever a recipient finishes execution (`SENT`, `FAILED`, `SUPPRESSED`, or `CANCELLED`), `checkAndCompleteCampaign` checks if active recipients remain. When zero remain, campaign atomically transitions to `COMPLETED`.

---

## 6. Suppression & Tracking Pipeline

### RFC 8058 One-Click Unsubscribe
All promotional emails automatically inject mandatory compliance headers:
```http
List-Unsubscribe: <https://hub.yourdomain.com/api/email/unsubscribe/{token}>
List-Unsubscribe-Post: List-Unsubscribe=One-Click
```
Submitting `POST /api/email/unsubscribe/{token}`:
1. Validates the time-bound HMAC token.
2. Updates `EmailContact.status` to `UNSUBSCRIBED` and revokes `hasMarketingConsent = false`.
3. Creates a tenant-level `EmailSuppression` record (`reason = UNSUBSCRIBE`).
4. Rejects all future promotional sends to that address across the tenant.

### Privacy-Preserving Open & Click Tracking
- **Open Tracking (`GET /api/email/track/open/{token}`)**: Serves a transparent 1x1 GIF with `Cache-Control: no-store, no-cache`. Records an authoritative `EmailEvent` (`OPENED`) without exposing recipient emails in tracking URLs.
- **Click Tracking (`GET /api/email/track/click/{token}`)**: Verifies the HMAC-signed token, strictly validates destination protocol (`http:` / `https:`), logs `EmailEvent` (`CLICKED`), and redirects via HTTP 302. Malicious schemes (e.g., `javascript:`) are strictly blocked.

---

## 7. Webhook Ingestion & Monotonic State Machine

Inbound webhooks (`POST /api/email/webhooks/:provider`) process delivery telemetry:
1. **Mandatory Provider Binding**: Webhooks must include `?configId=...` or `X-Provider-Config-Id` header matching an active `EmailProviderConfig`.
2. **Cryptographic Verification**: Validates HMAC-SHA256 signature (`X-Webhook-Signature`) using the tenant's configured webhook secret.
3. **Two-Step Asynchronous Ingestion**:
   - Webhook endpoint persists raw event with status `RECEIVED` and enqueues to `email-events` queue.
   - Worker loads event, correlates delivery, and applies state machine transitions.
4. **Monotonic State Machine**:
   - `SENT` -> `DELIVERED`: Allowed.
   - `DELIVERED` -> `SENT`: Blocked (stale out-of-order rejection).
   - `DELIVERED` -> `BOUNCED` / `FAILED`: Blocked (terminal delivered state cannot be overwritten).
   - `DELIVERED` -> `COMPLAINED`: Allowed (spam complaint after receipt).
   - Duplicate events: Idempotently skipped without metric double-counting.
5. **Automated Suppression**: Hard bounces and spam complaints automatically create `EmailSuppression` records.

---

## 8. Multi-Tenant Isolation (13-Domain Invariant)

Every database query, API route, queue job, and worker operation strictly scopes data by `clientId`:
1. **Providers**: Tenant B cannot view or use Tenant A's provider configurations.
2. **Sender Identities**: Sender addresses and identities cannot be linked across tenants.
3. **Contacts**: Tenant B cannot view, query, or mutate Tenant A's contacts.
4. **Lists**: Static lists and memberships are strictly isolated.
5. **Segments**: Dynamic segments and criteria evaluation only touch tenant contacts.
6. **Templates**: Templates and template versions are strictly tenant-scoped.
7. **Campaigns**: Campaign configurations and draft states are invisible to other tenants.
8. **Campaign Recipients**: Recipient snapshot rows and statuses cannot be accessed across tenants.
9. **Deliveries**: `EmailDelivery` logs and statuses are strictly scoped.
10. **Events**: `EmailEvent` records and telemetry cannot cross tenant boundaries.
11. **Suppressions**: Suppressions for Tenant A never suppress Tenant B recipients.
12. **Webhook Correlation**: Webhook events cannot correlate deliveries across different tenants.
13. **Analytics**: Aggregate delivery and campaign metrics throw errors / return 0 for foreign tenants.

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
