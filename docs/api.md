# Public REST API Reference (`/api/v1`)

The Public REST API enables external applications (e.g. e-commerce engines, notification services, CRM platforms) to send and receive WhatsApp messages and perform OTP verification.

---

## Authentication

All `/api/v1/*` endpoints require Bearer API Key authentication:

```http
Authorization: Bearer whub_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

API keys are validated against HMAC-SHA256 digests stored in the database. Raw keys are never stored.

---

## Rate Limiting

The public API enforces sliding-window in-memory rate limiting:

| Endpoint | Rate Limit | Scope |
|---|---|---|
| `POST /api/v1/messages` | 60 requests / minute | Per API Key |
| `POST /api/v1/otp/request` | 5 requests / minute | Per Destination Phone Number |
| `POST /api/v1/otp/verify` | 10 attempts / minute | Per Destination Phone Number |

If a limit is exceeded, the server returns HTTP `429 Too Many Requests`:
```json
{
  "success": false,
  "error": "Rate limit exceeded. Please try again later."
}
```

---

## 1. Send Message

`POST /api/v1/messages`

Dispatches a text message or a pre-approved Meta template message.

### Request Headers
- `Authorization: Bearer <raw_api_key>` (Required)
- `Content-Type: application/json` (Required)
- `Idempotency-Key: <unique_client_key>` (Optional - prevents duplicate sending)

### Payload 1: Free-form Text Message
> Requires an open 24-hour customer care window with the recipient.

```json
{
  "to": "919876543210",
  "type": "text",
  "body": "Your appointment is confirmed for tomorrow at 10:00 AM."
}
```

### Payload 2A: Template Message (Simple Format)
Simple string arrays are automatically mapped to template body text parameters (`{{1}}`, `{{2}}`, etc.):

```json
{
  "to": "919876543210",
  "type": "template",
  "templateName": "order_confirmation",
  "templateLanguage": "en_US",
  "templateParameters": ["Alice", "ORD-12345"]
}
```

### Payload 2B: Template Message (Structured Meta Components)
Full Meta template components for body, header, and dynamic buttons (URL/quick reply):

```json
{
  "to": "919876543210",
  "type": "template",
  "templateName": "order_confirmation",
  "templateLanguage": "en_US",
  "templateParameters": [
    {
      "type": "body",
      "parameters": [
        { "type": "text", "text": "Alice" },
        { "type": "text", "text": "ORD-12345" }
      ]
    },
    {
      "type": "button",
      "sub_type": "url",
      "index": "0",
      "parameters": [
        { "type": "text", "text": "orders/ORD-12345" }
      ]
    }
  ]
}
```

### Success Response (HTTP 200 OK)
```json
{
  "success": true,
  "data": {
    "id": "cm7...unique_uuid",
    "providerMessageId": "wamid.HBgL...",
    "status": "SENT",
    "to": "919876543210",
    "type": "TEXT",
    "sentAt": "2026-09-14T17:00:00.000Z"
  }
}
```

---

## 2. Get Message Details

`GET /api/v1/messages/{id}`

Retrieves message metadata, current status, and full delivery audit trail.

### Success Response (HTTP 200 OK)
```json
{
  "success": true,
  "data": {
    "id": "cm7...unique_uuid",
    "providerMessageId": "wamid.HBgL...",
    "direction": "OUTBOUND",
    "type": "TEXT",
    "status": "DELIVERED",
    "to": "919876543210",
    "from": "15550123456",
    "body": "Your appointment is confirmed...",
    "createdAt": "2026-09-14T17:00:00.000Z",
    "events": [
      { "id": "ev_1", "status": "SENT", "createdAt": "2026-09-14T17:00:01.000Z" },
      { "id": "ev_2", "status": "DELIVERED", "createdAt": "2026-09-14T17:00:04.000Z" }
    ]
  }
}
```

---

## 3. List Messages

`GET /api/v1/messages`

### Query Parameters
- `direction`: Filter by `INBOUND` or `OUTBOUND`
- `status`: Filter by `QUEUED`, `SENT`, `DELIVERED`, `READ`, `FAILED`
- `to`: Filter by recipient phone number
- `from`: Filter by sender phone number
- `page`: Page index (default: `1`)
- `limit`: Items per page (default: `50`, max: `100`)

---

## 4. List Conversations

`GET /api/v1/conversations`

Returns grouped conversation summaries by participant phone number with latest message preview and unread counters.

---

## 5. Request OTP

`POST /api/v1/otp/request`

Generates a secure 6-digit numeric OTP, stores the HMAC hash, and dispatches it to the destination WhatsApp number.

### Request Payload
```json
{
  "to": "919876543210",
  "purpose": "login",
  "templateName": "auth_otp_code",
  "templateLanguage": "en_US"
}
```

### Success Response (HTTP 200 OK)
```json
{
  "success": true,
  "data": {
    "message": "OTP generated and dispatched successfully",
    "expiresInSeconds": 300
  }
}
```

---

## 6. Verify OTP

`POST /api/v1/otp/verify`

Validates a user-submitted OTP against the stored digest. Increments attempt counters and automatically invalidates on match or exhaustion.

### Request Payload
```json
{
  "to": "919876543210",
  "purpose": "login",
  "code": "849201"
}
```

### Success Response (HTTP 200 OK)
```json
{
  "success": true,
  "data": {
    "verified": true,
    "message": "OTP verified successfully"
  }
}
```

### Invalid / Expired Code (HTTP 400 Bad Request)
```json
{
  "success": false,
  "error": "Invalid or expired OTP code"
}
```

---

## 7. Administrative Data Cleanup (Local-Dev Only)

`POST /api/admin/clean-data`

> ⚠️ **SAFETY WARNING**: This endpoint is strictly for local development and test resetting. It is **permanently disabled in production environments** (returns HTTP 403 Forbidden).

### Headers
- `Cookie: whatsapp_hub_session=<token>` (Admin session cookie required)
- `Content-Type: application/json`

### Required Request Payload
To prevent accidental invocation, an explicit confirmation body is strictly mandatory:
```json
{
  "confirm": "DELETE_ALL_LOCAL_DATA"
}
```

Requests without this exact confirmation string are rejected with HTTP 400 Bad Request.

---

## 8. Public Email Send API

`POST /api/v1/email/send`

Dispatches a transactional or promotional email. Requests are authenticated via Bearer API Key, tenant-scoped, and processed asynchronously via the BullMQ email queue.

### Request Headers
- `Authorization: Bearer whub_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx` (Required)
- `Content-Type: application/json` (Required)
- `Idempotency-Key: <unique_client_key>` (Optional - prevents duplicate sending)

### Rate Limiting
- **Limit**: 60 requests / minute per API key.
- Returns HTTP 429 Too Many Requests if exceeded.

### Payload Schema Requirements
- `to`: Recipient email address string (e.g. `"user@example.com"`) or object (`{ "email": "user@example.com", "name": "Jane Doe" }`).
- `type`: **STRICTLY REQUIRED**. Must be explicitly `"TRANSACTIONAL"` or `"PROMOTIONAL"`. Ambiguous or omitted values return HTTP 400.
- `subject`: Email subject line (Required unless using a template that defines a subject).
- `html`: HTML message body (Optional if `templateId` is provided).
- `text`: Plain text alternative (Optional).
- `templateId`: ID of an existing tenant `EmailTemplate` (Optional).
- `variables`: Key-value map of variable substitutions for template rendering (Optional).
- `senderId`: ID of an authorized tenant sender identity (Optional).
- `headers`: Custom RFC 2822 email headers (Optional).

### Payload Example 1: Direct Transactional Email
```json
{
  "to": "alice@example.com",
  "type": "TRANSACTIONAL",
  "subject": "Your Security Code",
  "html": "<p>Your one-time passcode is <strong>849201</strong>.</p>",
  "text": "Your one-time passcode is 849201."
}
```

### Payload Example 2: Templated Promotional Email
```json
{
  "to": {
    "email": "customer@example.com",
    "name": "Alex Smith"
  },
  "type": "PROMOTIONAL",
  "templateId": "tpl_clx123abc456",
  "variables": {
    "firstName": "Alex",
    "discountCode": "SUMMER50",
    "expiryDate": "2026-10-01"
  }
}
```

### Promotional Safety Guarantees
For `PROMOTIONAL` emails:
1. **Suppression Check**: Automatically verified against the tenant's suppression list (`EmailSuppression`). Suppressed recipients are immediately rejected with `400 Bad Request` (`RECIPIENT_SUPPRESSED`).
2. **Marketing Consent Check**: If the recipient exists in `EmailContact`, `hasMarketingConsent` must be `true`. If `false`, the dispatch is rejected with `400 Bad Request` (`MISSING_CONSENT`).
3. **One-Click Unsubscribe**: Compliant RFC 8058 `List-Unsubscribe` headers are automatically injected into every promotional dispatch.

### Success Response (HTTP 200 OK)
```json
{
  "success": true,
  "data": {
    "deliveryId": "del_clx789xyz123",
    "status": "QUEUED",
    "message": "Email queued successfully for dispatch"
  }
}
```

### Error Responses
- **HTTP 401 Unauthorized**: Missing or invalid Bearer API key.
- **HTTP 400 Bad Request**:
  - Missing or invalid `type` field (`VALIDATION_ERROR`).
  - Missing body content and missing `templateId`.
  - Recipient is suppressed (`RECIPIENT_SUPPRESSED`).
  - Recipient lacks marketing consent for promotional email (`MISSING_CONSENT`).
- **HTTP 404 Not Found**: Specified `templateId` or `senderId` does not exist in tenant.
- **HTTP 429 Too Many Requests**: Rate limit exceeded.


