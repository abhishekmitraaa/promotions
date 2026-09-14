# Webhooks Architecture & Outgoing Dispatcher

## 1. Incoming Meta Webhook Receiver (`/api/webhooks/whatsapp`)

### Verification (`GET`)
Meta verifies webhook URLs by sending `hub.mode`, `hub.verify_token`, and `hub.challenge`.
The endpoint validates `hub.verify_token === META_WEBHOOK_VERIFY_TOKEN` and echoes `hub.challenge` as plain text.

### Payload Processing (`POST`)
Every POST request is signed by Meta in the `X-Hub-Signature-256` header.
The service computes HMAC SHA-256 over raw request body using `META_APP_SECRET` and performs timing-safe comparison.

---

## 2. Outgoing Webhook Dispatcher

When messages or OTP events occur, the dispatcher forwards JSON payloads to registered target URLs.

### Signature Header
Outgoing requests include:
```http
X-Webhook-Signature: sha256=<hex_digest>
X-Webhook-Event: message.received
```

Target applications can verify the payload signature using the endpoint's secret hash.
