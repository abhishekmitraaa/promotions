# 04 — Environment Variables (what the code actually reads)

Taken from `src/lib/env.ts` plus every direct `process.env.*` read in `src/` (12 Oct 2026, after the Redis and worker removal). `.env.example` now matches this table.

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
| `GMAIL_BOUNCE_DETECTION` | Optional | `true` enables the 5-minute mailbox scan for bounce notices and adds `gmail.readonly` to the Google consent screen. Set before connecting Google |
| `GMAIL_WEBHOOK_VERIFICATION_TOKEN` | Optional | Only if receiving Gmail push events without a per-tenant secret |
| `SES_WEBHOOK_SECRET` | Not used | SES verifier exists, but there is no SES sender |

## Queue / processing

| Variable | Prod | Notes |
|---|---|---|
| `WORKERLESS_MODE`, `REDIS_URL` | Not used | Removed 12 Oct 2026. Delete them from Vercel if present |
| `OUTBOUND_WEBHOOK_TIMEOUT_MS` | Optional | Default 10000 |
| `OUTBOUND_WEBHOOK_MAX_RETRIES` | Optional | Default 5 |

## Scripts only

| Variable | Used by |
|---|---|
| `DEMO_ADMIN_EMAIL`, `DEMO_ADMIN_PASSWORD` | `npm run auth:seed-admin` (email defaults to `cosora.demo@gmail.com`) |
| `ALLOW_DESTRUCTIVE_TESTS` | Destructive test suites (local DB only; production is always blocked) |

## Unused entries in the local `.env`

`ADMIN_USERNAME` and `ADMIN_PASSWORD` are not read anywhere in `src/`. They are left over from an older login scheme and can be removed.
