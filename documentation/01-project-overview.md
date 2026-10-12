# 01 — Project Overview

## What it is

WhatsApp Hub is a self-hosted **communication gateway**. Your other application calls it with a Bearer API key, and the hub sends WhatsApp messages, OTP codes and emails on your behalf. The provider credentials (Meta token, Google OAuth tokens) live only inside the hub, never in the calling app.

| Item | Value |
|---|---|
| Repository | https://github.com/abhishekmitraaa/promotions (app lives in `whatsapp-hub/`) |
| Production URL | https://promotions-lime.vercel.app |
| Hosting | Vercel (project `whatsapp-hub`, functions pinned to `bom1` Mumbai) |
| Database | Supabase PostgreSQL 17, project ref `peqynzeioiauynfpdsdv`, region `ap-south-1` |
| Scheduler | Supabase `pg_cron` + `pg_net` → `POST /api/internal/process-jobs` |
| Node | ≥ 22.12.0 |

## Features

| Area | What exists | Entry points |
|---|---|---|
| WhatsApp messaging | Text and template messages via Meta Cloud API; idempotency; 60 req/min rate limit; automatic retry (up to 5 attempts) on temporary Meta failures | `POST /api/v1/messages`, `GET /api/v1/messages/[id]`, `GET /api/v1/conversations` |
| Inbound WhatsApp | Webhook verification (GET) and HMAC-SHA256 signed event intake (POST) | `/api/webhooks/whatsapp` |
| OTP | Hashed codes, expiry (300 s), max 5 attempts, sent as a WhatsApp **template** (`auth_otp_code`) | `POST /api/v1/otp/request`, `POST /api/v1/otp/verify` |
| Email send | `TRANSACTIONAL` / `PROMOTIONAL`; durable `EmailDelivery` + `BackgroundJob` | `POST /api/v1/email/send` |
| Email provider | **Gmail / Google Workspace only** (OAuth2, encrypted refresh token). SES verifier code exists but no SES sender | `/api/admin/email/providers/*` |
| Audience | Contacts, CSV import, lists, dynamic segments, suppressions, unsubscribe | `/api/email/contacts`, `/lists`, `/segments`, `/suppressions`, `/unsubscribe/[token]` |
| Campaigns & automations | Templates with versions, scheduled campaigns, pause/resume/cancel, journeys | `/api/email/campaigns/*`, `/api/email/automations/*`, `/api/email/templates/*` |
| Tracking | Signed open/click tokens, provider event webhooks, analytics; optional Gmail bounce detection by mailbox scan (`GMAIL_BOUNCE_DETECTION`) | `/api/email/track/*`, `/api/email/webhooks/[provider]`, `/api/email/analytics` |
| Outbound webhooks | HMAC-signed delivery to your app, retries, SSRF checks | `/api/admin/webhooks/*` |
| Dashboard | Login, password reset, email verification, Admin/Viewer RBAC, API keys, users, settings | `/login`, `/dashboard/*`, `/api/auth/*`, `/api/admin/*` |
| Health | Liveness/config check | `GET /api/health` |
| Multi-channel abstraction | `ChannelAdapter` interface; email and WhatsApp adapters are real, **SMS and push are interface stubs only** | `src/lib/communication/` |

## Architecture

```
 Your app ──Bearer whub_…──▶ Next.js API (Vercel, bom1)
                               │  validate (Zod) → auth (peppered key hash) → rate limit
                               │
                 ┌─────────────┼───────────────────────────────┐
                 │ synchronous │                               │ asynchronous
                 ▼             │                               ▼
     Meta WhatsApp Cloud API   │                 PostgreSQL: EmailDelivery + BackgroundJob
     (messages, OTP template)  │                               ▲
                               │                               │ claims work (FOR UPDATE SKIP LOCKED)
                               │                               │
  Supabase pg_cron ──every 1 min──▶ POST /api/internal/process-jobs  (Bearer INTERNAL_PROCESSOR_SECRET from Vault)
                   ──every 5 min──▶ POST /api/internal/process-jobs?reconcile=true
                                                │
                                                ▼
                                   ServerlessJobProcessor.processAll()
                                   ├─ webhooks (outbound deliveries)
                                   ├─ background jobs → executors (email, campaign recipient, automation, event)
                                   ├─ direct sweeps (transactional emails, campaign recipients, events)
                                   └─ reconciliation (stale locks)
                                                │
                                                ▼
                                   Gmail API (users/me/messages/send)
```

Key design choices:

- **No worker and no Redis.** State lives in Postgres; short Vercel invocations do the work. The BullMQ/Redis worker code was removed on 12 Oct 2026.
- **Rate limiting** is an atomic counter in the Postgres `RateLimit` table. Auth and OTP limits fail closed if the database limiter is unavailable; other limits fall back to per-instance memory.
- **Duplicate-send protection** lives in `src/lib/services/executors/claim-lock.ts`: conditional claims, token-bound writes, and an in-flight marker that stops an automatic re-send after a crash mid-send.
- **Secrets at rest:** API keys are stored as HMAC(pepper) hashes; OTPs as hashes; webhook secrets and Gmail credentials are AES-256-GCM encrypted.
- **Middleware** (`src/middleware.ts`) guards `/dashboard/*` and `/api/admin/*` with a signed session cookie; non-GET admin API calls require the `ADMIN` role.

## Data model (Prisma, 28 models)

| Domain | Models |
|---|---|
| Auth | `User`, `UserSession`, `OAuthState` (one-time Google sign-in state) |
| Tenancy & keys | `ApiClient` (tenant), `ApiKey`, `RateLimit` |
| WhatsApp | `Message`, `MessageEvent`, `OtpVerification` |
| Outbound webhooks | `WebhookEndpoint`, `WebhookDelivery` |
| Email setup | `EmailProviderConfig`, `EmailSenderIdentity`, `EmailDomain` |
| Audience | `EmailContact`, `EmailList`, `EmailListMember`, `EmailSegment`, `EmailSuppression` |
| Content & sends | `EmailTemplate`, `EmailTemplateVersion`, `EmailCampaign`, `EmailCampaignRecipient`, `EmailDelivery`, `EmailEvent` |
| Automation | `EmailAutomation`, `EmailAutomationEnrollment` |
| Queue | `BackgroundJob` |

Schema: `prisma/schema.prisma`. Migrations: `prisma/migrations/` (12 migrations; the two newest, `20261012000000_oauth_state_store` and `20261012010000_whatsapp_message_retry`, are **not yet applied to production**).

## Repository layout (`whatsapp-hub/`)

| Path | Contents |
|---|---|
| `src/app/api/v1/` | Public API used by your app (messages, OTP, email send, conversations) |
| `src/app/api/admin/`, `src/app/api/email/`, `src/app/api/auth/` | Dashboard back-end APIs |
| `src/app/api/internal/process-jobs/` | Cron-triggered processor endpoint |
| `src/app/dashboard/` | Dashboard UI pages |
| `src/lib/env.ts` | Zod-validated config (core vars only; many email vars are read directly from `process.env`) |
| `src/lib/whatsapp/` | Meta Cloud API client |
| `src/lib/email/` | Provider registry, Gmail provider, templates, tracking, webhook verifiers, PostgreSQL job queue (`queue/`) |
| `src/lib/services/` | Business logic; `serverless-job-processor.ts` and `executors/` are the async engine |
| `src/lib/communication/` | Multi-channel adapter layer |
| `prisma/` | Schema and migrations |
| `scripts/` | Setup, key creation, admin seeding, ~40 `verify-*.ts` test suites |
| `.github/workflows/` | `email-tests.yml`, `rbac-tests.yml` |

## History (from git)

| Commit | Change |
|---|---|
| early Sept 2026 | Core WhatsApp API, OTP, webhooks, API keys; SQLite → Supabase Postgres |
| 21–29 Sept | RBAC dashboard auth; full email platform (Gmail OAuth, campaigns, segments, tracking, deliverability, automations) |
| `b746da4` | Hosting moved from Netlify to Vercel |
| `90f738e` … `f4a3d91` | Workerless processor via Supabase Cron + `BackgroundJob` |
| `598b612` | Performance: 60 s max duration, `bom1`, Prisma reuse, staged parallelism |
| `c5ccaf9`, `1509601` | Atomic claim / cross-path race fix (**see code review — introduced new bugs**) |
| `7ee228b`, `bb76d0c` | Docs and audit only |
| `39e1e19` (12 Oct, branch `fix/review-2026-10-12`) | Fixes for all 15 review findings, rate-limiter and Prisma transient-error gaps, documentation set |
| `7fe5e46` (same branch) | Redis and legacy BullMQ worker removed; OAuth state in Postgres; consent/unsubscribe/tracking restored in executors |
| next commit (same branch) | WhatsApp automatic retries; Gmail bounce detection |
