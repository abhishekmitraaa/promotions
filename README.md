# WhatsApp Messaging Infrastructure Service

A production-minded, locally runnable self-hosted WhatsApp messaging service built with **Next.js 16 (App Router)**, **TypeScript**, **Prisma ORM (Supabase PostgreSQL)**, **Zod**, and **Meta's official WhatsApp Cloud API**.

This service acts as a hardened, standardized abstraction layer between your external applications and Meta's Graph API—hiding access tokens and phone number IDs behind Bearer API keys while providing an administrative web dashboard, incoming webhook processing with HMAC validation, OTP verification, and outgoing webhook forwarding.

---

## 🌟 Key Capabilities

- **Secure Public REST API (`/api/v1/*`)**:
  - Protected by Bearer API Key authentication (`Authorization: Bearer whub_...`).
  - Strict input validation via Zod schemas.
  - Idempotent message dispatch via `Idempotency-Key` header.
  - Built-in normalized rate limiting (60 req/min for messages, 5 req/min for OTP requests, 10 attempts/min for OTP verification).
- **Admin Dashboard & API (`/dashboard/*`, `/api/admin/*`)**:
  - Protected by Email/Password authentication & Role-Based Access Control (RBAC: `ADMIN` and `VIEWER`).
  - Cryptographically signed HttpOnly session cookies backed by database sessions.
  - Server-side mutation protection: Viewer role is strictly read-only (HTTP 403 on all mutations).
  - Built-in last-admin lockout protection.
  - Real-time messaging metrics, health diagnostics, and audit logs.
  - Manual message composer supporting free-form text & pre-approved Meta templates.
  - Conversation viewer grouped by participant phone number.
  - API Key creation, revocation, and metadata auditing.
  - Outgoing webhook endpoint manager and delivery retry viewer.
  - User management interface for Admins to create, promote/demote, disable, and delete users.
- **Meta WhatsApp Cloud API Client**:
  - Direct HTTP integration using native `fetch` with `AbortController` timeouts.
  - Full support for text messages and template messages:
    - **Simple string array**: `["Alice", "ORD-123"]` (automatically mapped to body text parameters).
    - **Meta-shaped components**: Structured header, body, and button URL/quick-reply parameters.
  - Simulated sending mode in non-production environments only when Meta credentials are absent.
- **Inbound Webhook Engine (`/api/webhooks/whatsapp`)**:
  - Automatic `GET` challenge handshake validation (`hub.challenge`).
  - Cryptographic `POST` verification using timing-safe HMAC-SHA256 (`X-Hub-Signature-256`).
  - Ingestion of incoming messages, contact updates, and delivery status events (`sent`, `delivered`, `read`, `failed`).
- **Cryptographic OTP Service (`/api/v1/otp/*`)**:
  - Raw OTP codes are NEVER stored in plaintext (HMAC-SHA256 hashed with salt pepper).
  - Strict attempt tracking with automatic invalidation upon expiry or exceeding max attempts.
  - `devCode` is strictly returned only in non-production simulated mode; never leaked in production.
- **Automated Developer Setup**:
  - Single command `npm run setup` initializes environment with a random secure session secret and API pepper.
  - 100% test pass verification via `npm test` and `npm run test:rbac`.

---

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

Run the test suite verifying crypto operations, template parameters mapping, rate limiters, authentication & session security, and Zod validators:

```bash
npm test
```

To run a production build check:
```bash
npm run build
```

---

## 📚 Detailed Documentation

- [Setup & Environment Guide](docs/setup.md)
- [Public REST API Reference](docs/api.md)
- [Meta WhatsApp Cloud API Integration Guide](docs/whatsapp-cloud-api.md)
- [Inbound & Outgoing Webhooks](docs/webhooks.md)
- [OTP Verification Architecture](docs/otp.md)
