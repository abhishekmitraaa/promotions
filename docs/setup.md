# Setup & Environment Guide

## Prerequisites

1. **Node.js**: v20 or higher recommended.
2. **npm**: v10 or higher.
3. **SQLite**: Used automatically via Prisma ORM for local development (`dev.db`).

## Step-by-Step Installation

```bash
# 1. Install dependencies
npm install

# 2. Setup environment configuration
cp .env.example .env.local

# 3. Push Prisma schema to SQLite database
npx prisma db push

# 4. Generate local API Key
npx tsx scripts/create-api-key.ts --client "MyLocalApp"

# 5. Start dev server
npm run dev
```

## Environment Variables Reference

| Variable | Required | Default | Description |
|---|---|---|---|
| `DATABASE_URL` | Yes | `file:./dev.db` | SQLite connection URL |
| `APP_URL` | Yes | `http://localhost:3000` | Application base URL |
| `META_GRAPH_API_VERSION` | Yes | `v22.0` | Meta Graph API version |
| `META_ACCESS_TOKEN` | Production | `""` | Permanent system user token |
| `META_PHONE_NUMBER_ID` | Production | `""` | WhatsApp Phone Number ID |
| `META_WABA_ID` | Production | `""` | WhatsApp Business Account ID |
| `META_APP_SECRET` | Production | `""` | App secret for signature validation |
| `META_WEBHOOK_VERIFY_TOKEN` | Production | `""` | Verification token for GET challenge |
| `API_KEY_PEPPER` | Yes | `[secret]` | Salt pepper for HMAC hashing API keys |
| `DEV_ALLOW_UNCONFIGURED_META` | No | `true` | Permits dashboard UI without Meta secrets |
