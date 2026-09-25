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
| `REDIS_URL` | String | `redis://localhost:6379` | Redis connection URL for BullMQ email queues. |
| `AUTH_SESSION_SECRET` | String | Min 32 chars | Cryptographic secret for signing HttpOnly session cookies. Required in production. |
| `INTERNAL_WORKER_SECRET` | String | Optional | Secret key for authorizing external scheduled workers (`x-worker-secret` header). |
| `API_KEY_PEPPER` | String | Auto-generated | Secret pepper used for HMAC-SHA256 hashing of API keys. Min 32 chars in production. |
| `WEBHOOK_SECRET_ENCRYPTION_KEY` | String | Min 32 chars | Secret key for AES-256-GCM encryption of webhook signing secrets and provider OAuth credentials at rest. |
| `GOOGLE_CLIENT_ID` | String | Optional | Google OAuth 2.0 Web Client ID for Gmail API provider integration. |
| `GOOGLE_CLIENT_SECRET` | String | Optional | Google OAuth 2.0 Web Client Secret for Gmail API provider integration. |
| `GOOGLE_REDIRECT_URI` | String | Optional | Google OAuth 2.0 authorized callback URI (e.g. `http://localhost:3000/api/email/providers/oauth/callback`). |
| `META_GRAPH_API_VERSION` | String | `v22.0` | Meta Graph API version for WhatsApp. |
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

## 4. Google OAuth 2.0 & Gmail Provider Setup

To connect Gmail / Google Workspace as an email provider:

1. **Google Cloud Console**:
   - Go to [Google Cloud Console](https://console.cloud.google.com).
   - Create a project and enable the **Gmail API**.
2. **OAuth Consent Screen**:
   - Configure User Type: Internal (for Google Workspace domain) or External.
   - Add scope: `https://www.googleapis.com/auth/gmail.send`.
3. **Credentials**:
   - Create an **OAuth 2.0 Client ID** of type **Web application**.
   - Set Authorized redirect URI to:
     - Development: `http://localhost:3000/api/email/providers/oauth/callback`
     - Production: `https://hub.yourdomain.com/api/email/providers/oauth/callback`
   - Copy Client ID and Client Secret to `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
4. **Connect via Admin Dashboard**:
   - Navigate to `/dashboard/email/providers`.
   - Click **Connect Gmail Account** to authenticate and authorize email dispatch. Tokens are automatically encrypted at rest via AES-256-GCM.

---

## 5. BullMQ Email Worker Daemon

Asynchronous email dispatches, campaign recipient fan-outs, and delivery retries are executed by a persistent BullMQ worker daemon:

```bash
# Start the local email background worker
npm run worker:email
```

Ensure Redis is running locally:
```bash
docker run -d -p 6379:6379 redis:7-alpine
```

---

## 6. Database Architecture & Reproducible Migrations

- **Managed Cloud PostgreSQL**: The application connects to hosted PostgreSQL on Supabase.
- **Connection Pooling**: Use the Supavisor pooled connection on port 6543 (`?pgbouncer=true`) for application runtime, and the direct connection on port 5432 (`DIRECT_URL`) for Prisma migrations.
- **Committed Migrations History**:
  - Migrations are committed in `prisma/migrations/`.
  - To apply forward migrations safely in production/staging without data loss:
    ```bash
    npx prisma migrate deploy
    ```

---

## 7. Verification Test Suites

```bash
# Core service and all unit/offline test suites
npm test

# Full Email suite (domain, provider, auth, queue, contacts, campaigns, webhooks, security matrix)
npm run test:email

# Specific subsystem email tests
npm run test:email:queue      # BullMQ queue, retries, bounded backoff, idempotency
npm run test:email:campaign   # Safe template engine, immutable versioning, campaign lifecycle
npm run test:email:security   # Cross-tenant isolation (9 domains), RBAC, rate limiting, audit logging

# Multi-tenant isolation and security verification (Requires local disposable test DB)
npm run test:security

# Phase 2 reliability and durable queue suite (Requires local disposable test DB)
npm run test:phase2

# Admin RBAC verification suite (Requires local disposable test DB)
npm run test:rbac

# Codebase linting
npm run lint

# Production build
npm run build
```
