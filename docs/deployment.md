# Deployment Architecture & Production Operations Guide

This document describes the recommended production deployment topology for the WhatsApp & Email Infrastructure Platform.

---

## 1. System Topology Overview

The platform uses a split architecture separating the serverless/stateless HTTP application from persistent background worker processes:

```
                          ┌───────────────────────────┐
                          │     External Clients      │
                          │   (Web, Mobile, CRMs)     │
                          └─────────────┬─────────────┘
                                        │ HTTPS
                                        ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                       HTTP APPLICATION LAYER (Netlify)                      │
│                                                                             │
│  - Next.js 16 App Router (Admin Dashboard UI & SSR)                         │
│  - Inbound Webhook Handlers (/api/webhooks/whatsapp, /api/webhooks/email/*) │
│  - Public REST APIs (/api/v1/messages, /api/v1/email/send, /api/v1/otp/*)   │
│  - Admin REST APIs (/api/admin/*, /api/email/*)                             │
│  - Producer: Enqueues jobs to Redis BullMQ                                  │
└───────────────────────┬─────────────────────────────┬───────────────────────┘
                        │                             │
                        │ SQL (Port 6543)             │ Redis Protocol
                        ▼                             ▼
┌──────────────────────────────┐            ┌─────────────────────────────────┐
│     DATABASE LAYER           │            │       MESSAGE QUEUE LAYER       │
│  (Supabase PostgreSQL)       │            │  (Upstash / AWS ElastiCache)    │
│                              │            │                                 │
│ - Supavisor Connection Pool  │            │ - Redis 7+                      │
│ - Row-Level Security (RLS)   │            │ - BullMQ Job Queues:            │
│ - Multi-Tenant Isolation     │            │   * email-deliveries            │
│ - Prisma Schema & Migrations │            │   * email-campaigns             │
└──────────────▲───────────────┘            └────────────────┬────────────────┘
               │                                             │
               │ Direct SQL                                  │ Pop / Process Jobs
               │                                             ▼
┌──────────────┴──────────────────────────────────────────────────────────────┐
│                    DEDICATED BACKGROUND WORKER LAYER                        │
│                (Render, Fly.io, Railway, AWS ECS, or VM)                    │
│                                                                             │
│  - Node.js >= 22.12.0 long-running daemon (`npm run worker:email`)         │
│  - BullMQ Queue Workers & Job Processors                                    │
│  - Provider Abstraction Layer & Rate Limit Throttlers                       │
│  - Dispatches to Email Providers (Gmail API, SMTP, etc.)                    │
│  - Updates EmailDelivery records & campaign metrics                         │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼ HTTPS / OAuth2
                        ┌─────────────────────────────┐
                        │      EMAIL PROVIDERS        │
                        │ (Google Workspace / Gmail)  │
                        └─────────────────────────────┘
```

---

## 2. Component Breakdown

### A. HTTP Application (Netlify / Vercel / Cloud Run)
- **Role**: Serves the Next.js frontend, public APIs, and incoming webhooks.
- **Characteristics**: Stateless, auto-scaling, short-lived requests (maximum 10–30s execution timeout).
- **CRITICAL NOTE**: **Never run BullMQ workers inside Netlify serverless functions.** Serverless functions freeze between requests and will abruptly terminate active email batches, drop Redis connections, and cause orphan delivery records.

### B. PostgreSQL Database (Supabase)
- **Role**: Primary system of record for all tenants, contacts, templates, campaigns, deliveries, audit logs, and WhatsApp messages.
- **Connection Modes**:
  - `DATABASE_URL`: Transaction pooled URL via Supavisor (port 6543) with `?pgbouncer=true` for application runtime.
  - `DIRECT_URL`: Session direct connection (port 5432) for running migrations (`npx prisma migrate deploy`).

### C. Message Queue (Redis)
- **Role**: High-throughput distributed queue for email dispatches, campaign recipient fan-outs, and delivery retries.
- **Requirement**: Redis 6.2+ or 7+ (Upstash, AWS ElastiCache, Redis Enterprise, or managed DigitalOcean Redis).
- **Environment Variable**: `REDIS_URL=rediss://default:password@your-redis-host:6379`.

### D. Dedicated Background Worker
- **Role**: Persistent daemon processing asynchronous email jobs.
- **Command**:
  ```bash
  npm run worker:email
  ```
- **Deployment Targets**: Render Background Worker, Fly.io App, Railway Worker, AWS ECS Fargate, or Kubernetes StatefulSet/Deployment.
- **Scaling**: Horizontally scalable across multiple worker nodes. Concurrency and rate limiting are handled deterministically through BullMQ.

### E. Email Providers
- **Role**: Outbound delivery endpoints.
- **Initial Implementation**: Gmail / Google Workspace API via OAuth2 (RFC 2822 base64url MIME transmission with automatic token refresh).

---

## 3. Environment Configuration for Production

Ensure all mandatory environment variables are set in both the HTTP application and the Worker daemon:

```bash
# Node Environment
NODE_ENV=production
APP_URL=https://hub.yourdomain.com

# PostgreSQL Connection
DATABASE_URL="postgresql://postgres:[PASSWORD]@[HOST]:6543/postgres?pgbouncer=true"
DIRECT_URL="postgresql://postgres:[PASSWORD]@[HOST]:5432/postgres"

# Redis Queue Connection
REDIS_URL="rediss://default:[PASSWORD]@[HOST]:6379"

# Security & Encryption Secrets (All must be 32+ characters)
AUTH_SESSION_SECRET="production-session-secret-at-least-32-chars-long"
API_KEY_PEPPER="production-api-key-pepper-at-least-32-chars-long"
WEBHOOK_SECRET_ENCRYPTION_KEY="production-webhook-encryption-key-32-chars"
INTERNAL_WORKER_SECRET="production-internal-worker-secret-32-chars"

# Google Workspace / Gmail OAuth (Provider Settings)
GOOGLE_CLIENT_ID="your-client-id.apps.googleusercontent.com"
GOOGLE_CLIENT_SECRET="GOCSPX-your-client-secret"
GOOGLE_REDIRECT_URI="https://hub.yourdomain.com/api/email/providers/oauth/callback"

# WhatsApp Meta Cloud API (Optional if only using Email)
META_GRAPH_API_VERSION="v22.0"
META_ACCESS_TOKEN="EAA..."
META_PHONE_NUMBER_ID="100..."
META_WABA_ID="100..."
META_APP_SECRET="app-secret"
META_WEBHOOK_VERIFY_TOKEN="custom-verify-token"
DEV_ALLOW_UNCONFIGURED_META=false
```

---

## 4. Production Deployment Checklist

1. [ ] **Database Migration**:
   ```bash
   npx prisma migrate deploy
   ```
2. [ ] **Seed Administrator**:
   ```bash
   DEMO_ADMIN_PASSWORD="YourStrongPassword" npm run auth:seed-admin
   ```
3. [ ] **Deploy Web App**:
   Deploy Next.js application to Netlify or your preferred serverless hosting platform.
4. [ ] **Deploy Worker**:
   Deploy `npm run worker:email` as a continuous daemon process on your worker platform.
5. [ ] **Configure Google OAuth**:
   - Authorized redirect URI: `https://hub.yourdomain.com/api/email/providers/oauth/callback`
   - Scope: `https://www.googleapis.com/auth/gmail.send`
6. [ ] **Verify Worker Health**:
   Check the Admin Dashboard under **Communication -> Email -> Dashboard** to ensure the queue and worker status report green.
