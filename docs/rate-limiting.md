# Distributed Rate Limiting & Abuse Protection Architecture

## 1. Overview & High-Availability Model

In a multi-instance serverless or containerized deployment, in-memory rate limiters maintain isolated state per instance. This flaw enables attackers to bypass quotas via instance-hopping, allows high-concurrency bursts across distributed instances, and permits noisy neighbors to deplete shared shared capacity.

The WhatsApp & Email Platform employs an atomic, distributed rate-limiting engine backed by the **PostgreSQL `RateLimit` table**, which every serverless instance shares. There is no Redis.

---

## 2. Atomic Fixed-Window Counter

Each check is a single `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` on the `RateLimit` row for the key:
- If the window (`resetAt`) has expired, the counter restarts at 1 with a new `resetAt`.
- Otherwise the counter is incremented; the request is allowed while `count <= limit`.
- `Retry-After` is the number of seconds until `resetAt`.

Because the increment and the read happen in one statement, concurrent requests across instances cannot over-admit (verified: exactly 10 of 40 simultaneous requests pass a limit of 10).

---

## 3. Rate Limit Tiers & Failure Modes

Endpoints are categorized into criticality tiers to ensure system resilience and fail-safe security:

| Criticality Tier | Failure Mode | Behavior if the database limiter is unavailable | Use Case |
| :--- | :--- | :--- | :--- |
| **`CRITICAL`** | **Fail-Closed** | Rejects with HTTP `503 Service Unavailable`, `RATE_LIMITER_UNAVAILABLE`, and `Retry-After: 5`. | Auth login, Password reset, Email verification, OTP request/verify. |
| **`HIGH`** | **Graceful Degradation** | Degrades to a per-instance in-memory limiter. | Public email send (`/api/v1/email/send`), Public WhatsApp send (`/api/v1/messages`). |
| **`STANDARD`** | **Graceful Degradation** | Degrades to fallback storage; preserves business operations with warning logs. | Campaign dispatch, template test sends, admin management actions. |
| **`LOW`** | **Fail-Open** | Allows traffic without blocking inbound webhooks; logs alerts for monitoring. | Inbound webhook receivers (WhatsApp webhook, Gmail/SES webhooks). |

---

## 4. Multi-Dimensional Isolation & Abuse Defense

Rate limiting is evaluated along multiple dimensions simultaneously to prevent evasion:

### A. Tenant Quota Isolation
- **Key Prefix**: `rl:tenant:{clientId}:{route}`
- Guarantees that Tenant A cannot exhaust Tenant B's sending quotas.

### B. Client IP Protection
- **Key Prefix**: `rl:ip:{route}:{ip}`
- Extracts genuine client IP via `x-forwarded-for`, `x-real-ip`, or `req.ip`.
- Prevents instance hopping across distributed serverless nodes.

### C. Per-Recipient Abuse Protection
- **Key Prefix**: `rl:tenant:{clientId}:rcpt:{normalizedEmail}`
- Restricts sending frequency to a single recipient email address across all channels (prevents inbox bombing and phishing amplification).

### D. Account Credential Brute-Force Defense
- **Key Prefix**: `rl:acct:{normalizedEmail}:login`
- Limits total login attempts per target email across all IP addresses to mitigate distributed credential-stuffing attacks.

---

## 5. Authoritative Rate-Limit Policies Matrix

| Endpoint | Method | Dimension / Scope | Limit | Window | Criticality | Error Code | HTTP Status |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `/api/v1/email/send` | POST | Tenant Quota | 60 | 60s (1m) | `HIGH` | `RATE_LIMIT_EXCEEDED` | 429 |
| `/api/v1/email/send` | POST | Client IP | 60 | 60s (1m) | `HIGH` | `RATE_LIMIT_EXCEEDED` | 429 |
| `/api/v1/email/send` | POST | Recipient Abuse (`rl:tenant:*:rcpt:*`) | 10 | 60s (1m) | `HIGH` | `RECIPIENT_RATE_LIMITED` | 429 |
| `/api/v1/messages` (WhatsApp) | POST | Tenant Quota | 60 | 60s (1m) | `HIGH` | `RATE_LIMIT_EXCEEDED` | 429 |
| `/api/v1/messages` (WhatsApp) | POST | Client IP | 60 | 60s (1m) | `HIGH` | `RATE_LIMIT_EXCEEDED` | 429 |
| `/api/v1/messages` (WhatsApp) | POST | Recipient Phone (`rl:tenant:*:phone:*`) | 30 | 60s (1m) | `HIGH` | `RECIPIENT_RATE_LIMITED` | 429 |
| `/api/v1/otp/request` | POST | Client IP & Destination | 5 | 900s (15m) | `CRITICAL` | `RATE_LIMIT_EXCEEDED` | 429 (503 if limiter unavailable) |
| `/api/v1/otp/verify` | POST | Client IP & Destination | 5 | 900s (15m) | `CRITICAL` | `RATE_LIMIT_EXCEEDED` | 429 (503 if limiter unavailable) |
| `/api/auth/login` | POST | Client IP (`login:{ip}`) | 10 | 900s (15m) | `CRITICAL` | `RATE_LIMIT_EXCEEDED` | 429 (503 if limiter unavailable) |
| `/api/auth/login` | POST | Target Account (`rl:acct:{email}:login`) | 25 | 900s (15m) | `CRITICAL` | `ACCOUNT_RATE_LIMITED` | 429 (503 if limiter unavailable) |
| `/api/auth/forgot-password` | POST | Client IP | 5 | 900s (15m) | `CRITICAL` | `RATE_LIMIT_EXCEEDED` | 429 (503 if limiter unavailable) |
| `/api/auth/forgot-password` | POST | Target Account | 3 | 900s (15m) | `CRITICAL` | `RATE_LIMIT_EXCEEDED` | 429 (503 if limiter unavailable) |
| `/api/auth/reset-password` | POST | Client IP | 10 | 900s (15m) | `CRITICAL` | `RATE_LIMIT_EXCEEDED` | 429 (503 if limiter unavailable) |
| `/api/auth/send-verification` | POST | Client IP | 5 | 900s (15m) | `CRITICAL` | `RATE_LIMIT_EXCEEDED` | 429 (503 if limiter unavailable) |
| `/api/auth/send-verification` | POST | Target Account | 3 | 900s (15m) | `CRITICAL` | `RATE_LIMIT_EXCEEDED` | 429 (503 if limiter unavailable) |
| `/api/auth/verify-email` | GET | Client IP | 20 | 900s (15m) | `CRITICAL` | `RATE_LIMIT_EXCEEDED` | 429 (503 if limiter unavailable) |
| `/api/email/templates/[id]/test-send` | POST | Tenant Quota | 10 | 60s (1m) | `STANDARD` | `RATE_LIMIT_EXCEEDED` | 429 |
| `/api/email/templates/[id]/test-send` | POST | Test Recipient | 5 | 60s (1m) | `STANDARD` | `RECIPIENT_RATE_LIMITED` | 429 |
| `/api/email/campaigns/[id]/test-send` | POST | Tenant Quota | 10 | 60s (1m) | `STANDARD` | `RATE_LIMIT_EXCEEDED` | 429 |
| `/api/email/campaigns/[id]/test-send` | POST | Test Recipient | 5 | 60s (1m) | `STANDARD` | `RECIPIENT_RATE_LIMITED` | 429 |
| `/api/email/campaigns` | POST | Tenant Campaign Creation | 20 | 60s (1m) | `STANDARD` | `RATE_LIMIT_EXCEEDED` | 429 |
| `/api/email/campaigns/[id]/send` | POST | Tenant Campaign Dispatch | 10 | 60s (1m) | `STANDARD` | `RATE_LIMIT_EXCEEDED` | 429 |
| `/api/admin/email/providers/health` | GET/POST | Admin Health Probes | 15 | 60s (1m) | `STANDARD` | `RATE_LIMIT_EXCEEDED` | 429 |
| `/api/admin/email/providers/google/oauth` | GET | Admin OAuth Initiation | 10 | 60s (1m) | `STANDARD` | `RATE_LIMIT_EXCEEDED` | 429 |
| `/api/email/webhooks/[provider]` | POST | Provider Inbound IP | 1200 | 60s (1m) | `LOW` | `RATE_LIMIT_EXCEEDED` | 429 (fail-open) |
| `/api/webhooks/whatsapp` | POST | Meta Webhook IP | 1200 | 60s (1m) | `LOW` | `RATE_LIMIT_EXCEEDED` | 429 (fail-open) |

---

## 6. HTTP Response Headers Contract

When rate limits are enforced, standard response headers are emitted for transparency and automated client backoff:

```http
HTTP/1.1 429 Too Many Requests
Content-Type: application/json
Retry-After: 35
X-RateLimit-Limit: 60
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 35

{
  "success": false,
  "error": {
    "code": "RECIPIENT_RATE_LIMITED",
    "message": "Too many emails sent to this recipient. Please wait before retrying.",
    "retryAfter": 35
  }
}
```

When a **`CRITICAL`** rate limiter fails closed because the database limiter is unavailable:
```http
HTTP/1.1 503 Service Unavailable
Content-Type: application/json
Retry-After: 5
X-RateLimit-Limit: 10
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 5

{
  "success": false,
  "error": {
    "code": "RATE_LIMITER_UNAVAILABLE",
    "message": "Security service unavailable. Please retry shortly.",
    "retryAfter": 5
  }
}
```

---

## 7. Health & Monitoring Observability

Rate limiter health is monitored in real-time through:
- **`GET /api/health`**:
  Includes `components.rateLimiter`:
  ```json
  {
    "status": "healthy",
    "backend": "postgres",
    "latencyMs": 4
  }
  ```
- **`GET /api/admin/email/queue/health`**:
  Exposes PostgreSQL connectivity, queue depth, processor liveness and rate limiter health to administrators.

---

## 8. Verification & Distributed Concurrency Test Suite

Automated verification is maintained under:
```bash
npm run test:ratelimit
```
This suite verifies:
1. **Multi-Node Concurrency**: 4 simulated serverless instances firing 40 concurrent requests against a limit of 10 — exactly 10 requests succeed and 30 are rejected.
2. **Cross-Tenant Isolation**: Tenant A exhausting quota has zero impact on Tenant B.
3. **Instance Hopping Defense**: Shared IP state across simulated instances blocks evasion.
4. **Per-Recipient Protection**: Throttles individual recipient targeting while permitting distinct recipients.
5. **Fail-Closed vs Safe Degradation**: Simulates a limiter backend outage to prove `CRITICAL` fails closed with HTTP 503 while `STANDARD`/`LOW` degrades gracefully.
