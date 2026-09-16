# Webhooks Architecture & Durable Outgoing Dispatcher

This service provides a bi-directional, multi-tenant webhook architecture:
1. **Inbound Webhook Receiver (`/api/webhooks/whatsapp`)**: Receives, validates signatures, and deduplicates real-time events from Meta.
2. **Durable Outgoing Webhook Dispatcher**: Delivers signed events to registered subscriber endpoints with PostgreSQL-backed atomic queueing, retry scheduling, and SSRF protection.

---

## 1. Inbound Meta Webhook Receiver (`/api/webhooks/whatsapp`)

Meta sends two kinds of HTTP requests to your webhook endpoint:

### A. Verification Handshake (`GET`)
When configuring your webhook in Meta Developer Console, Meta sends a `GET` request with:
- `hub.mode=subscribe`
- `hub.verify_token`: Your configured verification secret
- `hub.challenge`: A random string

The server validates that `hub.verify_token === META_WEBHOOK_VERIFY_TOKEN` and echoes the `hub.challenge` string with HTTP 200.

### B. Event Notification (`POST`)
When an event occurs (e.g. user sends a message, or a message changes state to `delivered`), Meta posts a JSON payload.

#### Cryptographic Security (`X-Hub-Signature-256`)
- Meta signs every request body using HMAC-SHA256 with your `META_APP_SECRET`.
- The signature is passed in the header:
  ```http
  X-Hub-Signature-256: sha256=<hex_digest>
  ```
- The service performs a timing-safe digest comparison (`crypto.timingSafeEqual`) to prevent timing attack vulnerabilities. If the signature does not match, the request is rejected with HTTP 401 Unauthorized.

#### Concurrency & Deduplication Races
- Inbound webhook events are deduplicated via unique constraint on `MessageEvent.providerEventId`.
- Under high concurrency, duplicate events caught by the constraint are safely handled as idempotent successes (returning HTTP 200) without creating duplicate messages.

#### State Machine & Status Progression
- Status hierarchy enforces monotonic progression: `QUEUED` (0) < `SENT` (1) < `DELIVERED` (2) < `READ` (3).
- **Downgrade Protection**: Out-of-order events (e.g. a delayed `sent` event arriving after `delivered`) cannot downgrade message status.
- **Terminal State Protection**: Once marked `READ` or `FAILED`, messages cannot be overwritten by out-of-order events.
- **OTP Delivery Consistency**: If a delivery webhook reports `failed` for an OTP message, any pending `OtpVerification` for that destination is marked `FAILED` immediately.

---

## 2. Durable Outgoing Webhook Dispatcher & Queue Worker

When messaging events occur inside the service, the dispatcher forwards them to all matching registered webhook endpoints.

### Durable Delivery Guarantee
In serverless environments, fire-and-forget in-memory retries can be killed when requests terminate. To guarantee delivery durability:
1. **Durable DB Write**: A `WebhookDelivery` record is committed with `status: PENDING` and `nextAttemptAt: NOW()` **before** responding or attempting delivery.
2. **Immediate Attempt**: The system executes an immediate delivery attempt for low-latency delivery.
3. **Database-Backed Retry Scheduling**: If delivery fails transiently (5xx error or network timeout), the record remains in `PENDING` state with `nextAttemptAt = NOW() + backoff` (exponential backoff with jitter). Non-retryable errors (4xx client errors, SSRF violations) immediately transition to `FAILED`.
4. **Atomic Job Claiming (`FOR UPDATE SKIP LOCKED`)**: Worker jobs claim eligible deliveries using PostgreSQL row-level locks without duplicate processing:
   ```sql
   UPDATE "WebhookDelivery" SET "status" = 'PROCESSING', "lockedAt" = NOW()
   WHERE id IN (
     SELECT id FROM "WebhookDelivery"
     WHERE "status" = 'PENDING' AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= NOW())
     ORDER BY "createdAt" ASC LIMIT 10
     FOR UPDATE SKIP LOCKED
   );
   ```
5. **Worker Endpoint**: `POST /api/admin/webhooks/process-queue` can be invoked periodically via Netlify scheduled functions, GitHub Actions cron, or monitoring jobs.

### Endpoints & Secret Security
- Endpoints are scoped to the authenticated `ApiClient`.
- Webhook secrets are encrypted at rest using AES-256-GCM (`WEBHOOK_SECRET_ENCRYPTION_KEY`).
- Secrets are revealed only once upon creation or regeneration (`POST /api/admin/webhooks/:id/regenerate-secret`).

### Subscribable Events Catalog
- `*`: All events
- `message.received`: When an inbound message arrives from a user
- `message.sent`: When an outbound message is accepted by Meta
- `message.delivered`: When a message is delivered to the recipient device
- `message.read`: When a message is read by the recipient
- `message.failed`: When delivery fails or is rejected
- `otp.requested`: When an OTP is generated
- `otp.verified`: When an OTP is successfully validated
- `test.event`: Ping / verification event

### Event Idempotency & Delivery Traceability
- Every logical event receives a collision-resistant UUID: `evt_${randomUUID()}`.
- Multiple retries of a delivery maintain the identical `eventId`, allowing subscribers to deduplicate reliably.
- `WebhookDelivery.messageEventId` maintains a direct foreign key to the originating `MessageEvent` for end-to-end auditability.

### SSRF Protection & Response Sanitization
- Webhook URLs are strictly validated to prevent SSRF against loopback, RFC 1918 private networks, AWS/GCP/Azure cloud metadata (`169.254.169.254`), and Carrier-Grade NAT.
- Response bodies are capped to 1000 characters.
- HTML error pages are cleanly summarized to title headers instead of storing raw HTML in the database.
- Authorization tokens, secrets, and passwords in downstream responses are automatically redacted before storage.
