# WhatsApp Messaging Infrastructure Service

A production-minded, locally runnable self-hosted WhatsApp messaging service built with **Next.js 16 (App Router)**, **TypeScript**, **Prisma ORM (SQLite)**, **Zod**, and **Meta's official WhatsApp Cloud API**.

This service acts as a hardened, standardized abstraction layer between your external applications and Meta's Graph API—hiding access tokens and phone number IDs behind Bearer API keys while providing an administrative web dashboard, incoming webhook processing with HMAC validation, OTP verification, and outgoing webhook forwarding.

---

## 🌟 Key Capabilities

- **Secure Public REST API (`/api/v1/*`)**:
  - Protected by Bearer API Key authentication (`Authorization: Bearer whub_...`).
  - Strict input validation via Zod schemas.
  - Idempotent message dispatch via `Idempotency-Key` header.
  - Built-in rate limiting (60 req/min for messages, 5 req/min for OTP requests).
- **Admin Dashboard & API (`/dashboard/*`, `/api/admin/*`)**:
  - Protected by HTTP Basic Auth (`ADMIN_USERNAME` & `ADMIN_PASSWORD`).
  - Real-time messaging metrics, health diagnostics, and audit logs.
  - Manual message composer supporting free-form text & pre-approved Meta templates.
  - Conversation viewer grouped by participant phone number.
  - API Key creation, revocation, and metadata auditing.
  - Outgoing webhook endpoint manager and delivery retry viewer.
- **Meta WhatsApp Cloud API Client**:
  - Direct HTTP integration using native `fetch` with `AbortController` timeouts.
  - Full support for text messages and template messages with dynamic body & button parameters.
  - Simulated sending mode in non-production environments when Meta credentials are absent.
- **Inbound Webhook Engine (`/api/webhooks/whatsapp`)**:
  - Automatic `GET` challenge handshake validation (`hub.challenge`).
  - Cryptographic `POST` verification using timing-safe HMAC-SHA256 (`X-Hub-Signature-256`).
  - Ingestion of incoming messages, contact updates, and delivery status events (`sent`, `delivered`, `read`, `failed`).
- **Cryptographic OTP Service (`/api/v1/otp/*`)**:
  - Raw OTP codes are NEVER stored in plaintext (HMAC-SHA256 hashed with salt pepper).
  - Strict attempt tracking with automatic invalidation upon expiry or exceeding max attempts.
- **Automated Developer Setup**:
  - Single command `npm run setup` initializes environment, runs Prisma migrations, and untracks local database.
  - 100% test pass verification via `npm test`.

---

## 🚀 Quick Start (Zero to Running in 2 Minutes)

### 1. Prerequisites
- **Node.js**: v20+
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
1. Generate `.env.local` from `.env.example` if not already present.
2. Generate a secure, cryptographically random `API_KEY_PEPPER`.
3. Apply Prisma database schema to the untracked local SQLite database (`prisma/dev.db`).

### 4. Start the Server
```bash
npm run dev
```
Open [http://localhost:3000/dashboard](http://localhost:3000/dashboard) in your browser.

### 5. Access the Dashboard
When prompted by your browser's HTTP Basic Auth prompt:
- **Username**: `admin` (or value of `ADMIN_USERNAME` in `.env.local`)
- **Password**: `admin` (or value of `ADMIN_PASSWORD` in `.env.local`)

---

## 🔑 Provisioning an API Key

To call the public API (`/api/v1/*`), you need a Bearer API Key. You can generate one via the Dashboard or via the CLI:

### Via CLI:
```bash
npx tsx scripts/create-api-key.ts --client "PaymentService" --key "Staging Key"
```
Output:
```text
🔐 RAW API KEY (COPY IT NOW - IT WILL NOT BE SHOWN AGAIN):

  whub_a1b2c3d4e5f6789012345678abcdef01
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

### 2. Pre-Approved Meta Template Message
Templates can be sent outside the 24-hour customer care window.

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
    "message": "OTP generated and dispatched successfully",
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
    "message": "OTP verified successfully"
  }
}
```

---

## 🌐 Configuring Meta Webhooks

1. Expose your local server via a secure HTTPS tunnel (e.g. using ngrok or Cloudflare):
   ```bash
   ngrok http 3000
   ```
2. Open **Meta Developer Portal** > **WhatsApp** > **Configuration**.
3. In **Webhook**, click **Edit**:
   - **Callback URL**: `https://<your-subdomain>.ngrok-free.app/api/webhooks/whatsapp`
   - **Verify Token**: Must match `META_WEBHOOK_VERIFY_TOKEN` in your `.env.local`
4. Click **Verify and Save**.
5. Subscribe to the `messages` webhook field.

---

## 🧪 Automated Testing & Verification

Run the test suite verifying crypto operations, rate limiters, Basic Auth parsing, and Zod validators:

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
