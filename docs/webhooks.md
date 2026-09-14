# Webhooks Architecture & Outgoing Dispatcher

This service provides a bi-directional webhook architecture:
1. **Inbound Webhook Receiver (`/api/webhooks/whatsapp`)**: Receives and verifies real-time events from Meta.
2. **Outgoing Webhook Dispatcher**: Delivers signed events to your external subscriber applications with retry support.

---

## 1. Inbound Meta Webhook Receiver (`/api/webhooks/whatsapp`)

Meta sends two kinds of HTTP requests to your webhook endpoint:

### A. Verification Handshake (`GET`)
When configuring your webhook in Meta Developer Console, Meta sends a `GET` request with:
- `hub.mode=subscribe`
- `hub.verify_token`: Your configured verification secret
- `hub.challenge`: A random string

The server validates that `hub.verify_token === META_WEBHOOK_VERIFY_TOKEN` and echoes the `hub.challenge` string with HTTP 200.

### B. Event Notification (`POST`)
When an event occurs (e.g. user sends a message, or a message changes state to `delivered`), Meta posts a JSON payload.

#### Cryptographic Security (`X-Hub-Signature-256`)
- Meta signs every request body using HMAC-SHA256 with your `META_APP_SECRET`.
- The signature is passed in the header:
  ```http
  X-Hub-Signature-256: sha256=<hex_digest>
  ```
- The service performs a timing-safe digest comparison (`crypto.timingSafeEqual`) to prevent timing attack vulnerabilities. If the signature does not match, the request is rejected with HTTP 401 Unauthorized.

#### Ingested Events
- **Incoming Messages (`direction = INBOUND`)**: Stored in the messages table, updates or creates conversation threads, and emits `message.received`.
- **Status Updates (`SENT`, `DELIVERED`, `READ`, `FAILED`)**: Updates the message status in the database, records an entry in `message_events`, and emits corresponding `message.<status>` events.

---

## 2. Outgoing Webhook Dispatcher

When messaging events occur inside the service, the dispatcher forwards them to all matching registered webhook endpoints.

### Managing Endpoints
You can register endpoints in the Web Dashboard under `/dashboard/webhooks` or via `POST /api/admin/webhooks`.

Each endpoint defines:
- `name`: Descriptive label (e.g. "Primary CRM")
- `url`: Destination HTTPS endpoint
- `events`: Array of subscribed events or `["*"]` for all

### Subscribable Events
- `message.received`: When an inbound message arrives from a user
- `message.sent`: When an outbound message is accepted by Meta
- `message.delivered`: When a message is delivered to the recipient device
- `message.read`: When a message is read by the recipient
- `message.failed`: When delivery fails or is rejected
- `otp.requested`: When an OTP is generated
- `otp.verified`: When an OTP is successfully validated

### Security for Subscriber Apps
The service signs all outgoing webhook dispatches with HMAC-SHA256:
```http
Content-Type: application/json
X-Webhook-Signature: sha256=<hex_digest>
X-Webhook-Event: message.received
```
Subscribers can verify the payload using their endpoint secret hash.

### Outgoing Delivery Logging & Retries
Every delivery attempt (status code, execution time, error response) is recorded in `webhook_deliveries`. If a delivery fails, operators can trigger a manual retry directly from the Web Dashboard (`/dashboard/webhooks`) or via `POST /api/admin/webhooks/deliveries`.
