# Setup & Local Developer Guide

This guide walks through configuring, installing, and running the WhatsApp Hub infrastructure service locally.

---

## 1. System Requirements

- **Node.js**: v20.x or higher
- **npm**: v10.x or higher
- **Database**: SQLite (managed automatically via Prisma ORM)

---

## 2. Automated Initialization

The easiest way to bootstrap the project is using the automated setup script:

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
3. Automatically executes `npx prisma db push` to synchronize the PostgreSQL database schema.
4. Ensures environment files remain untracked by Git.

---

## 3. Environment Variables Reference

All configurations are defined in `.env.local`:

| Variable | Type | Default | Description |
|---|---|---|---|
| `DATABASE_URL` | String | Required | Supabase PostgreSQL pooled connection URL (port 6543, `?pgbouncer=true`). |
| `DIRECT_URL` | String | Optional | Supabase PostgreSQL direct connection URL (port 5432) for migrations. |
| `APP_URL` | String | `http://localhost:3000` | Base public URL of your service. |
| `ADMIN_USERNAME` | String | `hub_admin` | HTTP Basic Auth username for `/dashboard/*` and `/api/admin/*`. In production, explicit non-default value is required. |
| `ADMIN_PASSWORD` | String | Auto-generated | HTTP Basic Auth password for `/dashboard/*` and `/api/admin/*`. In production, must be at least 12 characters; "admin" is forbidden. |
| `API_KEY_PEPPER` | String | Auto-generated | Secret pepper used for HMAC-SHA256 hashing of API keys. Min 32 chars in production. |
| `META_GRAPH_API_VERSION` | String | `v22.0` | Meta Graph API version. |
| `META_ACCESS_TOKEN` | String | `""` | Meta Permanent System User Access Token. |
| `META_PHONE_NUMBER_ID` | String | `""` | Sender WhatsApp Business Phone Number ID. |
| `META_WABA_ID` | String | `""` | WhatsApp Business Account ID. |
| `META_APP_SECRET` | String | `""` | Meta App Secret for validating `X-Hub-Signature-256`. |
| `META_WEBHOOK_VERIFY_TOKEN` | String | `""` | Custom secret token for Meta webhook GET challenge verification. |
| `DEV_ALLOW_UNCONFIGURED_META` | Boolean | `true` | Allows local dev simulation. Strictly forced to `false` in production. |
| `OTP_EXPIRY_SECONDS` | Number | `300` | OTP validity window in seconds (default 5 minutes). |
| `OTP_MAX_ATTEMPTS` | Number | `5` | Maximum failed verification attempts before invalidation. |
| `OUTGOING_WEBHOOK_TIMEOUT_MS`| Number | `5000` | Timeout in ms for outgoing webhook delivery dispatches. |

---

## 4. Database Architecture (Supabase PostgreSQL)

- **Managed Cloud PostgreSQL**: The application connects to hosted PostgreSQL on Supabase.
- **Connection Pooling**: Use the Supavisor pooled connection on port 6543 (`?pgbouncer=true`) for application runtime, and the direct connection on port 5432 (`DIRECT_URL`) for Prisma schema migrations.
- **Data Migration & Verification**:
  - `npm run db:migrate-data`: Migrates historical records from SQLite exports to PostgreSQL.
  - `npm run db:verify`: Compares source SQLite row counts against target PostgreSQL row counts.

---

---

## 4. Local Development vs Live Production Mode

### Local Simulation Mode (`NODE_ENV !== "production"`)
If `META_ACCESS_TOKEN` or `META_PHONE_NUMBER_ID` are omitted in development:
- The service **does not fail**.
- It records messages into the local database as `SENT`.
- It generates a simulated provider ID (`sim_msg_<uuid>`).
- It outputs simulation debug logs in your console.
- The web dashboard will display amber diagnostic cards indicating that Meta credentials are unconfigured.

### Live Production Mode
When deployed or running with live credentials:
- Set `META_ACCESS_TOKEN`, `META_PHONE_NUMBER_ID`, `META_APP_SECRET`, and `META_WEBHOOK_VERIFY_TOKEN`.
- The service will perform live HTTPS calls to `https://graph.facebook.com/v22.0/{META_PHONE_NUMBER_ID}/messages`.
- Meta webhook signatures will be verified using timing-safe HMAC-SHA256.

---

## 5. Running the Service

```bash
# Start Next.js development server
npm run dev

# Run automated verification suite (22 checks)
npm test

# Check codebase formatting and linting
npm run lint

# Build production bundle
npm run build
```
