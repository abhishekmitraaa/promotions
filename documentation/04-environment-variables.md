# 04 — Environment Variables (what the code actually reads)

Taken from `src/lib/env.ts` plus every direct `process.env.*` read in `src/` and `workers/` (12 Oct 2026). `.env.example` is **out of date**. Use this table instead.

"Prod" column: **Required** = the app won't start or the feature fails without it. **Recommended** = works without it but behaves badly. **Optional** = has a sensible default.

## Core

| Variable | Read in | Prod | Notes |
|---|---|---|---|
| `NODE_ENV` | many | auto | Vercel sets `production` |
| `DATABASE_URL` | `env.ts`, Prisma | **Required** | Supabase pooler, port 6543, `?pgbouncer=true` |
| `DIRECT_URL` | Prisma | **Required** for migrations | Port 5432 |
| `APP_URL` | `env.ts`, OAuth routes | **Required** | `https://promotions-lime.vercel.app` |
| `NEXT_PUBLIC_APP_URL` | `getPublicAppUrl()` | Optional | Overrides `APP_URL` for unsubscribe/tracking links if set. If you set it, it must be the production URL |
| `NEXTAUTH_URL` | — | Not used | No longer read (12 Oct fix) |
| `LOG_LEVEL` | `env.ts` | Optional | `debug`/`info`/`warn`/`error` |

## Security secrets (each ≥ 32 random characters)

| Variable | Read in | Prod | Notes |
|---|---|---|---|
| `API_KEY_PEPPER` | `env.ts` | **Required** | Changing it invalidates every API key |
| `AUTH_SESSION_SECRET` | `env.ts`, `middleware.ts`, unsubscribe tokens | **Required** | Changing it logs everyone out and invalidates old unsubscribe links |
| `WEBHOOK_SECRET_ENCRYPTION_KEY` | `env.ts`, `crypto.ts` | **Required** | Not in `.env.example`. Encrypts webhook secrets; also the fallback key for provider credentials |
| `EMAIL_CREDENTIALS_ENCRYPTION_KEY` | `crypto.ts` | **Recommended** | Encrypts Gmail tokens. Not in `.env.example` (which wrongly says `PROVIDER_CREDENTIAL_KEY`). **Never change after connecting Gmail** |
| `EMAIL_TRACKING_SECRET` | tracking service | Recommended | Falls back to `AUTH_SESSION_SECRET` |
| `EMAIL_UNSUBSCRIBE_SECRET` | unsubscribe service | Optional | Used only if `AUTH_SESSION_SECRET` is unset |
| `INTERNAL_PROCESSOR_SECRET` | `/api/internal/process-jobs` | **Required** | Must match Supabase Vault secret `internal_processor_secret`; returns 500 if missing |
| `INTERNAL_WORKER_SECRET`, `CRON_SECRET` | `middleware.ts`, `/api/admin/webhooks/process-queue` | Optional | Legacy machine auth for the webhook queue route |

## WhatsApp (Meta)

| Variable | Prod | Notes |
|---|---|---|
| `META_ACCESS_TOKEN` | **Required for WhatsApp** | Permanent system-user token. **Empty locally** |
| `META_PHONE_NUMBER_ID` | **Required for WhatsApp** | Empty locally |
| `META_WABA_ID` | Recommended | Empty locally |
| `META_APP_SECRET` | **Required for inbound webhooks** | Verifies `X-Hub-Signature-256` |
| `META_WEBHOOK_VERIFY_TOKEN` | **Required for inbound webhooks** | Your chosen string |
| `META_GRAPH_API_VERSION` | Optional | Default `v22.0` |
| `DEV_ALLOW_UNCONFIGURED_META` | — | Development only; simulates sends. Forced `false` in production |

## OTP

| Variable | Default | Notes |
|---|---|---|
| `OTP_CODE_LENGTH` | 6 | 4–10 |
| `OTP_EXPIRY_SECONDS` | 300 | |
| `OTP_MAX_ATTEMPTS` | 5 | |
| `OTP_TEMPLATE_NAME` | `auth_otp_code` | Must be an **approved** Meta AUTHENTICATION template |
| `OTP_TEMPLATE_LANGUAGE` | `en_US` | |

## Email (Gmail)

| Variable | Prod | Notes |
|---|---|---|
| `GMAIL_CLIENT_ID` | **Required for email** | `.env.example` wrongly says `GOOGLE_CLIENT_ID` |
| `GMAIL_CLIENT_SECRET` | **Required for email** | `.env.example` wrongly says `GOOGLE_CLIENT_SECRET` |
| `GMAIL_WEBHOOK_VERIFICATION_TOKEN` | Optional | Only if receiving Gmail push events without a per-tenant secret |
| `SES_WEBHOOK_SECRET` | Not used | SES verifier exists, but there is no SES sender |

## Queue / processing

| Variable | Prod | Notes |
|---|---|---|
| `WORKERLESS_MODE` | Optional | Workerless is the default. Only `false` (plus `REDIS_URL`) switches to legacy BullMQ, which needs a running worker. **Never set `false` on Vercel** |
| `REDIS_URL` | Optional | If set, it is the rate-limit backend, and login/OTP fail closed whenever it is unreachable. If unset, rate limiting uses the PostgreSQL `RateLimit` table |
| `EMAIL_WORKER_CONCURRENCY`, `EMAIL_EVENTS_CONCURRENCY`, `EMAIL_CAMPAIGN_CONCURRENCY`, `EMAIL_QUEUE_MAX_RATE`, `EMAIL_QUEUE_MAX_ATTEMPTS`, `EMAIL_QUEUE_BACKOFF_MS`, `EMAIL_CAMPAIGN_MAX_RATE` | Not used | Legacy BullMQ worker tuning only |
| `OUTBOUND_WEBHOOK_TIMEOUT_MS` | Optional | Default 10000 |
| `OUTBOUND_WEBHOOK_MAX_RETRIES` | Optional | Default 5 |

## Scripts only

| Variable | Used by |
|---|---|
| `DEMO_ADMIN_EMAIL`, `DEMO_ADMIN_PASSWORD` | `npm run auth:seed-admin` (email defaults to `cosora.demo@gmail.com`) |
| `ALLOW_DESTRUCTIVE_TESTS` | Destructive test suites (local DB only; production is always blocked) |

## Unused entries in the local `.env`

`ADMIN_USERNAME` and `ADMIN_PASSWORD` are not read anywhere in `src/`. They are left over from an older login scheme and can be removed.
