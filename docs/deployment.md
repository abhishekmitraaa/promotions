# Deployment Architecture & Production Operations Guide

WhatsApp Hub runs entirely on two managed services. There is no Redis and no long-running worker process.

| Layer | Service | Notes |
|---|---|---|
| Web app, public API, dashboard, job processor | **Vercel** (Next.js) | Processor routes pinned to `bom1` with `maxDuration: 60` (`vercel.json`) |
| Database, durable job queue, rate limits, OAuth state | **Supabase PostgreSQL** (`ap-south-1`) | Pooled `DATABASE_URL` (6543) for runtime, `DIRECT_URL` (5432) for migrations |
| Scheduler | **Supabase `pg_cron` + `pg_net`** | Calls the processor every minute; reconciliation every 5 minutes |

```
Your app ──Bearer key──▶ Vercel /api/v1/*  ──writes──▶ PostgreSQL (EmailDelivery, BackgroundJob, ...)
                                                              ▲
Supabase pg_cron ──every 1 min──▶ POST /api/internal/process-jobs (Bearer secret from Vault)
                                        └── claims due jobs (FOR UPDATE SKIP LOCKED) → executors → Gmail / Meta
```

## Deploying a change

1. **Migrations first.** Builds do not apply schema changes. If the release adds a migration, run it against production before the code deploys:
   ```bash
   DATABASE_URL="<prod pooled url>" DIRECT_URL="<prod direct url>" npx prisma migrate deploy
   ```
2. **Push to `main`.** Vercel builds automatically (`prebuild` runs `prisma generate`).
3. **Verify.** Check the new deployment's SHA in Vercel, the GitHub Actions run, and the cron responses (`net._http_response` should return 200; the processor returns 500 when a category fails).

## Environment

See [`documentation/04-environment-variables.md`](../documentation/04-environment-variables.md) for every variable the code reads. Production refuses to start without strong `API_KEY_PEPPER`, `AUTH_SESSION_SECRET` and `WEBHOOK_SECRET_ENCRYPTION_KEY`.

## Scheduler setup

The cron job SQL (with the Vault-stored Bearer secret) is in [`docs/workerless-architecture.md`](workerless-architecture.md) §3.4. Monitoring queries, secret rotation and troubleshooting are in [`documentation/05-operations-runbook.md`](../documentation/05-operations-runbook.md).

## Local disposable test infrastructure

Destructive test suites need a throwaway PostgreSQL only:

```bash
docker run -d --name disposable-email-postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=email_test -p 5433:5432 postgres:16
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5433/email_test \
DIRECT_URL=postgresql://postgres:postgres@127.0.0.1:5433/email_test npx prisma migrate deploy
```

`scripts/test-db-guard.ts` blocks the production project unconditionally.
