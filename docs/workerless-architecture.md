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

### 3.4. Supabase Cron & pg_net Dispatcher
Configured in PostgreSQL on Supabase project `peqynzeioiauynfpdsdv`:
```sql
SELECT cron.schedule(
  'process-email-jobs',
  '* * * * *',
  $$
  SELECT net.http_post(
    url := 'https://promotions-lime.vercel.app/api/internal/process-jobs',
    body := '{"source":"supabase_cron"}'::jsonb,
    params := '{}'::jsonb,
    headers := '{"Content-Type": "application/json", "x-worker-secret": "<INTERNAL_WORKER_SECRET>"}'::jsonb,
    timeout_milliseconds := 30000
  );
  $$
);
```

### 3.5. Internal Processing Endpoint (`/api/internal/process-jobs`)
Located at `src/app/api/internal/process-jobs/route.ts`:
- Accepts `POST` and `GET` requests.
- Validates `x-worker-secret` or `Authorization: Bearer <CRON_SECRET>` using timing-safe comparison.
- Returns comprehensive execution reports:
```json
{
  "success": true,
  "data": {
    "success": true,
    "timestamp": "2026-10-06T16:57:33.074Z",
    "durationMs": 12530,
    "results": {
      "webhooks": { "claimed": 0, "succeeded": 0, "failed": 0 },
      "transactional": { "processed": 0, "succeeded": 0, "failed": 0 },
      "scheduledCampaigns": { "processed": 0, "succeeded": 0, "failed": 0 },
      "campaignRecipients": { "processed": 0, "succeeded": 0, "failed": 0 },
      "recurringAutomations": { "processed": 0, "succeeded": 0, "failed": 0 },
      "automationEnrollments": { "processed": 0, "succeeded": 0, "failed": 0 },
      "events": { "processed": 0, "succeeded": 0, "failed": 0 },
      "reconciliation": { "recoveredDeliveries": 0, "failedDeliveries": 0, "recoveredRecipients": 0, "completedCampaigns": 0 }
    }
  }
}
```

---

## 4. Zero-Regression Dual Mode

To maintain 100% backward compatibility with existing tests and environments:
- **In Tests / Redis Environments**: `isWorkerlessMode()` evaluates to `false`. Real BullMQ queues operate normally.
- **In Production / Vercel**: `isWorkerlessMode()` evaluates to `true` (`WORKERLESS_MODE=true` or running on Vercel without a remote Redis). `WorkerlessQueueAdapter` ensures `queue.add()` writes state durably to PostgreSQL without attempting network connections to Redis.

---

## 5. Verification & Testing

Run the dedicated test suite:
```bash
npm run test:workerless
```
Tests pass across all 8 phases:
1. Workerless mode configuration check
2. Transactional delivery processing
3. Scheduled campaign triggers
4. Campaign recipient batch dispatch
5. Automation step & timeout advancement
6. Email telemetry event processing
7. Authorization & secret validation on `/api/internal/process-jobs`
8. Master `ServerlessJobProcessor.processAll()` execution
