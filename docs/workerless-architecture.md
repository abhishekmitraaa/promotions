# Workerless Communication & Campaign Architecture

## 1. Executive Summary

This document specifies the architectural migration from a persistent Node.js worker (BullMQ + Redis) to a **durable, workerless serverless execution engine** running on:
- **Vercel**: Next.js 15 Serverless Functions (APIs, webhooks, immediate dispatches, short-lived processing endpoint).
- **Supabase PostgreSQL 17**: Authoritative delivery state, campaign lifecycle, automation journeys, and concurrency locking via `FOR UPDATE SKIP LOCKED`.
- **Supabase Cron (`pg_cron` 1.6.4)**: Scheduled heartbeat executing every minute (`* * * * *`).
- **Supabase `pg_net` (0.20.4)**: Asynchronous non-blocking HTTP invocation dispatching to Vercel's internal processing endpoint.
- **Gmail / Google Workspace**: Authoritative email provider with OAuth2 refresh token rotation.
- **Meta WhatsApp Cloud API**: Authoritative WhatsApp provider.

**Crucial Invariant**: The final production system requires **zero persistent Node.js worker processes**, zero Redis clusters in production, zero `setInterval`/`setTimeout` infinite loops, and zero long-running background containers.

---

## 2. Architecture Comparison

### Before: Persistent Daemon Architecture
```
┌────────────┐       ┌───────────┐       ┌──────────┐       ┌──────────────────────┐
│   Vercel   │ ----> │   Redis   │ ----> │  BullMQ  │ ----> │  Persistent Node.js   │
│   APIs     │       │ (External)│       │  Queues  │       │     Worker Daemon    │
└────────────┘       └───────────┘       └──────────┘       │ (workers/email-worker)│
                                                            └──────────┬───────────┘
                                                                       │
                                                            ┌──────────┼───────────┐
                                                            ↓          ↓           ↓
                                                          Gmail    Campaigns  Automations
```
*Downsides*:
- Required a 24/7 VM, ECS container, or PM2 process to run `workers/email-worker.ts`.
- Fragile coupling to external Redis availability.
- Multi-instance deployment challenges and idle compute costs.

---

### After: Durable Workerless Architecture
```
                    ┌─────────────────────────┐
                    │         Vercel          │
                    │                         │
                    │ Next.js APIs            │
                    │ Webhooks                │
                    │ Admin Dashboard         │
                    │ Immediate Sends         │
                    └────────────┬────────────┘
                                 │
                                 ↓
                    ┌─────────────────────────┐
                    │        Supabase         │
                    │       PostgreSQL        │
                    │                         │
                    │ Delivery state          │
                    │ Campaign state          │
                    │ Automation journeys     │
                    │ Concurrency locking     │
                    └────────────┬────────────┘
                                 │
                           Supabase Cron (pg_cron)
                                 │
                              pg_net
                                 │
                                 ↓
                    ┌─────────────────────────┐
                    │  Vercel Job Processor   │
                    │  (/api/internal/        │
                    │   process-jobs)         │
                    │  short-lived serverless │
                    └────────────┬────────────┘
                                 │
                    ┌────────────┼────────────┐
                    ↓            ↓            ↓
                  Gmail      Campaigns   Automations
```

---

## 3. Core Components

### 3.1. Durable Database State (PostgreSQL)
All asynchronous jobs are represented as durable records in PostgreSQL:

| Job Type | Model | Pending Status | Active/Running Status | Terminal Statuses |
|---|---|---|---|---|
| Transactional Emails | `EmailDelivery` | `QUEUED` | `PROCESSING` | `SENT`, `FAILED` |
| Scheduled Campaigns | `EmailCampaign` | `SCHEDULED` (`scheduledAt <= NOW()`) | `RUNNING` | `COMPLETED`, `FAILED`, `CANCELLED` |
| Campaign Recipients | `EmailCampaignRecipient` | `PENDING` | `PROCESSING` | `SENT`, `FAILED`, `SUPPRESSED`, `CANCELLED` |
| Recurring Automations | `EmailAutomation` | `ACTIVE` (`nextRunAt <= NOW()`) | Active | `PAUSED`, `ARCHIVED` |
| Journey Delayed Steps | `EmailAutomationEnrollment` | `WAITING` (`nextActionAt <= NOW()`) | `ACTIVE` | `COMPLETED`, `ABANDONED`, `FAILED` |
| Step Timeouts | `EmailAutomationEnrollment` | `WAITING` on `WAIT_FOR_EVENT` | `ACTIVE` | `TIMEOUT_BRANCHED`, `TIMEOUT_ABANDONED` |
| Telemetry Events | `EmailEvent` | `RECEIVED` | `PROCESSING` | `PROCESSED`, `FAILED` |
| Outbound Webhooks | `WebhookDelivery` | `PENDING` | `PROCESSING` | `SUCCESS`, `FAILED` |

### 3.2. Concurrency Safety (`FOR UPDATE SKIP LOCKED`)
To prevent race conditions across parallel or overlapping serverless executions, jobs are atomically claimed using PostgreSQL's row-level locking:

```sql
WITH claimed AS (
  SELECT d.id
  FROM "EmailDelivery" d
  WHERE d."status" = 'QUEUED'
    AND (d."nextAttemptAt" IS NULL OR d."nextAttemptAt" <= NOW())
  ORDER BY d."createdAt" ASC
  LIMIT 20
  FOR UPDATE SKIP LOCKED
)
UPDATE "EmailDelivery" d
SET "status" = 'PROCESSING',
    "lastAttemptAt" = NOW(),
    "attemptCount" = d."attemptCount" + 1
FROM claimed c
WHERE d.id = c.id
RETURNING d.id, d."clientId";
```
- Any rows locked by an active transaction are skipped by concurrent invocations.
- Stale `PROCESSING` records are reclaimed after 10 minutes by the reconciliation pass.

### 3.3. Serverless Job Processor (`ServerlessJobProcessor`)
Located at `src/lib/services/serverless-job-processor.ts`:
- Executes bounded batches across all 8 job categories.
- Enforces an execution deadline (default: 25 seconds) to comfortably fit within Vercel's Serverless Function execution limit.
- Reuses domain service logic without duplicated code (`processTransactionalJob`, `processCampaignRecipientJob`, `processScheduledCampaignTriggerJob`, `EmailAutomationService`, `EmailEventService`, `reconcileAbandonedJobs`, `processWebhookDeliveryQueue`).

### 3.4. Supabase Cron & pg_net Dispatcher with Supabase Vault
Configured in PostgreSQL on Supabase project `peqynzeioiauynfpdsdv`:
- **Job 4 (`process-email-jobs`, `* * * * *`)**:
  Retrieves the secret dynamically from Supabase Vault (`internal_processor_secret`) without hardcoding credentials in SQL:
  ```sql
  SELECT net.http_post(
    url := 'https://promotions-lime.vercel.app/api/internal/process-jobs',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'internal_processor_secret' LIMIT 1)
    ),
    body := '{"source":"supabase_cron"}'::jsonb,
    timeout_milliseconds := 30000
  );
  ```
- **Job 5 (`reconcile-email-jobs`, `*/5 * * * *`)**:
  Executes stale lock recovery every 5 minutes:
  ```sql
  SELECT net.http_post(
    url := 'https://promotions-lime.vercel.app/api/internal/process-jobs?reconcile=true',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'internal_processor_secret' LIMIT 1)
    ),
    body := '{"source":"supabase_cron_reconcile"}'::jsonb,
    timeout_milliseconds := 45000
  );
  ```

### 3.5. Internal Processing Endpoint (`/api/internal/process-jobs`)
Located at `src/app/api/internal/process-jobs/route.ts`:
- Rejects `GET` requests with `HTTP 405 Method Not Allowed` to prevent unintended trigger execution.
- Strictly validates `Authorization: Bearer <INTERNAL_PROCESSOR_SECRET>` or `x-processor-secret` using constant-time string comparison (`timingSafeEqualSecret`).
- Fails closed on missing or incorrect credentials (returns HTTP 401/403).
- Returns comprehensive execution reports:
```json
{
  "success": true,
  "data": {
    "success": true,
    "timestamp": "2026-10-10T09:42:27.074Z",
    "durationMs": 31,
    "results": {
      "backgroundJobs": { "claimed": 0, "succeeded": 0, "failed": 0 },
      "webhooks": { "claimed": 0, "succeeded": 0, "failed": 0 },
      "transactional": { "processed": 0, "succeeded": 0, "failed": 0 },
      "scheduledCampaigns": { "processed": 0, "succeeded": 0, "failed": 0 },
      "campaignRecipients": { "processed": 0, "succeeded": 0, "failed": 0 },
      "recurringAutomations": { "processed": 0, "succeeded": 0, "failed": 0 },
      "automationEnrollments": { "processed": 0, "succeeded": 0, "failed": 0 },
      "events": { "processed": 0, "succeeded": 0, "failed": 0 },
      "reconciliation": null
    }
  }
}
```

---

## 4. Authoritative Durable State: Zero Fake Adapters

The system completely eliminates mock queue adapters:
- **Immediate Transactional Messages**: (e.g. OTPs, password reset) are executed immediately without delay.
- **Background Jobs**: (e.g. transactional deliveries, campaign dispatches, journey steps) are persisted atomically as `BackgroundJob` and authoritative entity records (`EmailDelivery`, `EmailCampaignRecipient`) in a single PostgreSQL transaction before the API returns HTTP 202 Accepted.
- **Fair Tenant Dispatch**: Uses PostgreSQL `FOR UPDATE SKIP LOCKED` with partitioned ranking to guarantee fair multi-tenant job processing without starvation.
- **Deadlines**: Bounded batches with a 4-second safety buffer automatically roll back unstarted claims before reaching serverless function timeouts.

---

## 5. Verification & Testing

Run the dedicated test suites:
```bash
# 1. Guard check preventing destructive actions against production Supabase
npm run test:guard

# 2. End-to-end workerless pipeline verification (runs against disposable PostgreSQL)
npm run test:workerless

# 3. Multi-channel communication engine verification
npm run test:communication
```
Tests pass across all 10 verification areas:
1. Workerless mode configuration check
2. Transactional delivery processing & terminal transition
3. Scheduled campaign triggers & audience resolution
4. Campaign recipient batch dispatch
5. Automation step & timeout advancement
6. Email telemetry event processing
7. Authorization & secret validation on `/api/internal/process-jobs` (Bearer auth, missing 401, invalid 403, GET 405)
8. Master `ServerlessJobProcessor.processAll()` execution
9. Durable `BackgroundJob` persistence and fair-dispatch claim processing
10. Concurrency safety under simultaneous parallel processors (zero duplicate processing or lock collisions)
