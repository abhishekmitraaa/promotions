# Email/Password RBAC Test Plan

## Scope
This suite covers the new dashboard authentication and authorization layer without replacing the existing Phase 1/Phase 2 webhook, API-key, messaging, OTP, and SSRF suites.

## Roles
- ADMIN: may create, update, disable, delete users, reset passwords, change roles, manage API keys, send dashboard messages, and mutate webhooks.
- VIEWER: may authenticate and read dashboard data but may not perform mutations.

## Test matrix

| Area | Cases |
|---|---|
| Password security | scrypt hash, correct password, wrong password, no plaintext storage |
| Session security | HTTP-only cookie, SameSite, signature verification, dotted email handling, tampering, logout |
| Login | valid admin, valid viewer, invalid credentials, disabled account, deleted account |
| User creation | valid Viewer/Admin, weak password, invalid email/role, duplicate email |
| Role changes | Viewer→Admin, Admin→Viewer, session invalidation on role change |
| Password reset | new password works, old password fails, existing sessions invalidated |
| Account state | disable/enable, disable invalidates existing session, disabled login blocked |
| Account deletion | delete user, cascade sessions, deleted login blocked |
| Self-protection | cannot self-demote, self-disable, or self-delete |
| Last-admin protection | sole admin cannot be demoted, disabled, or deleted |
| Genuine two-admin race | exactly 2 active admins, Admin A deletes Admin B and Admin B deletes Admin A concurrently; exactly 1 survives as active ADMIN, losing request rejected with 400 (LAST_ADMIN_PROTECTION) or 401; active ADMIN count >= 1 invariant holds |
| Secondary race | exactly 2 active admins, Admin C demotes D, Admin D disables C concurrently; exactly 1 succeeds, active ADMIN count >= 1 invariant holds |
| Viewer read access | overview, messages, conversations, API keys, webhooks, delivery history, user list |
| Viewer mutation denial | users, API keys, API-key revoke, message send, webhook create/update/delete, delivery retry, cleanup, queue processing |
| Admin mutation access | API-key create/revoke, message dispatch path, webhook create/update/delete, queue path |
| Middleware | unauthenticated dashboard redirect, Viewer mutation rejection, authenticated dashboard pass-through |
| Rate limiting | login boundary returns 429 after configured limit |
| Database hardening | User/UserSession RLS enabled and no broad anon/authenticated grants |
| Destructive safety gate | deny-by-default guard; production DB (ref: peqynzeioiauynfpdsdv) unconditionally blocked regardless of flags |
| Regression | lint, Prisma migration, production build, npm audit |

## Destructive Test Safety Policy
- **Deny by default**: Destructive test suites (`verify-rbac`, `verify-phase1-security`, `verify-phase2-reliability`, `e2e-live-test`, `test-live-features`, `clean-database`, `reset-and-seed`) abort immediately unless the database target is positively identified as disposable.
- **Unconditional Production Block**: Any connection targeting the production Supabase database (project ref: `peqynzeioiauynfpdsdv`) is strictly and permanently blocked. Setting `ALLOW_DESTRUCTIVE_TESTS=true`, `CI=true`, or any other override CANNOT bypass this block.
- **Local Disposable DBs**: Local disposable databases (`localhost`, `127.0.0.1`, `::1`, `host.docker.internal`, or CI container `postgres`) require explicit opt-in via `ALLOW_DESTRUCTIVE_TESTS=true`.
- **Remote DBs**: Destructive tests against remote databases are strictly denied by default. Only local disposable databases (localhost, 127.0.0.1, Docker/CI service container) are permitted with explicit opt-in via `ALLOW_DESTRUCTIVE_TESTS=true`. Remote overrides are not supported.

## Genuine Two-Admin Last-Admin Race Test
- **Two-Admin Participant Model**: The concurrency test begins with exactly two active administrators (Admin A and Admin B) in the database. There is no baseline admin, no demo admin, and no third admin alive during the race.
- **Concurrent Execution**:
  - Request A: Admin A calls `DELETE /api/admin/users?id=B` with Admin A's session.
  - Request B: Admin B calls `DELETE /api/admin/users?id=A` with Admin B's session.
  - Both requests execute concurrently via `Promise.all`.
- **Invariants Verified**:
  1. Exactly ONE deletion succeeds (HTTP 200).
  2. The other deletion is rejected (HTTP 400 with `LAST_ADMIN_PROTECTION` or HTTP 401 if its session was cascaded).
  3. Under NO circumstances do both succeed (which would drop active admin count to zero).
  4. Exactly ONE active ADMIN remains in the database (`active ADMIN count >= 1`).
  5. The surviving admin remains fully active and usable; the deleted admin's sessions are completely cascaded.
- **Isolation Requirement**: The race test verifies that no unexpected pre-existing administrators exist before executing. If unexpected non-test admins are detected, the test aborts safely to prevent accidental data modification.

## Required execution
The GitHub Actions workflow runs against an isolated PostgreSQL 16 service container. It applies the complete Prisma migration chain, executes unit and safety guard tests (`npm test`), executes the RBAC integration suite (`npm run test:rbac`), then runs lint, production build, and dependency audit.

## Production validation after merge
After the branch is merged, run the same suite against a staging deployment with an isolated staging database. Do not use the production database for destructive end-to-end cleanup tests.

## Demo administrator
The demo administrator is provisioned by scripts/seed-admin.ts, not embedded as a plaintext password in the migration. Set DEMO_ADMIN_EMAIL and DEMO_ADMIN_PASSWORD in a secure environment when provisioning it.