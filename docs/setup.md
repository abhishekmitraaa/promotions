# Setup & Local Developer Guide

This guide walks through configuring, installing, running, and deploying the WhatsApp Hub infrastructure service.

---

## 1. System Requirements

- **Node.js**: v20.x or v22.x (Standardized across Netlify runtime and local environments)
- **npm**: v10.x or higher
- **Database**: Supabase PostgreSQL (Managed, serverless-ready, pooled via Supavisor)

---

## 2. Automated Initialization

```bash
# Clone the repository
git clone https://github.com/abhishekmitraaa/promotions.git
cd whatsapp-hub

# Install dependencies
npm install

# Run automated setup
npm run setup
```

### What `npm run setup` Does:
1. Verifies existing environment files; if `.env.local` is missing, it clones `.env.example`.
2. Checks if `API_KEY_PEPPER` is set or default; if missing, it automatically generates a 64-character cryptographically secure random string.
3. Generates the Prisma client types (`npx prisma generate`).
4. Ensures environment files remain untracked by Git.

---

## 3. Environment Variables Reference

All configurations are defined in `.env.local` for local development, or configured in Netlify Environment Variables for production:

| Variable | Type | Default | Description |
|---|---|---|---|
| `DATABASE_URL` | String | Required | Supabase PostgreSQL pooled connection URL (port 6543, `?pgbouncer=true`). |
| `DIRECT_URL` | String | Optional | Supabase PostgreSQL direct connection URL (port 5432) for migrations. |
| `APP_URL` | String | `http://localhost:3000` | Base public URL of your service. |
| `AUTH_SESSION_SECRET` | String | Min 32 chars | Cryptographic secret for signing HttpOnly session cookies. Required in production. |
| `INTERNAL_WORKER_SECRET` | String | Optional | Secret key for authorizing external scheduled workers (`x-worker-secret` header). |
| `API_KEY_PEPPER` | String | Auto-generated | Secret pepper used for HMAC-SHA256 hashing of API keys. Min 32 chars in production. |
| `WEBHOOK_SECRET_ENCRYPTION_KEY` | String | Min 32 chars | Secret key for AES-256-GCM encryption of webhook signing secrets at rest. |
| `META_GRAPH_API_VERSION` | String | `v22.0` | Meta Graph API version. |
| `META_ACCESS_TOKEN` | String | `""` | Meta Permanent System User Access Token. |
| `META_PHONE_NUMBER_ID` | String | `""` | Sender WhatsApp Business Phone Number ID. |
| `META_WABA_ID` | String | `""` | WhatsApp Business Account ID. |
| `META_APP_SECRET` | String | `""` | Meta App Secret for validating `X-Hub-Signature-256`. |
| `META_WEBHOOK_VERIFY_TOKEN` | String | `""` | Custom secret token for Meta webhook GET challenge verification. |
| `DEV_ALLOW_UNCONFIGURED_META` | Boolean | `true` | Allows local dev simulation. Strictly forced to `false` in production. |
| `OTP_EXPIRY_SECONDS` | Number | `300` | OTP validity window in seconds (default 5 minutes). |
| `OTP_MAX_ATTEMPTS` | Number | `5` | Maximum failed verification attempts before invalidation. |
| `OUTBOUND_WEBHOOK_TIMEOUT_MS`| Number | `10000` | Timeout in ms for outbound webhook delivery dispatches. |
| `OUTBOUND_WEBHOOK_MAX_RETRIES`| Number | `5` | Maximum delivery attempts for retryable 5xx/network errors. |

---

## 4. Database Architecture & Reproducible Migrations

- **Managed Cloud PostgreSQL**: The application connects to hosted PostgreSQL on Supabase (`peqynzeioiauynfpdsdv`).
- **Connection Pooling**: Use the Supavisor pooled connection on port 6543 (`?pgbouncer=true`) for application runtime, and the direct connection on port 5432 (`DIRECT_URL`) for Prisma migrations.
- **Committed Migrations History**:
  - Migrations are committed in `prisma/migrations/`.
  - To apply forward migrations safely in production/staging without data loss:
    ```bash
    npx prisma migrate deploy
    ```

---

## 5. Local Development vs Live Production Mode

### Local Simulation Mode (`NODE_ENV !== "production"`)
If `META_ACCESS_TOKEN` or `META_PHONE_NUMBER_ID` are omitted in development:
- The service **does not fail**.
- It records messages into the local database as `SENT`.
- It generates a simulated provider ID (`wamid.dev_mock_...`).
- It outputs simulation debug logs in your console.
- The web dashboard will display amber diagnostic cards indicating that Meta credentials are unconfigured.

### Live Production Mode
When deployed or running with live credentials:
- Set `META_ACCESS_TOKEN`, `META_PHONE_NUMBER_ID`, `META_APP_SECRET`, and `META_WEBHOOK_VERIFY_TOKEN`.
- The service will perform live HTTPS calls to `https://graph.facebook.com/v22.0/{META_PHONE_NUMBER_ID}/messages`.
- Meta webhook signatures will be verified using timing-safe HMAC-SHA256.

---

## 6. Verification Test Suites

```bash
# Core service verification suite (45 checks)
npm test

# Multi-tenant isolation, RLS, and security verification suite (32 checks)
npm run test:security

# Phase 2 reliability, durable queue, and rate limiting suite (26 checks)
npm run test:phase2

# Codebase linting
npm run lint

# Production build
npm run build
```
