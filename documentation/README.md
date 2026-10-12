# WhatsApp Hub — Project Documentation

This folder holds the current reference documentation for WhatsApp Hub: what it is, how it is built, what is broken, and what is still needed to make it work end-to-end.

**Usage context:** this service is used by **one owner's own project**. It is not offered to outside customers. Multi-tenant features exist in the code but only one tenant (`ApiClient`) is expected.

| File | What it contains |
|---|---|
| [01-project-overview.md](01-project-overview.md) | Purpose, features, tech stack, architecture, data model, API surface, repo layout |
| [02-code-review-2026-10-12.md](02-code-review-2026-10-12.md) | Bug findings from the 12 Oct 2026 code review, ranked by severity |
| [03-go-live-checklist.md](03-go-live-checklist.md) | Everything still required to make the system actually send messages, in order |
| [04-environment-variables.md](04-environment-variables.md) | Every environment variable the code really reads, and mismatches with `.env.example` |
| [05-operations-runbook.md](05-operations-runbook.md) | Cron setup, monitoring queries, test commands, deploy and troubleshooting |
| [06-decision-register.md](06-decision-register.md) | Every product, architecture, security and ops decision with rationale, including the decisions added on 12 Oct and which open items they closed |
| [flags.md](flags.md) | Running log of open concerns (updated on every agent session per `AGENTS.md`) |
| [EXECUTIVE_SESSION_AUDIT.md](EXECUTIVE_SESSION_AUDIT.md) | Earlier executive audit (11 Oct 2026) |

Older, topic-specific design docs live in [`../docs/`](../docs/) (API reference, OTP, webhooks, email architecture, workerless architecture, deployment). They are still useful, but where they conflict with this folder, this folder reflects the code as of commit `bb76d0c` plus the 12 Oct fixes.

## Status in one paragraph (12 Oct 2026)

The code base is large and mostly complete: WhatsApp messaging (with automatic retries), OTP, transactional and promotional email, campaigns, webhooks, a dashboard with Admin/Viewer roles, and a job processor driven by Supabase Cron. It runs on Vercel and Supabase only: there is no Redis and no worker process. Builds, lint and all test suites pass. **But nothing has ever been delivered in production**: the WhatsApp (Meta) credentials are empty, no Gmail provider is connected, and all work tables are empty. On 12 Oct 2026 the code review's 15 findings were fixed, Redis and the legacy BullMQ worker were removed, and WhatsApp retries and Gmail bounce detection were added (see [02](02-code-review-2026-10-12.md)). This work was deployed on 12 Oct 2026 (`main` at `47b905c`): both migrations are applied to production, CI passed, and the cron processor has returned 200 since. What's left is the external setup in [03-go-live-checklist.md](03-go-live-checklist.md).
