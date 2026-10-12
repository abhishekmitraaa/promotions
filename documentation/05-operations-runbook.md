# 05 — Operations Runbook

## Daily commands (local, from `whatsapp-hub/`)

| Task | Command |
|---|---|
| Install | `npm install` |
| First-time local config | `npm run setup` (writes `.env.local`, pushes schema, prints a dev API key) |
| Run locally | `npm run dev` → http://localhost:3000/login |
| Type check / lint / build | `npx tsc --noEmit` · `npm run lint` · `npm run build` |
| Create admin | `DEMO_ADMIN_EMAIL=… DEMO_ADMIN_PASSWORD=… npm run auth:seed-admin` |
| Create API key | `npx tsx scripts/create-api-key.ts --client "MyProject" --key "Production"` |
| Apply migrations to prod | `npx prisma migrate deploy` (uses `DIRECT_URL`) |

## Tests

All destructive suites run only against a **disposable local Postgres** (`localhost`, `127.0.0.1`, `postgres` container) with `ALLOW_DESTRUCTIVE_TESTS=true`. No Redis is needed. `scripts/test-db-guard.ts` permanently blocks the production project `peqynzeioiauynfpdsdv`.

| Suite | Command |
|---|---|
| Core + all email suites | `npm test` |
| Job processor + concurrency and regression checks | `npm run test:workerless` |
| WhatsApp automatic retries | `npm run test:whatsapp` |
| Gmail bounce detection | `npm run test:email:bounces` |
| Email certification (130 assertions) | `npm run test:email:certify` |
| RBAC / last-admin invariant | `npm run test:rbac` |
| Guard self-test | `npm run test:guard` |

CI (`.github/workflows/email-tests.yml`, `rbac-tests.yml`) runs on push: `prisma migrate deploy` into a service Postgres, then `npm test` and the email suites.

## Deploy

Push to `main` and Vercel builds automatically (`prebuild` runs `prisma generate`). Schema changes are **not** applied by the build. Run `npx prisma migrate deploy` against production yourself, **before** deploying code that depends on the new schema. The 12 Oct branch needs two migrations applied first (`oauth_state_store`, `whatsapp_message_retry`).

Function settings (`vercel.json`): `/api/internal/process-jobs` and `/api/admin/jobs/process` run with `maxDuration: 60` in region `bom1`.

## Scheduled processing (Supabase)

Two `pg_cron` jobs call the processor using a Bearer token read from Vault secret `internal_processor_secret`:

| Job | Schedule | Target |
|---|---|---|
| 4 `process-email-jobs` | `* * * * *` | `POST /api/internal/process-jobs` |
| 5 `reconcile-email-jobs` | `*/5 * * * *` | `POST /api/internal/process-jobs?reconcile=true` |

Full SQL is in [`../docs/workerless-architecture.md`](../docs/workerless-architecture.md) §3.4.

To **rotate the processor secret**, update both sides at the same moment, or calls fail with 403:
1. `select vault.update_secret((select id from vault.secrets where name='internal_processor_secret'), '<new>');`
2. Set `INTERNAL_PROCESSOR_SECRET=<new>` in Vercel and redeploy.

To trigger processing by hand, log in as Admin and `POST /api/admin/jobs/process`.

## Monitoring queries (Supabase SQL editor)

> Since the 12 Oct fixes, the processor returns **HTTP 500** whenever any processing category reports an error, so non-200 rows in `net._http_response` are real failures. Deployments older than that always returned 200.

```sql
-- Processor calls in the last hour: status codes, timeouts, and the success flag in the body
select created, status_code, timed_out,
       (content::jsonb -> 'data' ->> 'success') as processing_success,
       left(content, 200) as body
from net._http_response
where created > now() - interval '1 hour'
order by created desc limit 50;

-- Queue health
select type, status, count(*), min("availableAt") as oldest
from "BackgroundJob" group by type, status order by type, status;

-- Stuck or burning jobs (see review finding #2)
select id, type, status, "attemptCount", "maxAttempts", "lockedAt", "lastErrorCode", "lastErrorMessage"
from "BackgroundJob"
where (status = 'PROCESSING' and "lockedAt" < now() - interval '10 minutes')
   or "attemptCount" > "maxAttempts"
order by "updatedAt" desc limit 50;

-- Recent email deliveries
select id, status, "attemptCount", "providerMessageId", "errorCode", left("errorMessage",120) as err, "createdAt"
from "EmailDelivery" order by "createdAt" desc limit 20;

-- Sends with unknown outcome (worker died mid-send; never auto-retried). Review by hand.
select 'delivery' as kind, id, "to" as email, "updatedAt" from "EmailDelivery" where "errorCode" = 'SEND_OUTCOME_UNKNOWN'
union all
select 'campaign_recipient', id, email, "updatedAt" from "EmailCampaignRecipient" where "errorCode" = 'SEND_OUTCOME_UNKNOWN'
union all
select 'whatsapp_message', id, "to", "updatedAt" from "Message" where "errorCode" = 'SEND_OUTCOME_UNKNOWN'
order by "updatedAt" desc limit 50;

-- Email events stuck in PROCESSING (should be rare after the 12 Oct fix for review #1)
select id, status, attempts, "lastAttemptAt", "errorCode"
from "EmailEvent" where status = 'PROCESSING' order by "lastAttemptAt" limit 20;

-- Recent WhatsApp messages (attemptCount > 1 means automatic retries happened)
select id, type, status, "attemptCount", "providerMessageId", "errorCode", left("errorMessage",120) as err, "createdAt"
from "Message" order by "createdAt" desc limit 20;

-- Outbound webhook deliveries failing
select id, status, "attemptCount", "nextAttemptAt", left("errorMessage",120) as err
from "WebhookDelivery" where status <> 'DELIVERED' order by "createdAt" desc limit 20;

-- Cron job runs
select jobid, status, start_time, end_time, left(return_message,120)
from cron.job_run_details order by start_time desc limit 20;
```

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Processor returns 500 "Server authentication misconfigured" | `INTERNAL_PROCESSOR_SECRET` missing in Vercel | Set it and redeploy |
| Processor returns 403 | Vault secret ≠ Vercel secret | Re-sync both (see rotation above) |
| App 500s on every request after deploy | `env.ts` rejected config (`API_KEY_PEPPER`, `AUTH_SESSION_SECRET` or `WEBHOOK_SECRET_ENCRYPTION_KEY` weak or missing) | Check Vercel runtime logs for "Fatal Production Environment Error" |
| `/api/v1/email/send` returns 202 but nothing is sent | The cron processor is not running, or the job failed | Check `cron.job_run_details`, `net._http_response` and the `BackgroundJob` row's `lastErrorMessage`. The dashboard shows processor status `STALLED` when runnable jobs wait over 5 minutes |
| Login / OTP request returns `RATE_LIMITER_UNAVAILABLE` (503) | The database rate limiter could not be reached; critical limits fail closed by design | Check Supabase availability and the connection pool |
| Delivery, recipient or WhatsApp message `FAILED` with `SEND_OUTCOME_UNKNOWN` | The invocation was killed during the provider call; it may have been sent | Email: check the sender's Gmail "Sent" folder. WhatsApp: check the conversation. Re-send manually only if it isn't there |
| `POST /api/v1/messages` returns 202 with `retryScheduled` | Meta was temporarily unavailable; a retry job is queued | Nothing to do. The message becomes `SENT`, or `FAILED` after 5 attempts |
| "Connect Google" fails with a database error on `OAuthState` | Migration `20261012000000_oauth_state_store` not applied | Run `npx prisma migrate deploy` against production |
| Bounces are not detected | `GMAIL_BOUNCE_DETECTION` unset, or Google was connected before it was set (no `gmail.readonly` grant) | Set the variable, redeploy, reconnect Google |
| Email fails "Failed to decrypt Gmail provider credentials" | `EMAIL_CREDENTIALS_ENCRYPTION_KEY` (or `WEBHOOK_SECRET_ENCRYPTION_KEY` fallback) changed | Restore the old key, or reconnect Gmail |
| Email fails "Failed to refresh Google OAuth token (400)" | Refresh token revoked or expired (7-day limit for External apps in Testing) | Reconnect in Dashboard → Email → Providers; publish the OAuth app |
| WhatsApp error 131047 / "re-engagement" | Free-form text outside the 24 h window | Use an approved template |
| WhatsApp error 132001 | Template name or language not approved | Check WhatsApp Manager → Templates |
| OTP request fails | `auth_otp_code` template missing or not approved | Create an AUTHENTICATION template, or set `OTP_TEMPLATE_NAME` |
| Inbound WhatsApp messages never appear | Webhook not subscribed, or `META_APP_SECRET` wrong (signature check rejects) | Re-verify the webhook in Meta and subscribe to `messages` |
| Unsubscribe / tracking links point to `localhost:3000` | `APP_URL` unset in Vercel | Set `APP_URL` to the production URL |
| Campaign stuck in `RUNNING` | A recipient is locked in `PROCESSING` (review #7) | Reset that recipient to `PENDING` with a lock clear, then fix #7 |
