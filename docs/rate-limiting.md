# Distributed Rate Limiting & Abuse Protection Architecture

## 1. Overview & High-Availability Model

In a multi-instance serverless or containerized deployment, in-memory rate limiters maintain isolated state per instance. This flaw enables attackers to bypass quotas via instance-hopping, allows high-concurrency bursts across distributed instances, and permits noisy neighbors to deplete shared shared capacity.

The WhatsApp & Email Platform employs an atomic, distributed rate-limiting engine powered by **Redis** (with transactional Lua sliding-window scripts) and backed by PostgreSQL dual-layer persistence for auditability and graceful degradation.

---

## 2. Sliding Window Lua Engine

Rate limiting is implemented using an atomic sliding-window algorithm executed server-side via Redis Lua scripts:
- **`ZREMRANGEBYSCORE`**: Evicts timestamps older than `now - windowMs`.
- **`ZCARD`**: Evaluates total requests within the active sliding window.
- **`ZADD` & `PEXPIRE`**: Atomically records current request timestamps if under quota.
- **Deterministic Reset Calculation**: When a request is throttled, the oldest score in the set is inspected to compute the exact remaining seconds until the window opens, returned deterministically via the `Retry-After` header.

---

## 3. Rate Limit Tiers & Failure Modes

Endpoints are categorized into criticality tiers to ensure system resilience and fail-safe security:

| Criticality Tier | Failure Mode | Behavior on Redis Outage | Use Case |
| :--- | :--- | :--- | :--- |
| **`CRITICAL`** | **Fail-Closed** | Rejects with HTTP `503 Service Unavailable`, `RATE_LIMITER_UNAVAILABLE`, and `Retry-After: 5`. | Auth login, Password reset, Email verification, OTP request/verify. |
| **`HIGH`** | **Graceful Degradation** | Degrades to secondary PostgreSQL rate limit table or emergency memory store. | Public email send (`/api/v1/email/send`), Public WhatsApp send (`/api/v1/messages`). |
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
| `/api/v1/otp/request` | POST | Client IP & Destination | 5 | 900s (15m) | `CRITICAL` | `RATE_LIMIT_EXCEEDED` | 429 (503 on Redis fail) |
| `/api/v1/otp/verify` | POST | Client IP & Destination | 5 | 900s (15m) | `CRITICAL` | `RATE_LIMIT_EXCEEDED` | 429 (503 on Redis fail) |
| `/api/auth/login` | POST | Client IP (`login:{ip}`) | 10 | 900s (15m) | `CRITICAL` | `RATE_LIMIT_EXCEEDED` | 429 (503 on Redis fail) |
| `/api/auth/login` | POST | Target Account (`rl:acct:{email}:login`) | 25 | 900s (15m) | `CRITICAL` | `ACCOUNT_RATE_LIMITED` | 429 (503 on Redis fail) |
| `/api/auth/forgot-password` | POST | Client IP | 5 | 900s (15m) | `CRITICAL` | `RATE_LIMIT_EXCEEDED` | 429 (503 on Redis fail) |
| `/api/auth/forgot-password` | POST | Target Account | 3 | 900s (15m) | `CRITICAL` | `RATE_LIMIT_EXCEEDED` | 429 (503 on Redis fail) |
| `/api/auth/reset-password` | POST | Client IP | 10 | 900s (15m) | `CRITICAL` | `RATE_LIMIT_EXCEEDED` | 429 (503 on Redis fail) |
| `/api/auth/send-verification` | POST | Client IP | 5 | 900s (15m) | `CRITICAL` | `RATE_LIMIT_EXCEEDED` | 429 (503 on Redis fail) |
| `/api/auth/send-verification` | POST | Target Account | 3 | 900s (15m) | `CRITICAL` | `RATE_LIMIT_EXCEEDED` | 429 (503 on Redis fail) |
| `/api/auth/verify-email` | GET | Client IP | 20 | 900s (15m) | `CRITICAL` | `RATE_LIMIT_EXCEEDED` | 429 (503 on Redis fail) |
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

When a **`CRITICAL`** rate limiter fails closed due to Redis outage:
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
    "backend": "redis",
    "redisConnected": true,
    "latencyMs": 4
  }
  ```
- **`GET /api/admin/email/queue/health`**:
  Exposes Redis connectivity, queue latency, and rate limiter operational health to administrators.

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
5. **Fail-Closed vs Safe Degradation**: Simulates Redis outages to prove `CRITICAL` fails closed with HTTP 503 while `STANDARD`/`LOW` degrades gracefully.
