# Communication Infrastructure Service (WhatsApp & Email)

A production-minded, locally runnable self-hosted multi-channel messaging service built with **Next.js 16 (App Router)**, **TypeScript**, **Prisma ORM (Supabase PostgreSQL)**, **Redis + BullMQ**, **Zod**, **Meta's WhatsApp Cloud API**, and **Google Workspace / Gmail API**.

This service acts as a hardened, standardized abstraction layer between your external applications and communication providers—hiding access tokens, client secrets, and provider keys behind Bearer API keys while providing an administrative web dashboard, asynchronous queue processing, incoming webhook processing with cryptographic verification, OTP verification, contacts & segmentation management, campaign scheduling, and outbound delivery pipelines.

---

## 🌟 Key Capabilities

### WhatsApp Platform
- **Secure Public REST API (`/api/v1/messages`)**: Protected by Bearer API Key authentication (`Authorization: Bearer whub_...`), strict Zod validation, idempotent dispatch, and rate limiting (60 req/min).
- **Meta WhatsApp Cloud API Client**: Native fetch with timeouts, supporting text and structured template messages.
- **Inbound Webhook Engine (`/api/webhooks/whatsapp`)**: Timing-safe HMAC-SHA256 (`X-Hub-Signature-256`) verification.
- **Cryptographic OTP Service (`/api/v1/otp/*`)**: HMAC-SHA256 hashed with salt pepper; raw OTPs never stored in plaintext.

### Email Platform
- **Secure Public REST API (`/api/v1/email/send`)**: Scoped by Bearer API key to tenant with explicit `type: "TRANSACTIONAL" | "PROMOTIONAL"`.
- **Provider Abstraction Layer (`EmailProvider`)**: Normalized sender interface; first-class Google Workspace / Gmail OAuth2 provider with AES-256-GCM encrypted tokens.
- **Dedicated BullMQ Queue Worker (`npm run worker:email`)**: Persistent Node.js worker handling asynchronous dispatches, exponential backoff retries, and bounded failures.
- **Safe Template Renderer**: Strict variable validation, HTML escaping, and immutable versioning for scheduled campaigns.
- **Contacts, Lists & Dynamic Segments**: Normalized emails, decoupled marketing consent, and parameterized dynamic criteria (zero raw SQL).
- **Campaign Wizard**: 7-step creation wizard with audience resolution, consent checks, and suppression gatekeeping.
- **Compliance & Suppression**: Automatic RFC 8058 `List-Unsubscribe` headers, one-click unsubscribe endpoint, and automated suppression on hard bounces and spam complaints.
- **Provider Webhooks (`/api/email/webhooks/:provider`)**: Cryptographic signature validation and idempotent event deduplication.

### Multi-Tenant Isolation & Admin RBAC
- **9-Domain Tenant Isolation**: Strict `clientId` boundary across contacts, lists, segments, templates, campaigns, deliveries, providers, sender identities, and suppressions.
- **Server-Side RBAC**: `ADMIN` has full mutation access; `VIEWER` is strictly read-only with HTTP 403 enforcement.
- **High-Impact Audit Logging**: Sensitive credentials (`refreshToken`, `clientSecret`, `apiKey`, `password`) are automatically redacted with `[REDACTED]`.

## 🚀 Quick Start (Zero to Running in 2 Minutes)

### 1. Prerequisites
- **Node.js**: v22.12.0+
- **npm**: v10+

### 2. Clone & Install
```bash
git clone https://github.com/abhishekmitraaa/promotions.git
cd whatsapp-hub
npm install
```

### 3. One-Command Setup
Run the automated initialization script:
```bash
npm run setup
```
This script will:
1. Generate `.env.local` from `.env.example` with a cryptographically secure `API_KEY_PEPPER` and `AUTH_SESSION_SECRET`.
2. Synchronize the Prisma database schema.
3. Output your initial development API key.

### 4. Start the Server
```bash
npm run dev
```
Open [http://localhost:3000/dashboard](http://localhost:3000/dashboard) in your browser.

### 5. Access the Dashboard
Navigate to [http://localhost:3000/login](http://localhost:3000/login).
To provision the initial administrator account:
```bash
DEMO_ADMIN_PASSWORD="your_secure_password" npm run auth:seed-admin
```
Log in using your provisioned email and password. Admins can then create additional Admins or Viewers via **User Access** in the dashboard.

---

## 🔑 Provisioning an API Key

To call the public API (`/api/v1/*`), you need a Bearer API Key. You can generate one via the Dashboard or via the CLI:

### Via CLI:
```bash
npx tsx scripts/create-api-key.ts --client "PaymentService" --key "Staging Key"
```

### Via Dashboard:
Navigate to `/dashboard/api-keys` and click **Create API Key**. Copy the raw key immediately upon generation.

---

## 📤 Sending Messages

### 1. Free-form Text Message
> **Note**: Free-form text messages require that the recipient has sent an inbound message to your WhatsApp number within the preceding 24 hours.

```bash
curl -X POST http://localhost:3000/api/v1/messages \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "to": "919876543210",
    "type": "text",
    "body": "Hello from WhatsApp Infrastructure Service!"
  }'
```

### 2. Template Message (Simple Format)
Simple string arrays are automatically mapped to template body text parameters `{{1}}`, `{{2}}`, etc.:

```bash
curl -X POST http://localhost:3000/api/v1/messages \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "to": "919876543210",
    "type": "template",
    "templateName": "order_update",
    "templateLanguage": "en_US",
    "templateParameters": ["Alice", "ORD-9842"]
  }'
```

### 3. Template Message (Structured Meta Components)
For dynamic buttons (URL/quick reply) and multi-component templates:

```bash
curl -X POST http://localhost:3000/api/v1/messages \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "to": "919876543210",
    "type": "template",
    "templateName": "order_update",
    "templateLanguage": "en_US",
    "templateParameters": [
      {
        "type": "body",
        "parameters": [
          { "type": "text", "text": "ORD-9842" },
          { "type": "text", "text": "Shipped" }
        ]
      },
      {
        "type": "button",
        "sub_type": "url",
        "index": "0",
        "parameters": [
          { "type": "text", "text": "track/ORD-9842" }
        ]
      }
    ]
  }'
```

---

## 🔐 OTP Authentication Flow

### Request an OTP:
```bash
curl -X POST http://localhost:3000/api/v1/otp/request \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "to": "919876543210",
    "purpose": "login"
  }'
```

Response:
```json
{
  "success": true,
  "data": {
    "otpId": "cm7...",
    "destination": "919876543210",
    "purpose": "login",
    "expiresInSeconds": 300
  }
}
```

### Verify an OTP:
```bash
curl -X POST http://localhost:3000/api/v1/otp/verify \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "to": "919876543210",
    "purpose": "login",
    "code": "123456"
  }'
```

Response:
```json
{
  "success": true,
  "data": {
    "verified": true,
    "destination": "919876543210",
    "purpose": "login",
    "verifiedAt": "2026-09-14T18:00:00.000Z"
  }
}
```

---

## 🗄️ Database Architecture (Supabase PostgreSQL)

- **Supabase Cloud PostgreSQL**: The application connects to hosted PostgreSQL on Supabase, delivering durable, multi-worker persistent storage ready for serverless hosting (Netlify, Vercel, Docker).
- **Connection Architecture**:
  - `DATABASE_URL`: Pooled connection URL (port 6543 with `?pgbouncer=true`) for fast, serverless-friendly application queries.
  - `DIRECT_URL`: Direct database connection (port 5432) for schema migrations and administrative operations.
- **Migration & Verifications**:
  - `npm run db:migrate-data`: Upserts historical SQLite backup data into Supabase PostgreSQL.
  - `npm run db:verify`: Compares row counts between SQLite source and PostgreSQL target.

---

## 🧪 Automated Testing & Verification

Run the test suite verifying crypto operations, template parameters mapping, rate limiters, authentication & session security, Zod validators, and destructive-test safety guard logic:

```bash
npm test
```

### Safety Gate & Destructive Test Policy
Destructive test suites (including RBAC integration, phase-1 security, and phase-2 reliability) enforce a **deny-by-default safety gate** (`scripts/test-db-guard.ts`):
- **Unconditional Production Block**: Target databases matching the production Supabase project (`peqynzeioiauynfpdsdv`) are permanently blocked. No flag (`ALLOW_DESTRUCTIVE_TESTS=true`, `CI=true`, etc.) can override this.
- **Local Disposable Databases**: Destructive suites require an isolated local target (`localhost`, `127.0.0.1`, `::1`, `host.docker.internal`, or CI container `postgres`) with explicit confirmation: `ALLOW_DESTRUCTIVE_TESTS=true`.
- **RBAC Concurrency & Two-Admin Race**: `npm run test:rbac` verifies the Last-Admin invariant (`active ADMIN count >= 1`) by launching concurrent mutual deletion requests between exactly two active administrators (`Admin A deletes B` vs `Admin B deletes A`), proving that exactly one survives and active admin count never drops to zero.

To run the dedicated safety guard test suite:
```bash
npm run test:guard
```

To run a production build check:
```bash
npm run build
```

---

## 📚 Detailed Documentation

- [Setup & Environment Guide](docs/setup.md)
- [Public REST API Reference](docs/api.md)
- [Email Architecture & Queue Guide](docs/email-architecture.md)
- [Deployment Architecture & Production Operations](docs/deployment.md)
- [Meta WhatsApp Cloud API Integration Guide](docs/whatsapp-cloud-api.md)
- [Inbound & Outgoing Webhooks](docs/webhooks.md)
- [OTP Verification Architecture](docs/otp.md)
