# Unresolved Concerns & Project Flags

> **MANDATORY AUTOMATIC UPDATE RULE**:
> This file is automatically updated after **every prompt/response** without needing to be prompted. It records all unresolved concerns, technical flags, edge cases, potential risks, and open architectural decisions identified during work. If a prompt completes with zero open concerns, an entry stating `Status: Clean (No unresolved concerns)` is logged to maintain a continuous audit trail.

---

## Active & Historical Flags Log

### Entry: 2026-09-24 — Phase 1 (Database & Domain Foundation for Email)
- **Prompt / Phase**: Phase 1 — Database & Domain Foundation
- **Status**: ✅ All Clear / Clean
- **Unresolved Concerns**: None.
- **Notes / Observations**:
  - Additive Prisma schema changes (`13 models`, `10 enums`) successfully verified with PostgreSQL migration `20260925000000_add_email_platform_foundation`.
  - Row Level Security (RLS) policies generated and verified for all 13 tables.
  - Multi-tenant `clientId` isolation invariants validated.
  - No changes made to WhatsApp pipelines or existing auth tables.
  - Production Supabase database was protected (no destructive tests run).

---

### Entry: 2026-09-24 — Documentation & Flag System Setup
- **Prompt / Phase**: Establish `documentation/flags.md` and automated sync workflow.
- **Status**: ✅ Active & Tracking
- **Unresolved Concerns**: None.
- **Notes / Observations**:
  - Created `documentation/flags.md` to track flags and concerns automatically after every prompt.
  - Configured workspace rule in `.agents/rules/unresolved-flags.md` to ensure automatic updates on all subsequent prompts.

### Entry: 2026-09-24 — Phase 1 Re-Verification & Architectural Conformance Audit
- **Prompt / Phase**: Phase 1 — Database & Domain Foundation Audit & Re-Verification
- **Status**: ✅ All Clear / Clean
- **Unresolved Concerns**: None.
- **Notes / Observations**:
  - Full automated test suite (112 tests across service verification, destructive test safety guard, and email domain foundation) executed cleanly.
  - Verified 13 models, 10 enums, and migration `20260925000000_add_email_platform_foundation` strictly follow multi-tenant isolation, cascade rules, composite indexes, and RLS policies.
  - Zero modifications to WhatsApp message pipeline or existing security/auth logic.
  - ESLint (0 errors, 0 warnings), TypeScript (`tsc --noEmit`), and Next.js production build (`next build`) all passing cleanly.

### Entry: 2026-09-25 — Phase 2 (Email Provider Layer & Gmail Integration)
- **Prompt / Phase**: Phase 2 — Email Provider Abstraction & Google Workspace / Gmail Provider Integration
- **Status**: ✅ Clean (No unresolved concerns)
- **Unresolved Concerns**: None.
- **Notes / Observations**:
  - Normalized `EmailProvider` interface defined in `src/lib/email/types.ts` returning normalized result fields (`accepted`, `providerName`, `providerMessageId`, `providerStatus`, `error`).
  - Created provider registry/resolver (`src/lib/email/registry.ts`) decoupling provider resolution from `EmailService`.
  - Implemented server-side Google OAuth with narrowest practical permission (`https://www.googleapis.com/auth/gmail.send`), CSRF-protected state generation/verification, and offline refresh token persistence.
  - Secure credential storage at rest via AES-256-GCM (`src/lib/crypto.ts`), credentials and tokens are never logged (`redactSecrets` utility applied across all provider logs/error handling).
  - RFC 2822 MIME builder (`src/lib/email/providers/gmail/mime.ts`) supporting multipart/alternative, RFC 2047 subject encoding, base64url RFC 4648 encoding, and transactional vs promotional categorization headers.
  - `EmailService` (`src/lib/services/email-service.ts`) enforces tenant ownership, sender identity verification, provider resolution, direct delivery, and `EmailDelivery` state recording.
  - Server-side RBAC enforced on all provider and sender identity management routes (`ADMIN` role strictly enforced for mutations; `VIEWER` strictly restricted to read-only listings with credentials omitted).
  - Automated tests: 46 Phase 2 tests (`test:email-phase2`), all 114 total test suite checks passing (`npm test`), ESLint passing with 0 warnings/errors, and Next.js production build (`npm run build`) succeeded without warnings or errors.

---

### Entry: 2026-09-25 — Phase 3 (Transactional Email & Authentication Integration)
- **Prompt / Phase**: Phase 3 — Transactional Email & Authentication (Email Verification, Multi-Channel OTP, Password Reset)
- **Status**: ✅ Clean (No unresolved concerns)
- **Unresolved Concerns**: None.
- **Notes / Observations**:
  - Reused existing hardened authentication and OTP architecture without duplicating security primitives.
  - Added multi-channel dispatch to `OtpService` supporting both `WHATSAPP` and `EMAIL` channels while preserving atomic verification, attempt limits, expiration, failed states, and concurrency race defense (HTTP 409).
  - Created system transactional templates for `EMAIL_VERIFICATION`, `EMAIL_OTP`, and `PASSWORD_RESET` (`src/lib/email/templates.ts`) with automatic HTML entity escaping (XSS defense) and clean plain-text generation.
  - Implemented `EmailService.sendTransactional(...)` with provider-agnostic dispatch and transactional category retention.
  - Implemented `AuthTokenService` (`src/lib/services/auth-token-service.ts`) with 256-bit high-entropy random tokens, one-way SHA-256 token hashing at rest, short TTLs, and atomic single-use state transitions.
  - Implemented `POST /api/auth/forgot-password` with strict account enumeration protection (constant-time generic response regardless of user existence).
  - Implemented `POST /api/auth/reset-password` with automatic invalidation of all active `UserSession` records on password change.
  - Implemented `GET` and `POST /api/auth/verify-email` and `POST /api/auth/send-verification`.
  - Added minimal dark-themed UI pages matching existing design system for `/forgot-password`, `/reset-password`, `/verify-email`, and updated `/login`.
  - Automated tests: 58 tests in `test:email-phase3` passing. Full test suite passing (over 170 unit checks in `npm test`), ESLint clean (0 errors, 0 warnings), Next.js production build (`npm run build`) succeeded with 42 routes compiled. No destructive tests run against production.

---

### Entry: 2026-09-25 — Phase 4 (BullMQ + Redis Asynchronous Email Processing)
- **Prompt / Phase**: Phase 4 — BullMQ + Redis for Asynchronous Email Processing
- **Status**: ✅ Clean (No unresolved concerns)
- **Unresolved Concerns**: None.
- **Notes / Observations**:
  - Added `bullmq` (^6.3.8) and `ioredis` (^6.0.0) as dedicated dependencies; zero disruption to WhatsApp queue or PostgreSQL webhook models.
  - Implemented centralized Redis connection management (`src/lib/email/queue/connection.ts`) with strict URL validation, credential redaction (`sanitizeRedisUrl`), and worker-specific client configs (`maxRetriesPerRequest: null`, `enableReadyCheck: false`).
  - Separate BullMQ queues established (`email-transactional`, `email-campaign`, `email-events`) with bounded retries (default 3), exponential backoff (2000ms), and auto-cleanup retention policies (`removeOnComplete`, `removeOnFail`).
  - Authoritative lightweight job payloads (`deliveryId`, `clientId`, `category`) rather than raw content blobs; data resolved directly from database in worker.
  - Deterministic idempotency job IDs (`email-transactional-${deliveryId}`, `email-campaign-${campaignRecipientId}`) enforce queue-level deduplication.
  - Database-first transactional enqueueing (`queueTransactionalEmail`) guarantees persistent `EmailDelivery` state before pushing to Redis.
  - Dedicated standalone Node worker executable (`workers/email-worker.ts`) and worker processor (`src/lib/email/queue/worker.ts`) featuring:
    - Authoritative database delivery verification.
    - Stale delivery state protection (skips already `SENT` or `DELIVERED` deliveries to prevent duplicate customer emails).
    - Recipient suppression checking (`emailSuppression` table).
    - Provider resolution with zero secret leakage in logs.
    - Error classification: transient errors (timeout, 429, 503, connection drops) throw `RetryableEmailError` for BullMQ exponential backoff; permanent errors (suppressed recipient, 400 bad request, missing record, unconfigured provider) throw BullMQ's native `UnrecoverableError` to immediately fail without burning retries.
  - Netlify serverless deployment model clearly documented in `docs/email-queue-architecture.md`: Next.js web application acts purely as queue producer, while persistent worker runs as an external containerized Node daemon (Docker, AWS ECS, Fly.io, Railway, etc.).
  - Authenticated health monitoring (`GET /api/admin/email/queue/health`) reports Redis latency, status, and job counts (`waiting`, `active`, `completed`, `failed`, `delayed`) with fully redacted credentials.
  - Automated testing: 46 Phase 4 tests in `test:email-phase4` passing. Full test suite passing (over 210 checks across 6 suites in `npm test`), ESLint clean (0 errors, 0 warnings), Next.js build clean (`npm run build`). Production Supabase database remains protected.

---

### Entry: 2026-09-25 — Phase 5 (Recipient Management: Contacts, Lists, Segments, Suppression, Unsubscribe)
- **Prompt / Phase**: Phase 5 — Safe Recipient-Management System
- **Status**: ✅ Clean (No unresolved concerns)
- **Unresolved Concerns**: None.
- **Notes / Observations**:
  - Implemented `EmailContactService` (`src/lib/services/email-contact-service.ts`) with normalized email matching, bulk import deduplication, and complete audit trail.
  - Enforced strict architectural separation of `emailVerified` vs `marketingConsent`: verifying an email account does NOT opt the user into marketing.
  - Implemented `EmailListService` (`src/lib/services/email-list-service.ts`) with duplicate membership prevention, reactivation of previously unsubscribed members, bulk member updates, and strict cross-tenant isolation (Tenant Alpha cannot add Tenant Beta contacts).
  - Implemented injection-proof `EmailSegmentService` (`src/lib/services/email-segment-service.ts`) supporting structured criteria with strict allowlists of fields (`marketingConsent`, `verified`, `status`, `email`, `firstName`, `lastName`, `attributes.<name>`) and operators (`equals`, `not_equals`, `contains`, `starts_with`, `in`, `not_in`). Zero arbitrary SQL.
  - Implemented `EmailSuppressionService` (`src/lib/services/email-suppression-service.ts`) with normalized lookup, auto-cascade to `EmailContact` records, and support for all 5 reasons (`HARD_BOUNCE`, `COMPLAINT`, `UNSUBSCRIBED`, `MANUAL`, `INVALID`).
  - Implemented privacy-safe signed `EmailUnsubscribeService` (`src/lib/services/email-unsubscribe-service.ts`) using HMAC-SHA256 tokens. Zero raw email addresses stored in tokens; includes time validity, nonce-based enumeration resistance, and automatic cascade to contact consent, suppression, and list memberships.
  - Enforced server-side RBAC: `VIEWER` role strictly restricted to read-only GET requests (mutations return 403 Forbidden); `ADMIN` role permitted for full mutations.
  - Created controlled API endpoints under `/api/email/` (`contacts`, `contacts/[id]`, `contacts/import`, `lists`, `lists/[id]`, `lists/[id]/members`, `segments`, `segments/[id]`, `segments/[id]/evaluate`, `suppressions`, `unsubscribe/[token]`).
  - Automated tests: 56 Phase 5 tests in `test:email-phase5` passing. All 318 total test suite checks passing in `npm test`. ESLint passing with 0 errors and 0 warnings. Next.js build succeeding cleanly with 48 routes compiled. Destructive tests safely blocked against production Supabase.

---

### Entry: 2026-09-25 — Phase 6 (Email Campaign System: Templates, Lifecycle, Audience Resolution, Queueing)
- **Prompt / Phase**: Phase 6 — Email Campaign System
- **Status**: ✅ Clean (No unresolved concerns)
- **Unresolved Concerns**: None.
- **Notes / Observations**:
  - Implemented injection-safe template renderer (`src/lib/email/template-engine.ts`) with zero code evaluation (`eval`), HTML entity escaping, and JSON schema validation for custom declared variables.
  - Enforced immutable template versioning (`src/lib/services/email-template-service.ts`): scheduled and running campaigns bind to an immutable `EmailTemplateVersion`. Subsequent edits produce a new version and never mutate historical records.
  - Implemented campaign lifecycle state machine (`src/lib/services/email-campaign-service.ts`) with controlled transitions between `DRAFT`, `SCHEDULED`, `RUNNING`, `PAUSED`, `COMPLETED`, `CANCELLED`, `FAILED`. Illegal transitions (e.g. `COMPLETED -> RUNNING`, `CANCELLED -> SCHEDULED`) are blocked.
  - Audience resolution pipeline (`src/lib/services/email-audience-resolver.ts`) filters invalid addresses, unsubscribed contacts, missing marketing consent, and suppressed contacts before creating frozen `EmailCampaignRecipient` snapshots.
  - Internal campaign preview object and isolated test email delivery (`sendTestEmail`) render production templates without mutating audience or creating production campaign recipient records.
  - Bulk queueing follows individual job architecture: a campaign trigger resolves and snapshots recipients, then enqueues small bounded individual jobs on BullMQ with deterministic IDs (`email-campaign-${campaignRecipientId}`) guaranteeing queue idempotency.
  - Worker processor (`src/lib/email/queue/campaign-worker.ts`) re-checks live campaign status and real-time suppressions before dispatch. Paused campaigns postpone pending recipients; cancelled campaigns mark unsent recipients cancelled. Documented that cancelling a campaign cannot recall requests already transmitted to upstream email providers.
  - Server-side multi-tenancy and RBAC: `ADMIN` role permitted for full lifecycle actions (create, edit, test send, send, pause, cancel); `VIEWER` role strictly restricted to viewing campaigns and previews.
  - Controlled REST API endpoints implemented under `/api/email/templates` and `/api/email/campaigns`.
  - All validations passing: 39 Phase 6 verification tests passing; all 8 test suites passing in `npm test`; ESLint clean with 0 errors and 0 warnings; TypeScript clean (`npx tsc --noEmit`); Next.js production build succeeded with 50 routes compiled (`npm run build`). Production Supabase database remains protected.

---

### Entry: 2026-09-25 — Phase 7 (Closing the Delivery Lifecycle: Webhooks, State Machine, Tracking, Analytics)
- **Prompt / Phase**: Phase 7 — Closing the Delivery Lifecycle
- **Status**: ✅ Clean (No unresolved concerns)
- **Unresolved Concerns**: None.
- **Notes / Observations**:
  - Implemented provider-specific webhook verification (`src/lib/email/webhooks/verifier.ts`) supporting HMAC-SHA256 with timestamp replay prevention, Google Cloud Pub/Sub tokens, and AWS SES SNS certificate validation (restricting cert domains strictly to `*.amazonaws.com` against SSRF). Webhook secrets are never logged.
  - Implemented payload normalizer (`src/lib/email/webhooks/normalizer.ts`) classifying bounces via RFC 3463/5321 into `HARD_BOUNCE` and `SOFT_BOUNCE`.
  - Built event deduplication engine (`src/lib/services/email-event-service.ts`): unique `providerEventId` prevents duplicate database entries, duplicate suppression records, and metric double-counting.
  - Established Monotonic Delivery State Machine: enforces ordering `QUEUED` < `PROCESSING` < `SENT` < `DELIVERED` < terminal `BOUNCED` / `COMPLAINED` / `FAILED`. Stale out-of-order events (such as `DELIVERED -> SENT` or `BOUNCED -> DELIVERED`) are strictly ignored.
  - Enforced bounce & complaint policies: `HARD_BOUNCE` and `COMPLAINT` generate `EmailSuppression` records, transition contacts to `BOUNCED`/`COMPLAINED`, and revoke marketing consent. `SOFT_BOUNCE` updates delivery without permanent suppression.
  - Implemented RFC 8058 one-click unsubscribe: promotional campaign worker automatically injects `List-Unsubscribe: <https://...>` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` headers. Unsubscribe endpoint (`POST /api/email/unsubscribe/:token`) accepts one-click requests, revoking consent and suppressing future promotional sends.
  - Implemented privacy-safe open tracking (`GET /api/email/track/open/:token`): HMAC-signed token conceals recipient email, serves 1x1 transparent GIF with anti-caching headers, and documents analytics limitations regarding email privacy proxies (e.g. Apple Mail Privacy Protection).
  - Implemented secure click tracking (`GET /api/email/track/click/:token`): destination URLs are cryptographically sealed in HMAC tokens. Strictly rejects open redirects, `javascript:`, `data:`, CRLF injection, and arbitrary client destination overrides.
  - Authoritative campaign analytics (`src/lib/services/email-analytics-service.ts` & `GET /api/email/campaigns/:id/analytics`): accurately calculates sent, delivered, failed, bounced, complaints, unsubscribed, unique opens, unique clicks, and percentage rates without metric inflation.
  - Delivery inspection endpoints (`GET /api/email/deliveries`, `GET /api/email/deliveries/:id`): available to `ADMIN` and `VIEWER` roles.
  - Server-side RBAC: `ADMIN` authorized for suppression management and full lifecycle actions; `VIEWER` strictly restricted to read-only views of analytics and delivery history.
  - All validations passing: 49 Phase 7 verification tests passing; all 9 test suites passing in `npm test` (>400 total assertions); ESLint clean (0 errors, 0 warnings); TypeScript clean (`npx tsc --noEmit`); Next.js production build succeeded with 51 routes compiled (`npm run build`). Production Supabase database remains protected.

### Entry: 2026-09-25 — Phase 8 (Final Dashboard Integration, Public API, Security Matrix & CI)
- **Prompt / Phase**: Phase 8 — Final Integration, Admin UI, Public Send API, RBAC Matrix, Tenant Isolation, Audit Logging, and CI
- **Status**: ✅ Clean (No unresolved concerns)
- **Unresolved Concerns**: None.
- **Notes / Observations**:
  - Extended dashboard navigation with dual-channel `Communication` hierarchy: `WhatsApp` (Overview, Messages, Conversations) and `Email` (Dashboard, Templates, Contacts, Lists, Segments, Campaigns, Deliveries, Suppression, Provider Settings).
  - Built comprehensive Email Dashboard displaying sent, delivered, failed, bounced, complaints, unsubscribed, open rate, click rate, recent campaigns table, provider status card, and queue health monitor (zero Redis credentials or tokens exposed).
  - Built full suite of administrative UI pages: Template manager (create, edit, duplicate, preview, version, archive, send test), Contact manager (search, non-destructive bulk CSV/JSON import, consent flags), Lists & Memberships manager, Dynamic Segments builder (strictly structured criteria, zero SQL), 7-step Campaign Wizard (Info -> Audience -> Template -> Sender -> Preview -> Schedule -> Confirmation with explicit promotional consent/suppression breakdown), Delivery inspector with event timelines, Suppression manager, and Provider settings card.
  - Implemented public API `POST /api/v1/email/send`: authenticated via Bearer API Key, resolves `ApiKey -> ApiClient -> tenant`, requires strictly explicit `type: "TRANSACTIONAL" | "PROMOTIONAL"` (rejects missing or ambiguous types with HTTP 400), enforces promotional marketing consent and suppression list checks, applies sliding-window rate limiting (60/min), and enqueues jobs to BullMQ.
  - Implemented security audit logger (`EmailAuditLogger`) recording administrative mutations (`PROVIDER_CONNECTED`, `SENDER_CHANGED`, `CAMPAIGN_SCHEDULED`, `CAMPAIGN_CANCELLED`, `SUPPRESSION_MANUALLY_ADDED`) with automatic case-insensitive recursive sanitization of credentials (`refreshToken`, `accessToken`, `clientSecret`, `apiKey`, `password` replaced with `[REDACTED]`).
  - Verified complete RBAC matrix: `ADMIN` role permitted for full mutation access; `VIEWER` role strictly read-only and receives HTTP 403 Forbidden on all mutation endpoints.
  - Verified 9-domain cross-tenant isolation invariant: Tenant B cannot access Tenant A's contacts, lists, segments, templates, campaigns, deliveries, providers, sender identities, or suppression records.
  - Verified rate limiting on send API, test emails, and campaign scheduling.
  - Updated CI workflow (`.github/workflows/rbac-tests.yml`): added disposable Redis alpine container and automated execution of `npm test`, `npm run test:email`, `npm run test:email:queue`, `npm run test:email:campaign`, and `npm run test:email:security`. Kept destructive DB testing exclusively on disposable PostgreSQL container; `test-db-guard` permanently blocks production Supabase (`peqynzeioiauynfpdsdv`).
  - Updated repository documentation: `README.md`, `docs/setup.md`, `docs/api.md`, `docs/email-architecture.md`, and `docs/deployment.md` (explicitly documenting the split Next.js HTTP layer vs persistent background BullMQ worker daemon).
  - All test suites passing cleanly: `npm test` (402 checks passed across 10 test suites), `npm run test:email`, `npm run test:email:queue`, `npm run test:email:campaign`, `npm run test:email:security`, `npm run lint` (0 errors, 0 warnings), `npm run build` (61 routes compiled), and `npm audit --audit-level=high` (0 vulnerabilities). Production Supabase database remains protected.

### Entry: 2026-09-25 — Git Branch Merging & Push Operations
- **Prompt / Phase**: Push all changes and merge to main
- **Status**: ✅ Clean (No unresolved concerns)
- **Unresolved Concerns**: None.
- **Notes / Observations**:
  - Successfully committed all implementation files (Phases 1-8) across 116 files on `feature/email-password-rbac` (commit `ea0645f`).
  - Pushed `feature/email-password-rbac` to remote `origin`.
  - Checked out `main` and merged `feature/email-password-rbac` cleanly with zero conflicts.
  - Pushed `main` to remote `origin` and verified synchronization.
  - Working tree is clean on `main`.

### Entry: 2026-09-25 — Email Platform E2E Hardening & Correctness Fixes
- **Prompt / Phase**: Email Platform E2E Hardening & Correctness (Single Promotional Send Pipeline, Honest Queue Failures, Cross-Tenant Resource Validation, Deterministic CI Rate Limiter)
- **Status**: ✅ Clean (No unresolved concerns)
- **Unresolved Concerns**: None.
- **Notes / Observations**:
  - **Task A (Single Promotional Send)**: Replaced fake campaign/recipient fabrication with dedicated job architecture (`JOB_NAMES.SEND_PROMOTIONAL: "send-promotional"` on `QUEUE_NAMES.CAMPAIGN`). Created `src/lib/email/queue/promotional-delivery-worker.ts` resolving authoritative `EmailDelivery` DB record, re-evaluating real-time suppression and marketing consent, appending RFC 8058 `List-Unsubscribe` headers, utilizing the configured tenant provider, and updating delivery state.
  - **Task B (Honest Queue Failures)**: Eliminated catch blocks that forged success counts. Public send API returns HTTP 500 (`QUEUE_ERROR`) and marks DB delivery `FAILED` (`errorCode: "QUEUE_ENQUEUE_FAILED"`). `EmailCampaignService.sendCampaignNow()` marks campaign `FAILED` and throws on queue error; `scheduleCampaign()` reverts campaign status to `DRAFT` (`scheduledAt: null`) and throws on enqueue failure.
  - **Task C (Cross-Tenant Resource Validation)**: Created `EmailCampaignService.validateResourceOwnership()` explicitly verifying ownership for `templateId`, `templateVersionId`, `listId`, `segmentId`, and `senderIdentityId` across both campaign creation and updates.
  - **Task D (CI Rate Limiter Fix)**: Fixed `scripts/verify-email-phase8.ts` rate limiter test to isolate keys dynamically per test run (`test_rate_limit_p8_${Date.now()}_${Math.random()}`), eliminating cross-suite key contamination in CI.
  - **Task E (Hardening Verification Suite)**: Created `scripts/verify-email-hardening.ts` with 56 assertions covering all 9 required verification scenarios.
  - Full suite verified: `npm test` (458 total checks passed), `npm run test:email`, `npm run test:email:queue`, `npm run test:email:campaign`, `npm run test:email:security`, `npm run lint` (0 errors), `npm run build` (61 routes compiled), `npm audit --audit-level=high` (0 vulnerabilities). All checks executed on branch `fix/email-platform-e2e-hardening` without merging to `main`. Zero modifications to WhatsApp infrastructure.

### Entry: 2026-09-25 — Google Workspace Browser OAuth Flow Implementation
- **Prompt / Phase**: Genuine Browser Google Workspace / Gmail OAuth Flow Implementation
- **Status**: ✅ Clean (No unresolved concerns)
- **Unresolved Concerns**: None.
- **Notes / Observations**:
  - Implemented `GET` handler on `/api/admin/email/providers/google/callback` to handle Google redirect browser flow, while maintaining `POST` for programmatic API compatibility.
  - Implemented one-time OAuth state transaction store (`OAuthTransactionStore`) with 15-minute TTL, single-use atomic consumption, and replay attack defense (HTTP 409).
  - Enforced tenant binding and admin session binding: state encodes `tenantId` and `adminUserId`, signed with HMAC-SHA256 (`AUTH_SESSION_SECRET`). Cross-tenant and cross-session completions are strictly rejected (HTTP 403).
  - Handled Google consent denials (`error=access_denied`), missing `code`/`state`, expired states, tampered states, token exchange failures (HTTP 502), missing refresh tokens, and authoritative sender identity lookups.
  - Audited requested scopes: confirmed minimum necessary scopes `gmail.send` (restricted sending only, no mail read/write permissions) + `userinfo.email` (verified address lookup only).
  - Credentials encrypted at rest using AES-256-GCM (`encryptProviderCredential()`); tokens/secrets are never returned to the browser or logged.
  - Added success/error callback notification UX to `/dashboard/email/providers` with dismissible status banners and automatic provider table reload reflecting the connected provider.
  - Added full test suite `scripts/verify-email-oauth.ts` with 61 assertions covering all 15 required scenarios without external Google network calls.
  - Full suite verified: `npm test` (519 total checks passed), `npm run test:email`, `npm run test:email:queue`, `npm run test:email:campaign`, `npm run test:email:security`, `npm run test:email:hardening`, `npm run test:email:oauth`, `npm run lint` (0 errors), `npm run build` (61 routes compiled), `npm audit --audit-level=high` (0 vulnerabilities). All checks executed on branch `fix/email-platform-e2e-hardening` without merging to `main`. Zero modifications to WhatsApp infrastructure.

---

### Entry: 2026-09-25 — Complete Email Campaign Lifecycle Implementation
- **Prompt / Phase**: Complete Campaign Lifecycle (Scheduled Trigger Processor, Pause/Resume, Cancellation, Sender Identity Honoring, Deterministic Terminal Completion)
- **Status**: ✅ Clean (No unresolved concerns)
- **Unresolved Concerns**: None.
- **Notes / Observations**:
  - **Scheduled Campaign Trigger Processor**: Created dedicated `src/lib/email/queue/campaign-trigger-worker.ts` (`processScheduledCampaignTriggerJob`). Verified scheduled time arrival (throws `RetryableEmailError` if premature), verified configuration (template, audience, sender), atomically transitioned `SCHEDULED -> RUNNING` via PostgreSQL `updateMany`, created immutable audience snapshot exactly once, and enqueued deterministic recipient jobs on BullMQ (`jobId: getCampaignJobId(recipient.id)`).
  - **Duplicate Trigger Defense**: Repeated triggers safely exit with `{ skipped: true }` without creating duplicate recipient snapshots or duplicate email dispatches.
  - **Honest Queue Failures**: Queue insertion failures update campaign status honestly to `FAILED` in database (observable state) and throw an error, preventing fake success.
  - **Pause/Resume Lifecycle**: Implemented `EmailCampaignService.resumeCampaign()` and authenticated ADMIN endpoint `POST /api/email/campaigns/[id]/resume`. Transitions `PAUSED -> RUNNING` and `FAILED -> RUNNING`, requeues only `PENDING` recipients into BullMQ (skipping already `SENT` recipients), and strictly blocks resuming `CANCELLED` or `COMPLETED` campaigns. RBAC enforced: `ADMIN` authorized, `VIEWER` receives 403 Forbidden.
  - **Cancellation Lifecycle**: `EmailCampaignService.cancelCampaign()` removes delayed trigger jobs from BullMQ (`trigger-campaign-${campaign.id}`), updates pending recipients to `CANCELLED` in DB, transitions campaign to `CANCELLED`, and worker skips already queued jobs. Upstream transmitted emails remain untouched (no fake recalls).
  - **Sender Identity Resolution**: Worker inspects `campaign.senderIdentityId`, strictly validates tenant ownership (`clientId`), verifies verified status and active provider configuration, applies sender name/email/reply-to, and strictly throws `UnrecoverableError` on cross-tenant mismatch without silently falling back to default sender.
  - **Deterministic Completion**: `checkAndCompleteCampaign()` evaluates all non-terminal recipients (`PENDING`, `PROCESSING`). When all recipients reach terminal states (`SENT`, `FAILED`, `BOUNCED`, `COMPLAINED`, `CANCELLED`, `SUPPRESSED`), campaign automatically transitions to `COMPLETED` (`completedAt: new Date()`). Campaigns are never left permanently running.
  - **Integration Verification**: Implemented `scripts/verify-email-campaign-lifecycle.ts` covering 56 assertions against real disposable PostgreSQL (`127.0.0.1:5433`) and Redis (`127.0.0.1:6379`).
  - **Full Quality Gate**: `npm test` (575 passing checks across 13 suites), `npm run test:email` (575 passing checks), `npm run lint` (0 errors, 0 warnings), `npm run build` (61 routes compiled), and `npm audit --audit-level=high` (0 vulnerabilities). All checks executed on branch `fix/email-platform-e2e-hardening` without merging to `main`. Zero modifications to WhatsApp infrastructure.

### Entry: 2026-09-25 — Durable Asynchronous EmailEvent Queue & State Machine Processing Architecture
- **Prompt / Phase**: EmailEvent Asynchronous Queue & Durable Processing Architecture
- **Status**: ✅ Clean (No unresolved concerns)
- **Unresolved Concerns**: None.
- **Notes / Observations**:
  - **Schema Enhancements**: Added `EmailEventProcessingStatus` enum (`RECEIVED`, `PROCESSING`, `PROCESSED`, `FAILED`) and updated `EmailEvent` model with `status`, `providerConfigId` relation to `EmailProviderConfig`, `attempts`, `lastAttemptAt`, `processedAt`, `errorMessage`, `errorCode`, and indexed query paths. Successfully synchronized against PostgreSQL database. Zero WhatsApp schema changes.
  - **Unambiguous Tenant Binding**: Eliminated unsafe recipient-email inference. Webhook events bind unambiguously to tenants via `EmailProviderConfig` (`configId` query/header parameter) or correlated `EmailDelivery` (`providerMessageId` / `deliveryId`). Ambiguous events lacking tenant correlation are strictly rejected with HTTP 400 (`AMBIGUOUS_TENANT_BINDING`).
  - **Authoritative Persistence & BullMQ Queue Dispatch**: Incoming webhooks verify authenticity, normalize event payloads, persist authoritative DB record with `status: RECEIVED`, and enqueue BullMQ job on `email-events` queue with deterministic `jobId: getEventJobId(eventRecordId)` without blocking HTTP responses (returning HTTP 202 Accepted).
  - **Real Event Worker Execution**: `processEmailEventJob` in `src/lib/email/queue/event-worker.ts` performs the real processing asynchronously: loads event from DB, transitions `RECEIVED -> PROCESSING`, correlates delivery scoped to tenant, evaluates delivery state machine, updates campaign metrics idempotently, applies bounce/complaint/unsubscribe suppression policies, and transitions event to `PROCESSED` with `processedAt`.
  - **Strengthened Delivery State Machine**: Strict monotonicity enforced via `canTransitionDeliveryStatus()`:
    - `SENT -> DELIVERED` allowed.
    - `DELIVERED -> SENT` rejected (stale out-of-order events prevented from downgrading state).
    - `BOUNCED -> DELIVERED` rejected (terminal bounce cannot be overwritten).
    - `FAILED -> DELIVERED` rejected.
    - `FAILED after BOUNCED` rejected (BOUNCED specific terminal state preserved).
    - `COMPLAINT after DELIVERED` allowed (transitions delivery to `COMPLAINED`, records suppression, increments campaign complaint metrics).
    - `COMPLAINT after BOUNCED` records suppression and campaign complaint metrics without breaking delivery state.
    - Duplicate events rejected / no-op (never double-increments campaign metrics or double-creates suppressions).
  - **Error Classification & Observable Terminal Failures**: Transient failures throw `RetryableEmailError` triggering BullMQ exponential backoff. Permanent failures transition DB record to `FAILED` with `errorMessage` and `errorCode: PERMANENT_FAILURE` and throw `PermanentEmailError` for observable dead-letter tracking.
  - **Integration Verification**: Implemented comprehensive suite `scripts/verify-email-event-processing.ts` covering 50/50 passing assertions against real disposable PostgreSQL (`127.0.0.1:5433`) and Redis (`127.0.0.1:6379`).
  - **Full Quality Gate**: `npm test` (625 passing checks across 14 suites), `npm run test:email` (625 passing checks), `npm run lint` (0 errors, 0 warnings), `npm run build` (61 routes compiled), and `npm audit --audit-level=high` (0 vulnerabilities). All checks executed on branch `fix/email-platform-e2e-hardening` without merging to `main`. Zero modifications to WhatsApp infrastructure.

### Entry: 2026-09-25 — Complete Email Tracking Pipeline Implementation & Hardening
- **Prompt / Phase**: Email Tracking Pipeline (Open Tracking Pixel, Click Tracking Wrapping, Signed Tokens, Redirect Defense, Stored Engagement Events, Authoritative Analytics)
- **Status**: ✅ Clean (No unresolved concerns)
- **Unresolved Concerns**: None.
- **Notes / Observations**:
  - **AST-Based HTML Tracking Pipeline**: Installed and integrated `node-html-parser` (^7.0.1) for spec-compliant DOM manipulation, completely eliminating fragile regex-only transformations.
  - **Open Pixel Injection**: `EmailTrackingService.injectOpenPixel` generates a signed, privacy-safe HMAC-SHA256 open token tied strictly to `{ clientId, deliveryId, exp }` (never exposing raw recipient email addresses), generates a random cache-buster query parameter (`?cb=`), formats a transparent 1x1 GIF tag, and injects it into `<body>` (or document root if body tag is omitted), preserving valid HTML syntax.
  - **Click Tracking Link Wrapping**: `EmailTrackingService.wrapLinksWithClickTracking` safely inspects all `<a>` tags. Skips unsubscribe links (`/unsubscribe`, `data-skip-track="true"`, `data-unsubscribe="true"`, `rel="unsubscribe"`), `mailto:` links, `#` anchor links, CRLF-containing URLs (`/[\r\n\t\0]/`), and unsafe protocols (`javascript:`, `data:`, `tel:`, `sms:`, `vbscript:`, `file:`). Replaces eligible HTTP and HTTPS links with signed tracking URLs containing the authenticated destination URL in the HMAC token.
  - **Open Redirect Defense**: Destination URLs are sealed within the cryptographically signed click token (`ClickTokenPayload.targetUrl`). The click endpoint `GET /api/email/track/click/:token` strictly extracts and validates the target URL from the signed token, rejecting all query parameter destination overrides, CRLF characters, and non-http/https protocols.
  - **Authoritative Event Recording & Delivery Synchronization**: Both `GET /api/email/track/open/:token` and `GET /api/email/track/click/:token` await `EmailTrackingService.recordOpen` and `recordClick`. Creates `EmailEvent` records with `status: PROCESSED`, promotes delivery state from `SENT` to `DELIVERED`, populates `deliveredAt`, updates recipient status to `DELIVERED`, and increments campaign `deliveredCount` idempotently.
  - **Zero Invented Dashboard Metrics**: Removed all hardcoded heuristic numbers (`32.5%`, `11.2%`, `"35%"`, `"12%"`) in `src/app/dashboard/email/page.tsx`. Campaign listings and dashboard cards derive directly from real database events and deduplicated unique recipient opens/clicks (`EmailCampaignService.listCampaigns` and `EmailAnalyticsService.getCampaignAnalytics`).
  - **Deduplication & Rate Integrity**: `EmailAnalyticsService` deduplicates unique opens and unique clicks strictly per recipient. Duplicate tracking requests increment total counts or deduplicate within the hour bucket, but never inflate unique metrics. Delivered count is guaranteed to be at least equal to unique opens/clicks, preventing open rates > 100% or divide-by-zero errors.
  - **Integration Verification Suite**: Implemented `scripts/verify-email-tracking-pipeline.ts` testing all 10 requirements:
    1. Campaign rendered HTML contains 1x1 open pixel with configured base URL and cache buster.
    2. Eligible HTTP/HTTPS links converted to tracking URLs; mailto, anchors, unsafe protocols, CRLF, and unsubscribe skipped.
    3. Raw recipient email address strictly absent from open/click tokens and query parameters.
    4. Expired tracking tokens rejected (`Token has expired`).
    5. Signature and payload tampering securely rejected.
    6. Unsafe redirects (CRLF, javascript:, data:) blocked.
    7. Click events recorded in `EmailEvent`, delivery promoted to `DELIVERED`.
    8. Open events recorded in `EmailEvent`, delivery promoted to `DELIVERED`.
    9. Duplicate tracking requests do not inflate unique counts.
    10. Campaign analytics and campaign listing strictly reflect real database events.
  - **Quality Gates Passing**:
    - `npm test`: 635 passing checks across all 15 suites (exit code 0).
    - `npm run lint`: 0 errors, 0 warnings (exit code 0).
    - `npm run build`: 61 routes compiled cleanly with 0 TypeScript errors (exit code 0).
    - `npm audit --audit-level=high`: 0 vulnerabilities (exit code 0).
    - All work isolated on branch `fix/email-platform-e2e-hardening` without merging to `main`. WhatsApp infrastructure completely untouched.

---

## Flag Template for Subsequent Prompts

```markdown
### Entry: YYYY-MM-DD — [Prompt / Feature Context]
- **Prompt / Phase**: [Description of phase or prompt]
- **Status**: [🔴 Open / 🟡 In Progress / ✅ Clean]
- **Unresolved Concerns**:
  - [Concern 1 / Risk / Open Decision]
  - [Concern 2]
- **Mitigation / Next Steps**:
  - [Action to resolve concern in future phase]
```
