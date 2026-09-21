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
| Viewer read access | overview, messages, conversations, API keys, webhooks, delivery history, user list |
| Viewer mutation denial | users, API keys, API-key revoke, message send, webhook create/update/delete, delivery retry, cleanup, queue processing |
| Admin mutation access | API-key create/revoke, message dispatch path, webhook create/update/delete, queue path |
| Middleware | unauthenticated dashboard redirect, Viewer mutation rejection, authenticated dashboard pass-through |
| Rate limiting | login boundary returns 429 after configured limit |
| Database hardening | User/UserSession RLS enabled and no broad anon/authenticated grants |
| Regression | lint, Prisma migration, production build, npm audit |

## Required execution
The GitHub Actions workflow runs against an isolated PostgreSQL 16 service. It applies the complete Prisma migration chain, executes the RBAC integration suite, then runs lint, production build, and dependency audit.

## Production validation after merge
After the branch is merged, run the same suite against a staging deployment with a staging database. Do not use the production database for destructive end-to-end cleanup tests.

## Demo administrator
The demo administrator is provisioned by scripts/seed-admin.ts, not embedded as a plaintext password in the migration. Set DEMO_ADMIN_EMAIL and DEMO_ADMIN_PASSWORD in a secure environment when provisioning it.