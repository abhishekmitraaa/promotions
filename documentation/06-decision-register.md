# WhatsApp Hub — Consolidated Decision Register

> ## Status update — 12 October 2026 (after the code-review fixes)
>
> The register below was compiled from evidence up to commit `598b612` and telemetry from 10 Oct 2026 22:33 UTC. Two later code commits (`c5ccaf9`, `1509601`) and the 12 Oct review fixes (uncommitted in the working tree at the time of writing; see [02-code-review-2026-10-12.md](02-code-review-2026-10-12.md)) change several items. The original register follows unchanged.
>
> **Open items now resolved**
>
> | Register item | Resolution |
> |---|---|
> | §4 "queue architecture question", §14.1 (two paths for one delivery) | `c5ccaf9` added conditional atomic claims on the delivery/recipient/event row itself. The 12 Oct fixes then closed the gaps the review found: FAILED terminal, token-bound writes, existing-delivery check before campaign sends, in-flight send marker. Covered by `scripts/verify-cross-path-concurrency.ts` (54 assertions) |
> | Q-15, §14.2 (reconciliation errors hidden) | `c5ccaf9`: `reconcileJobs` returns a report with `error`, and `processAll` sets `success:false`. The 12 Oct fix also makes the HTTP endpoint return **500** in that case (review #11) |
> | SEC-05 (stale `x-processor-secret` comment) | Comment corrected 12 Oct |
> | §9 "do not rely on an in-process Map for rate limiting" | 12 Oct: without `REDIS_URL` the limiter uses the PostgreSQL `RateLimit` table (shared across instances). Auth/OTP limits fail closed instead of falling back to memory |
> | Q-16 (supported vs legacy BullMQ boundary) | 12 Oct: workerless is the default. BullMQ runs only with an explicit `WORKERLESS_MODE=false` **and** a `REDIS_URL` (review #12) |
>
> **Decisions added 12 October 2026**
>
> | ID | Decision | Rationale |
> |---|---|---|
> | D-12-01 | A send interrupted mid-provider-call is **never retried automatically**. It becomes `FAILED / SEND_OUTCOME_UNKNOWN` for manual review | Gmail has no idempotency key, so a re-send could duplicate. At-most-once for crashes; ambiguous provider timeouts are still retried (at-least-once) |
> | D-12-02 | `FAILED` is terminal for `EmailDelivery`, `EmailCampaignRecipient` and `EmailEvent`. Retryable errors re-queue (`QUEUED` / `PENDING` / `RECEIVED`) instead | One unambiguous meaning per status; permanent rejections are never re-sent |
> | D-12-03 | Every write after a claim filters on the current lock token | A worker that lost its lock cannot overwrite the new owner |
> | D-12-04 | Waiting on another holder (contention yield, campaign pause) does not consume an attempt | Attempts measure real failures only |
> | D-12-05 | Lock conventions live in one module, `src/lib/services/executors/claim-lock.ts` (`STALE_LOCK_MS` = 10 min) | Removes 7+ diverging copies |
> | D-12-06 | Processor endpoints return HTTP 500 with `success:false` when any category reports an error | Makes `net._http_response` a real health signal (§12 item 9) |
> | D-12-07 | Public links use `NEXT_PUBLIC_APP_URL` if set, else `APP_URL`; no hard-coded fallback domains | Unsubscribe (RFC 8058) and tracking links must point to the real host |
> | D-12-08 | Prisma transient errors (P1001, P1002, P1008, P1017, P2024, P2034) are retryable | A database blip must not permanently fail a send |
> | D-12-09 | The Google OAuth GET callback takes client credentials from the environment only | Secrets must not appear in URLs or logs |
> | D-12-10 | The hub serves **one owner project**. Multi-tenant features stay but only one `ApiClient` is expected; the campaign/automation engine is optional | Keeps the go-live scope to WhatsApp, OTP and transactional email (see [03-go-live-checklist.md](03-go-live-checklist.md)) |
>
> **Still open:** §14.3 (no real production traffic yet), §14.4 (Gmail is the only real email adapter), §14.5 (admin DB role vs RLS), §14.6 (timeouts under load), §14.7 (all telemetry here predates 12 Oct and must be re-queried).

---

**Purpose:** One reference for the product, architecture, implementation, security, operations, testing, and deployment decisions documented for WhatsApp Hub / the unified communication platform.

**Repository:** <https://github.com/abhishekmitraaa/promotions>  
**Production host:** <https://promotions-lime.vercel.app>  
**Supabase project:** `peqynzeioiauynfpdsdv` — PostgreSQL 17, Mumbai (`ap-south-1`)  
**Latest code commit independently inspected in this audit trail:** [`598b6126597e63c39851e9be94d315a53745f3c0`](https://github.com/abhishekmitraaa/promotions/commit/598b6126597e63c39851e9be94d315a53745f3c0)  
**Associated CI run:** [GitHub Actions #38090328205](https://github.com/abhishekmitraaa/promotions/actions/runs/38090328205)  
**Document compiled:** 12 October 2026

> **Scope and evidence note:** This register consolidates decisions and implementation claims documented in the available project handoff, master-prompt/re-verification document, and the uploaded certification reports. The reports reflect successive stages of the project, so older decisions and statuses are marked as historical or superseded where appropriate. A decision marked “implemented” means it is documented in source or was verified in the referenced audit; it does not mean every real-provider workflow has been exercised with live customer traffic. Operational telemetry noted below was last independently queried in this conversation at approximately **10 October 2026 22:33 UTC** and should be refreshed before relying on it as today's status.

---

## 1. Executive Summary — Decisions at a Glance

1. **Product direction:** Build WhatsApp Hub as a multi-tenant communication backend and administration console that other applications can call through a secured API.
2. **Channel strategy:** Keep the existing WhatsApp implementation intact and add Email; expose a common multi-channel interface intended to accommodate SMS and push as well.
3. **Current hosting/data direction:** Use Vercel for the Next.js application and Supabase PostgreSQL as the authoritative persistent database. Earlier local SQLite/Netlify arrangements are historical, not the current reported production architecture.
4. **Production background processing:** Use a workerless/serverless processing path: Supabase Cron (`pg_cron`) triggers short-lived Vercel HTTP POST requests through `pg_net`; durable job state lives in PostgreSQL. A permanently running worker is not the intended dependency of the production workerless path.
5. **Scheduling:** `process-email-jobs` runs every minute; `reconcile-email-jobs` runs every five minutes. Both obtain the internal credential dynamically from Supabase Vault.
6. **Internal authentication:** Require Bearer-only machine authentication using `INTERNAL_PROCESSOR_SECRET`; compare secrets with a timing-safe routine; reject GET and keep manual processing behind admin RBAC.
7. **Runtime/performance:** Reuse one Prisma client across warm serverless invocations, run independent workload stages in bounded parallelism, use Mumbai (`bom1`) for the two processor routes, and set a 60-second function maximum where supported. The processor's internal work budget is shorter than that deployment maximum.
8. **Durability and concurrency:** Use PostgreSQL-backed job records, atomic claims with `FOR UPDATE SKIP LOCKED`, bounded batches, retries, deduplication, deadlines, and safe release of work that was claimed but not started.
9. **Security and tenant model:** Use `clientId` tenant ownership, tenant-scoped references, server-side provider credentials, database constraints, role-based admin controls, webhook signature validation, SSRF checks, suppression/consent safeguards, and tests isolated from production.
10. **Provider reality:** Gmail/Google Workspace is the implemented production email adapter in the inspected handoff. The provider interface is extensible, but SES/SMTP and every real SMS/push integration must not be assumed production-ready unless separately verified.
11. **Testing policy:** Use disposable PostgreSQL/Redis and mocked providers for destructive and end-to-end tests. Do not send real customer communications as part of tests.
12. **Certification boundary:** Code/CI and idle processor health are not equivalent to proof of real production throughput. The latest documented live queue counts were zero, so actual non-empty production processing remained partially verified.

---

## 2. Product and Scope Decisions

| ID | Decision | Rationale / intended effect | Status / caveat |
|---|---|---|---|
| P-01 | Treat WhatsApp Hub as a reusable communication infrastructure platform, not merely a WhatsApp UI. | External applications authenticate to the platform and use its API for outbound communications and delivery status. | Product direction documented. |
| P-02 | Preserve the existing WhatsApp pipeline while adding Email additively. | Email work should not replace or break existing WhatsApp API contracts, message persistence, webhook ingestion, OTP, or status handling. | Documented design constraint. |
| P-03 | Use a shared provider-neutral communication interface for Email, WhatsApp, SMS and Push. | Allow common send/dispatch contracts and future channel adapters. | SPI reported implemented; production readiness of each real provider must be verified independently. |
| P-04 | Maintain separate channel-specific state and provider behavior beneath the unified interface. | Channels have different provider APIs, delivery receipts, rate limits, payload models and retry behavior. | Architectural decision. |
| P-05 | Provide an administration surface for configuration and governance. | Manage API clients/keys, users/roles, providers, contacts, campaigns, deliveries, events, webhooks and operational state. | Dashboard scope implemented in source; external provider setup still requires operational configuration. |
| P-06 | Do not add in-app commerce/payment to the communication module as a prerequisite. | The module's job is communication orchestration and provider integration, not payment settlement. | Inferred from documented scope; no payment-related requirement in the certification reports. |

## 3. Application, Hosting and Database Decisions

| ID | Decision | Implementation detail | Status / caveat |
|---|---|---|---|
| INF-01 | Use Next.js App Router with TypeScript for the application/API layer. | Public API, internal processing route, admin route, dashboard and webhook endpoints are served from the same application. | Current repository decision. |
| INF-02 | Use Prisma as the data access/ORM layer. | Prisma schema and migrations define application entities and relational constraints. | Current repository decision. |
| INF-03 | Use Supabase PostgreSQL as production source of truth. | Queue state, delivery state, tenant data, events and migrations are persisted in PostgreSQL. | Current reported production database. Earlier SQLite references are historical. |
| INF-04 | Host the current application on Vercel. | Production host is `promotions-lime.vercel.app`. | Current reported host; deployment identity must match the intended Git commit on each release. |
| INF-05 | Keep the database in the Mumbai Supabase region (`ap-south-1`). | This is the existing production database location. | Verified in project metadata in previous audits. |
| INF-06 | Co-locate processing functions in Mumbai (`bom1`) where the plan supports it. | The current `vercel.json` config targets `bom1` for `/api/internal/process-jobs` and `/api/admin/jobs/process`. | Implemented in commit `598b612…`; recheck the active deployment and supported region. |
| INF-07 | Reuse a global Prisma client in warm serverless containers. | `globalForPrisma.prisma = prisma` is assigned unconditionally to avoid recreating clients unnecessarily. | Implemented in `src/lib/prisma.ts`; pooling benefits should be observed in production telemetry. |
| INF-08 | Track database evolution through committed Prisma migrations. | Use repeatable, source-controlled migrations rather than relying on untracked manual schema drift. | Intended practice; every production migration still needs its own application/verification evidence. |
| INF-09 | Do not blindly enable RLS or change grants to silence an advisor. | Understand the table owner, runtime role, policies and migration requirements first. | Security decision; current application reportedly uses administrative database credentials that can bypass RLS. |

### Historical deployment transition

Earlier handoff artifacts described a local SQLite database and a Netlify deployment. The later/current operational reports describe Vercel plus Supabase PostgreSQL. Treat the older stack statements as historical context, not as the current production topology.

---

## 4. Background Processing and Durable Queue Decisions

| ID | Decision | Implementation detail | Status / caveat |
|---|---|---|---|
| Q-01 | Use the workerless/serverless processor for the intended production path. | Supabase Cron sends HTTP POST requests to the Vercel internal route; no always-on worker is required for this path. | Current architecture direction. Legacy BullMQ dependencies and worker code still exist, so do not claim BullMQ has been completely removed. |
| Q-02 | Keep job state durable in PostgreSQL. | `BackgroundJob` stores queued work, availability/scheduling, attempts, lock fields, deduplication and terminal status. | Implemented in source/migrations per reports. |
| Q-03 | Treat database state as authoritative, rather than relying on in-memory jobs. | Serverless restarts must not lose jobs or retries. | Core architecture decision. |
| Q-04 | Use a bounded one-minute processing sweep. | Cron job `process-email-jobs` uses `* * * * *`. | Current Supabase Cron job ID 4 in the last inspected state. |
| Q-05 | Run reconciliation every five minutes. | Cron job `reconcile-email-jobs` uses `*/5 * * * *` and targets the processor with `?reconcile=true`. | Current Supabase Cron job ID 5 in the last inspected state. |
| Q-06 | Use `pg_net` to invoke Vercel and `pg_cron` to schedule it. | HTTP request commands are stored in Supabase Cron definitions. | Implemented in live infrastructure according to the reports. |
| Q-07 | Fetch the processor secret dynamically from Supabase Vault. | Cron SQL reads the `internal_processor_secret` entry at invocation time and uses a Bearer header. | Implemented in live SQL as last inspected; never print the decrypted value. |
| Q-08 | Require atomic job claims with PostgreSQL locking. | `SELECT … FOR UPDATE SKIP LOCKED` is used in claim statements so overlapping processors do not claim the same row in the same queue. | Implemented and tested in isolated environments. Claims across different tables do not automatically prevent two different workflows from operating on the same logical delivery. |
| Q-09 | Use fair bounded dispatch. | Background job selection ranks by tenant, caps the tenant's share of a sweep, and bounds the total batch size. | Implemented in source per report. |
| Q-10 | Keep processor work bounded by time and batch size. | The internal budget is 25 seconds for a normal sweep and 35 seconds when reconciliation is requested; category checks aim to avoid starting work near the deadline. | Implemented in source per latest report; confirm the effective Vercel runtime maximum separately. |
| Q-11 | Release claimed but unstarted work safely before the deadline. | Return unstarted jobs/records to their queued/pending state and clear claim fields; decrement attempts where applicable. | Reported covered by workerless tests. Must not reset an operation already running or completed. |
| Q-12 | Use retry classification and persisted backoff. | Retry transient provider/network/rate-limit failures; mark permanent validation/configuration failures terminal; cap attempts. | Implemented across services according to handoff and test reports. |
| Q-13 | Keep queue-health features available in workerless mode. | `WorkerlessQueueAdapter` implements `getJobCounts`, `getFailed`, `clean`, `drain`, `isPaused`, `pause` and `resume` using PostgreSQL state. | Implemented in source per certification. The adapter still shares a BullMQ-shaped interface. |
| Q-14 | Keep processing categories in bounded stages rather than one long serial chain. | Reported stages: (1) webhooks + `BackgroundJob`; (2) scheduled campaigns + recurring automations; (3) email events + automation enrollments; (4) transactional `EmailDelivery` sweep + campaign recipients; (5) reconciliation only when requested. | Implemented in `processAll()` per commit `598b612…`. Verify that supposedly disjoint work cannot act on the same logical delivery. |
| Q-15 | Surface database and processing errors; do not fake an empty queue. | Claim failures should produce explicit error telemetry instead of silently returning zero work. | Regression coverage reported. One reconciliation path in the inspected source catches errors and returns `null`; this should be reviewed because the overall success calculation may not include that error. |
| Q-16 | Maintain a persistent worker only if an explicitly supported deployment mode requires it. | `worker:email` and BullMQ support remain in `package.json`/queue code. | Open compatibility/cleanup decision: workerless is the production intent, but legacy BullMQ path is not fully deleted. |

### Important queue architecture question still to track

`processBackgroundJobs()` can route email-related `BackgroundJob` types to `EmailDeliveryExecutor`, while a separate category sweep directly claims transactional rows from `EmailDelivery`. Although these queries lock different tables, both workflows can potentially target the same logical delivery. This is an **open correctness check**, not proof that duplicates have occurred. Keep a single authoritative claim path per logical delivery, or prove through a robust atomic state transition and concurrency test that the paths cannot both send it.

---

## 5. Processor Runtime and Performance Decisions

| ID | Decision | Implementation detail | Status / caveat |
|---|---|---|---|
| RT-01 | Set an explicit function duration for the processing routes. | `export const maxDuration = 60` is present in the internal and admin processing routes; `vercel.json` also sets `maxDuration: 60` for those paths. | Implemented in source. Whether the effective limit is accepted by the active Vercel plan/runtime must be verified in the dashboard/deployment. |
| RT-02 | Force the processing routes to run dynamically. | Routes export `dynamic = "force-dynamic"`. | Implemented in source. |
| RT-03 | Use the Mumbai function region for database-bound processing. | `regions: ["bom1"]` is configured for internal and admin processing functions. | Implemented in `vercel.json`; independently confirm the deployed function region. |
| RT-04 | Reuse database clients and avoid repeated connections in warm containers. | Global Prisma client caching. | Implemented; it does not guarantee a connection itself is always warm. |
| RT-05 | Measure individual category time, not only total execution. | `timingBreakdownMs` covers webhooks, background jobs, transactional emails, campaigns, recipients, recurring automations, enrollments, events and reconciliation. | Live payloads showed this telemetry after the optimization commit. |
| RT-06 | Use a five-second internal safety buffer within a shorter processor budget. | `processAll()` currently defaults to 25,000 ms, or 35,000 ms with reconciliation, with a safety buffer capped at 5,000 ms. | Implemented in inspected source; workload duration still needs monitoring as real jobs arrive. |
| RT-07 | Keep independent category calls in bounded parallel stages. | Four concurrent stages were introduced to reduce idle latency without parallelizing all work indiscriminately. | Reported and source-verified. Must retain tests for shared resources, claims and cross-category dependencies. |
| RT-08 | Judge performance from measured timings, not estimates. | Before optimization, idle sweeps took roughly 8.5–8.5 seconds and reconciliation overlaps roughly 12–13.4 seconds. After the optimization, reported live responses were 124–271 ms. | The latest independently queried database snapshot in this audit showed 29 post-optimization responses at 21–271 ms, average 65.8 ms; latest 15-minute window had 18/18 HTTP 200 responses and no timeouts as of 10 Oct 2026 22:33 UTC. This is a historical snapshot, not a fresh 12 Oct measurement. |
| RT-09 | Do not equate idle latency with batch capacity. | Empty queues exercise queries/claims but not real provider send latency or large batches. | Ongoing operational decision; production non-empty workload has not been independently observed in the recorded snapshots. |

---

## 6. Authentication, Authorization and Secret-Handling Decisions

| ID | Decision | Implementation detail | Status / caveat |
|---|---|---|---|
| SEC-01 | Public programmatic clients authenticate with API keys. | Bearer API keys are generated with high entropy and validated using peppered HMAC-SHA256 hashing. | Documented implementation. |
| SEC-02 | Dashboard users authenticate with email/password and server-side sessions. | Passwords use scrypt; sessions are database-backed and signed; session expiry and invalidation are implemented. | Documented in source/handoff. |
| SEC-03 | Keep `ADMIN` and `VIEWER` roles distinct. | Only administrators may perform manual job processing or sensitive configuration actions. | Verified in code and earlier live endpoint checks. |
| SEC-04 | Protect the last administrator. | Last-admin removal/role changes require concurrency-safe checks. | Reported as implemented in auth hardening. |
| SEC-05 | Internal Cron authentication is Bearer-only. | `Authorization: Bearer <INTERNAL_PROCESSOR_SECRET>` with timing-safe comparison; no `x-processor-secret` or `x-worker-secret` fallback in request handling. | Verified in the inspected route. Its source comment still mentions an obsolete `x-processor-secret` header and should be corrected. |
| SEC-06 | Reject unauthenticated/incorrect processor requests predictably. | Missing credentials: 401; invalid Bearer credential: 403; GET: 405; absent server secret: 500 fail-closed error. | Actual production endpoint behavior was reported/tested. |
| SEC-07 | Never store secrets plaintext in source, logs or job payloads. | Vercel secret is matched to the Vault-held credential; provider credentials are encrypted at rest and sanitized in logs. | Security policy. Never include secret values in reports. |
| SEC-08 | Keep manual processing separate from machine-to-machine processing. | `/api/admin/jobs/process` is protected by `requireUser(req, "ADMIN")`; internal route accepts only machine Bearer authentication. | Implemented and tested per latest report. |
| SEC-09 | Use production DB safety gates for destructive tests. | Test guards reject production Supabase and require explicitly disposable database settings. | Latest report records 16/16 safety cases passed. |
| SEC-10 | Do not use zero security-advisor findings as sole proof of security. | Pair advisor output with policy review, grants, tenant-boundary tests and application credential analysis. | Required audit principle. |

---

## 7. Tenant Isolation, Database and RLS Decisions

1. **`clientId` is the central tenant ownership key.** Tenant-owned providers, sender identities, contacts, lists, segments, templates, campaigns, recipients, deliveries, events and suppression data must be scoped accordingly.
2. **Use relational constraints to enforce valid parent-child relationships.** In particular, `BackgroundJob.clientId` references `ApiClient.id`; test fixtures must create valid parents rather than bypassing the foreign key.
3. **Never infer event tenancy from recipient email alone.** Bind an event using provider configuration, an explicit tenant, or an authoritative correlated delivery; reject ambiguous ownership.
4. **RLS is enabled on the key internal/email tables** listed in the latest report: `BackgroundJob`, `EmailCampaign`, `EmailCampaignRecipient`, `EmailDelivery`, `EmailDomain`, `EmailEvent` and `WebhookDelivery`.
5. **The inspected application connection uses administrative PostgreSQL credentials**, reportedly through PgBouncer. Such credentials may bypass RLS, so application-tier tenant filtering and authorization are part of the trust boundary. RLS on its own does not prove tenant isolation for a superuser connection.
6. **Untrusted roles should have no direct grants** on internal job and Prisma migration tables. Verify grants carefully, especially around `_prisma_migrations`; do not blindly alter its RLS or privileges.
7. **Test tenant fixtures must be explicit and disposable.** The `tenant-alpha`/`tenant-beta` regression was addressed by creating `ApiClient` fixtures in the phase-7 test harness and cleaning them up in a `finally` block against a disposable database.
8. **Tenant boundary tests are required.** The report states that cross-tenant cases passed in its adversarial suite; they need to stay in CI as the schema and API evolve.

**Status caveat:** The last recorded Supabase security advisor query returned zero lints. That is useful evidence, but not a substitute for testing all application paths or checking the current state again.

---

## 8. Email Domain and Messaging Lifecycle Decisions

### 8.1 Email model and provider configuration

- Keep email as an additive domain within the existing communication platform.
- Use tenant-scoped models for provider configs, sender identities, contacts, lists, list members, segments, templates, template versions, campaigns, campaign recipients, deliveries, events and suppressions.
- Version templates immutably so a campaign's content is not silently changed by later template edits.
- Store credentials in encrypted form; the handoff describes AES-256-GCM for provider credentials.
- Implement a provider interface/registry so business logic does not need to be tied to one vendor.
- Gmail/Google Workspace is the production adapter reported as implemented, including OAuth refresh flow and MIME construction. SES and SMTP adapters were explicitly listed as not implemented in the earlier inspected handoff; do not mark them ready without current independent verification.
- Mock providers are for tests only unless explicitly and safely configured otherwise.

### 8.2 Transactional communication

- Support verification emails, email OTPs and password reset.
- Generate cryptographically secure tokens/OTPs; store token hashes rather than raw verification/reset tokens.
- Enforce expiry, attempt limits and one-time consumption.
- Invalidate relevant sessions after password reset.
- Keep enumeration-safe responses for password-reset requests.
- Allow WhatsApp OTP where the existing WhatsApp provider flow supports it.

### 8.3 Contacts, consent and suppression

- Normalize email addresses and keep contact verification separate from marketing consent.
- Persist consent status, source and timestamp when available.
- Support tenant-scoped lists, membership and structured dynamic segments rather than arbitrary SQL from callers.
- Enforce suppression checks before sending.
- Treat hard bounces and complaints as suppression events according to policy; classify soft bounces and retries deliberately.
- Support unsubscribe state and RFC 8058 one-click unsubscribe behavior for marketing email.
- Do not use a delivery/open/click signal as an excuse to bypass consent or suppression checks.

### 8.4 Campaign lifecycle

- Campaign states include `DRAFT`, `SCHEDULED`, `RUNNING`, `PAUSED`, `COMPLETED`, `FAILED` and `CANCELLED`.
- Support scheduling, start, pause, resume and cancellation.
- Snapshot recipients and relevant metadata for a campaign so later contact edits do not rewrite historical targeting.
- Maintain authoritative campaign metrics based on persisted delivery/event state.
- Use deterministic/idempotent campaign completion behavior.
- Use bounded audience resolution and tenant scoping for large lists/segments.

### 8.5 Delivery and event state

- Persist provider events before asynchronous processing.
- Deduplicate incoming events using provider/event identity and tenant/provider scope.
- Use a monotonic delivery state machine to prevent stale or out-of-order events from downgrading delivery state.
- Apply bounce/complaint suppression and campaign metric updates idempotently.
- Event processing errors must not be hidden. Failed enqueueing should leave a visible failed event state, using `QUEUE_ENQUEUE_FAILED` in the documented remediation.
- Do not infer that a message was delivered only because a tracking pixel or click was recorded; tracking signals are heuristic and distinct from a provider delivery receipt.

---

## 9. Webhook and Provider-Safety Decisions

- Verify incoming provider webhooks using the appropriate signature/challenge mechanism and timing-safe comparisons.
- Persist event identity and status before relying on downstream processing.
- Persist outbound webhook deliveries durably before network dispatch; use retry/backoff and terminal failure state.
- Use HMAC-SHA256 to sign outbound webhook payloads where the endpoint contract requires it.
- Validate webhook URLs and DNS/IP destinations to reduce SSRF risk; block private, loopback, link-local, metadata and otherwise unsafe targets.
- Bound response-body logging; sanitize HTML error pages and redact bearer tokens, passwords, secrets and access tokens.
- Use UUID-based event IDs rather than weak pseudo-random identifiers.
- Make webhook processing idempotent and preserve delivery/event linkage for auditability.
- Make rate limiting distributed/persistent where global limits are required; do not rely solely on an in-process `Map` for horizontally scaled production enforcement.

---

## 10. Multi-Channel Interface Decisions

- Align channel adapters around a common `sendMessage`-style contract (the latest report says Email, WhatsApp, SMS and Push providers are aligned with a uniform interface).
- Keep provider-specific credentials and API calls behind server-side adapters.
- Normalize provider success/error classification and delivery lifecycle enough for the platform to expose a consistent API.
- Keep channel-specific metadata and webhook verification where required; a uniform interface should not erase delivery semantics unique to each channel.
- Use mocks for cross-channel unit and lifecycle tests so tests do not send real communications.
- Treat interface-level support as different from a production-ready provider integration. The presence of an SPI does not prove live SMS, push, SES or SMTP is configured and available.

---

## 11. Scheduling and Live Operations Decisions

| Item | Decision / configured value | Verification boundary |
|---|---|---|
| Primary job processor | Cron job `process-email-jobs`, every minute (`* * * * *`) | Active in the last inspected Supabase state. |
| Reconciliation | Cron job `reconcile-email-jobs`, every five minutes (`*/5 * * * *`) | Active in the last inspected Supabase state. |
| Machine credential source | Supabase Vault secret `internal_processor_secret` | Secret existence and dynamic Cron lookup were verified; never expose the value. |
| Processor endpoint | `POST https://promotions-lime.vercel.app/api/internal/process-jobs` | Live requests returned HTTP 200 in the post-optimization snapshot. |
| Reconciliation endpoint | Same route with `?reconcile=true` | Returns structured reconciliation results when executed; error surfacing still merits review. |
| Function timeout | 60 seconds configured at route and `vercel.json` for processor/admin routes | Actual plan/runtime support must match configuration. |
| Function region | Mumbai (`bom1`) for processor/admin routes | Source configuration found; the active deployment should still be checked for region application. |
| Production queue volume | Last live count query showed 0 rows in `BackgroundJob`, `EmailDelivery` and `WebhookDelivery` | Live non-empty production throughput was therefore not demonstrated in that snapshot. |

### Runtime measurement note

The latest independent query in the conversation found 36 HTTP 200 responses and zero HTTP 500/timeouts in the last 30 minutes of the available Supabase telemetry. Of the 29 responses counted from the optimization timestamp onward, durations were 21–271 ms with an average of 65.8 ms. The immediately preceding 15-minute window returned 18/18 HTTP 200 responses, no HTTP 500s and no timeouts. These observations demonstrate a marked idle-path improvement at that time; they do not certify peak load or actual provider delivery at scale.

---

## 12. Testing and Release Decisions

1. Run schema validation and Prisma client generation as part of verification.
2. Run destructive tests only against explicitly disposable PostgreSQL and isolated Redis, with a safety guard that fails closed for production URLs.
3. Use mocked email/message providers for lifecycle and adversarial tests. No test should send a real customer message by accident.
4. Cover the workerless queue, atomic claim/concurrency, deduplication, retry classification, deadline handling, claim release, reconciliation, tenant isolation, event semantics, suppression and authorization.
5. Verify TypeScript, lint and the production Next.js build in addition to unit/integration suites.
6. Verify the actual GitHub Actions run for the final commit, not only local command output or a prior commit's green workflow.
7. Verify the active Vercel deployment SHA matches the intended release SHA.
8. After deployment, inspect live `net._http_response` telemetry and Cron run history; scheduler SQL success is not the same as successful HTTP processing.
9. A successful HTTP response must contain correct processor telemetry and no hidden category errors.
10. End-to-end tests against real providers are operational tests, not ordinary unit tests; use controlled recipients and explicit authorization before running them.

### Test results recorded in the latest report

The report for commit `598b6126597e63c39851e9be94d315a53745f3c0` records:

- `npx prisma validate`: pass
- `npx prisma generate`: pass
- `npm run test:guard`: 16/16 pass
- `npm run test:workerless`: 66/66 pass
- `npm run test:communication`: 8/8 pass
- `npm run test:email:certify`: 130/130 pass
- `npx tsc --noEmit`: 0 errors
- `npm run lint`: report says 0 errors/0 warnings
- `npm run build`: pass, 74 routes compiled
- GitHub Actions run [#38090328205](https://github.com/abhishekmitraaa/promotions/actions/runs/38090328205): completed successfully

These results are report-backed; rerun the suite if the repository changes after that commit.

---

## 13. Decisions That Were Superseded During the Project

| Earlier state / claim | Later decision | Current interpretation |
|---|---|---|
| Local SQLite was described in early handoff docs. | Move production persistence to Supabase PostgreSQL. | SQLite details are historical for local development and earlier project phases; production is reported on Supabase PostgreSQL 17. |
| Netlify appeared in earlier deployment documentation. | The later/current host is Vercel. | Use Vercel production deployment and settings for present operations. |
| Dedicated BullMQ/Redis workers were the original email architecture described in earlier handoff documents. | Adopt workerless PostgreSQL-backed processing through Supabase Cron and Vercel serverless functions for the intended production path. | BullMQ and worker-related code remain in the repository as compatibility/legacy paths; do not claim the dependency has been completely removed. |
| The internal route previously accepted `x-processor-secret` and `x-worker-secret` fallbacks. | Enforce Bearer-only machine authentication. | Request handling now reads only the Bearer authorization token; update the stale source comment that still describes the legacy header. |
| Initial production calls returned HTTP 500 due to missing `INTERNAL_PROCESSOR_SECRET` in Vercel. | Configure Vercel and redeploy with the matching value stored in Supabase Vault. | Subsequent production requests returned HTTP 200. The old “single environment-variable blocker” report was superseded by later runtime optimization work. |
| Idle processing originally took roughly 8–13 seconds. | Add global Prisma client reuse, Mumbai region targeting, 60-second configured max duration, bounded parallelism and category timing. | Source and live telemetry in the recorded optimization report show a significant idle-latency reduction. |

---

## 14. Open Decisions, Risks and Verification Boundaries

These are not claims that the system is broken; they are areas that should stay visible instead of being buried by the overall certification verdict.

### 14.1 One authoritative path for each logical email delivery

The current processor has both a `BackgroundJob` path that can invoke `EmailDeliveryExecutor` for email-related job types and a legacy direct `EmailDelivery` table sweep for transactional messages. Because these paths lock different rows/tables, confirm that they cannot concurrently send the same logical delivery. The architecture should document one authoritative path or prove the state transition prevents duplicate sending through integration tests.

### 14.2 Reconciliation error reporting

In the source inspected for this audit, `reconcileJobs()` catches an error, logs it and returns `null`. `processAll()` can therefore have no reconciliation report even though reconciliation failed, and it does not appear to add that failure to the shared `errors` array. Review whether this allows a top-level `success: true` result despite a reconciliation failure. The intended decision is to make failure status observable rather than turn it into indistinguishable “no work.”

### 14.3 Real production workload remains unproven

The last audited production queue counts were zero. Controlled disposable tests prove behavior of those test cases, not live provider delivery at scale. Once genuine workload exists, monitor success/failure counts, queue age, retries, dead letters, function duration, provider errors and concurrency.

### 14.4 Provider adapter coverage

Gmail is the implemented email adapter in the earlier code review. SES/SMTP were described as absent in that review, while SMS and Push appear in the shared SPI claims. Recheck the current adapter registry and real configuration before advertising any unimplemented provider as production-ready.

### 14.5 Database role and RLS trust boundary

The reports describe Prisma using administrative PostgreSQL credentials. Application-layer tenant scoping is then crucial. Verify the runtime role and sensitive grants directly; an enabled RLS flag does not protect against roles that bypass RLS.

### 14.6 Production timeout under load

The 60-second route maximum and 25/35-second internal work budgets are implemented in source. Continue testing non-empty batches in an isolated environment with delayed mock providers. Do not infer from fast empty sweeps that a full production batch will always complete safely.

### 14.7 Currentness of external evidence

The live telemetry quoted in this document comes from the last available inspection at 10 October 2026 22:33 UTC. Before using this file as a release certificate on a later date, query the current deployment, workflow, Cron and HTTP-response state again.

---

## 15. Recommended Current Decision Summary

The decisions documented and supported by the latest available source/report are:

- **Keep:** Vercel + Supabase PostgreSQL as the current hosting/data architecture.
- **Keep:** workerless production processing via Supabase Cron → `pg_net` → Vercel internal POST endpoint.
- **Keep:** Vault-backed Bearer-only authentication, constant-time comparison, fail-closed configuration and separate admin RBAC.
- **Keep:** durable PostgreSQL jobs, atomic claims, retry/backoff, bounded batching, idempotency and deadline-safe release.
- **Keep:** Mumbai region targeting, explicit route duration, Prisma client reuse, bounded parallel stages and category timing telemetry.
- **Keep:** disposable DB/Redis and mock providers for tests; never send real communications from the test harness.
- **Keep:** tenant `clientId` scoping, referential constraints, consent/suppression controls and provider/webhook security.
- **Do not claim yet:** full real-traffic production certification merely from idle Cron responses and green CI.
- **Resolve or explicitly document:** overlap between direct `EmailDelivery` sweeps and `BackgroundJob` execution, reconciliation failure reporting, and the supported-vs-legacy BullMQ boundary.
- **Verify before next release:** active Vercel deployment SHA, effective duration/region settings, fresh CI result, current Supabase response statistics, and the end-to-end lifecycle for a controlled test job.

---

## Sources Consolidated

This register was compiled from the files/reports available in the working conversation:

- `Pasted text(2).txt` — workerless infrastructure repair and audit report.
- `Pasted text(3).txt` — earlier certification report and post-redeployment/runtime-optimization report, including commit `598b612…`.
- `whatsapp_hub_all_prompts_and_reverification.md` — consolidated email master prompts and re-verification findings.
- `whatsapp_hub_email_platform_executive_summary.md` — historical technical handoff for WhatsApp Hub and Email architecture.
- Independent source/telemetry checks recorded in this conversation, including the current repository source at commit `598b612…` and the Supabase `net._http_response` snapshot through `2026-10-10 22:33:00 UTC`.

Where these sources conflict, this register marks the older state as superseded or calls out the unresolved discrepancy instead of presenting both as simultaneously current.
