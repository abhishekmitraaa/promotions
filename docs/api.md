# Public REST API Specification (`/api/v1`)

All endpoints in `/api/v1` require Bearer API key authorization:

```http
Authorization: Bearer YOUR_API_KEY
```

---

## 1. Send Message
`POST /api/v1/messages`

### Headers
- `Authorization: Bearer <key>` (Required)
- `Content-Type: application/json` (Required)
- `Idempotency-Key: <unique-string>` (Optional)

### Request Payload (Text Message)
```json
{
  "to": "919876543210",
  "type": "text",
  "body": "Hello world!"
}
```

### Request Payload (Template Message)
```json
{
  "to": "919876543210",
  "type": "template",
  "templateName": "hello_world",
  "templateLanguage": "en_US"
}
```

### Response (200 OK)
```json
{
  "success": true,
  "message": {
    "id": "c1f7b8...-uuid",
    "providerMessageId": "wamid.HBgL...",
    "status": "SENT",
    "to": "919876543210",
    "type": "TEXT",
    "sentAt": "2026-09-13T22:00:00.000Z"
  }
}
```

---

## 2. Get Message Details
`GET /api/v1/messages/[id]`

---

## 3. List Messages
`GET /api/v1/messages?direction=OUTBOUND&status=SENT&page=1&limit=20`

---

## 4. List Conversations
`GET /api/v1/conversations`
