# WhatsApp Messaging Infrastructure Service

A production-minded, locally runnable self-hosted WhatsApp messaging service built with **Next.js 16 (App Router)**, **TypeScript**, **Prisma ORM (SQLite)**, **Zod**, and **Meta's official WhatsApp Cloud API**.

This service acts as an abstraction layer between external applications and Meta's Graph API, hiding access tokens and phone number IDs while providing a web dashboard, incoming webhook processing, OTP verification, and API-key protection.

---

## 🌟 Features

- **Public REST API (`/api/v1`)**: Secure API key authentication (`Authorization: Bearer <key>`), Zod validation, idempotency support (`Idempotency-Key` header).
- **Meta WhatsApp Cloud API Client**: Native fetch with AbortController timeouts and structured error handling.
- **Webhook Receiver (`/api/webhooks/whatsapp`)**: Meta challenge verification (`GET`) and timing-safe HMAC SHA-256 signature validation (`POST`).
- **Outgoing Webhook Dispatcher**: Signed payload forwarding to external target applications with exponential backoff retries.
- **OTP Verification System**: Secure numeric OTP generation, hashed storage, attempt limits, and expiration tracking.
- **Web Dashboard (`/dashboard`)**: Analytics overview, message history & dispatch, conversation threads, API key management, outgoing webhook config, and Meta setup diagnostics.
- **CLI Provisioning Tool**: `npm run create:api-key` to generate API clients and print raw keys securely.

---

## 🚀 Quick Start & Setup

### 1. Prerequisites
- **Node.js**: v20+
- **npm**: v10+
- **Meta Developer Account**: (Optional for initial local UI test; required for live WhatsApp messaging)
  - Meta App with WhatsApp Business product enabled
  - WhatsApp Business Account (WABA)
  - Phone Number ID
  - Access Token (Permanent System User Token recommended)

### 2. Installation
```bash
git clone https://github.com/abhishekmitraaa/promotions.git
cd whatsapp-hub
npm install
```

### 3. Environment Configuration
Copy `.env.example` to `.env.local`:
```bash
cp .env.example .env.local
```

Configure the following variables in `.env.local`:
```env
DATABASE_URL="file:./dev.db"
APP_URL="http://localhost:3000"

META_GRAPH_API_VERSION="v22.0"
META_ACCESS_TOKEN="YOUR_META_ACCESS_TOKEN"
META_PHONE_NUMBER_ID="YOUR_META_PHONE_NUMBER_ID"
META_WABA_ID="YOUR_META_WABA_ID"
META_APP_SECRET="YOUR_META_APP_SECRET"
META_WEBHOOK_VERIFY_TOKEN="YOUR_CUSTOM_VERIFY_TOKEN"

API_KEY_PEPPER="replace_with_a_random_32_character_string"
```

### 4. Database Initialization
```bash
npx prisma db push
```

### 5. Start Local Development Server
```bash
npm run dev
```
Open [http://localhost:3000/dashboard](http://localhost:3000/dashboard) to view the Web Dashboard.

---

## 🔑 Creating an API Key

To send messages via curl or external applications, generate an API key using the CLI command:

```bash
npx tsx scripts/create-api-key.ts --client "MyExternalApp" --key "Production Key"
```

Output example:
```text
🔐 RAW API KEY (COPY IT NOW - IT WILL NOT BE SHOWN AGAIN):

  whub_9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d
```

---

## 📤 Sending a Test Message

### Using curl:
```bash
curl -X POST http://localhost:3000/api/v1/messages \
  -H "Authorization: Bearer YOUR_GENERATED_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "to": "919876543210",
    "type": "text",
    "body": "Hello from my WhatsApp Infrastructure Service!"
  }'
```

### Using PowerShell:
```powershell
$headers = @{
    "Authorization" = "Bearer YOUR_GENERATED_API_KEY"
    "Content-Type"  = "application/json"
}
$body = @{
    to   = "919876543210"
    type = "text"
    body = "Hello from my WhatsApp Infrastructure Service!"
} | ConvertTo-Json

Invoke-RestMethod -Uri "http://localhost:3000/api/v1/messages" -Method Post -Headers $headers -Body $body
```

---

## ⚡ Meta Webhook Setup (ngrok)

Meta requires a publicly reachable HTTPS URL for webhooks.

1. Start ngrok tunnel:
```bash
ngrok http 3000
```
2. Copy your HTTPS URL (e.g., `https://xyz.ngrok-free.app`).
3. In Meta Developer Console (**WhatsApp > Configuration**):
   - **Callback URL**: `https://xyz.ngrok-free.app/api/webhooks/whatsapp`
   - **Verify Token**: Must match `META_WEBHOOK_VERIFY_TOKEN` in `.env.local`
4. Click **Verify and Save**.
5. Under Webhook fields, subscribe to **messages**.

---

## 🔐 OTP Verification Flow

### Request OTP:
```bash
curl -X POST http://localhost:3000/api/v1/otp/request \
  -H "Authorization: Bearer YOUR_GENERATED_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "to": "919876543210",
    "purpose": "login"
  }'
```

### Verify OTP:
```bash
curl -X POST http://localhost:3000/api/v1/otp/verify \
  -H "Authorization: Bearer YOUR_GENERATED_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "to": "919876543210",
    "purpose": "login",
    "code": "123456"
  }'
```

> **Note**: For production OTP, Meta requires an approved Authentication/OTP template in Meta Business Manager. In local dev mode, the service falls back gracefully with a simulated log output if Meta credentials are unconfigured.

---

## 🧪 Running Automated Verification Tests

Run the full automated unit & integration test suite:

```bash
npm test
```

Or execute directly:
```bash
npx tsx scripts/verify-service.ts
```

---

## 📁 Detailed Documentation

For further architectural and API reference, see:
- [Setup Guide](docs/setup.md)
- [API Reference](docs/api.md)
- [Meta WhatsApp Cloud API Details](docs/whatsapp-cloud-api.md)
- [Webhooks & Dispatcher](docs/webhooks.md)
- [OTP System](docs/otp.md)
