# Meta WhatsApp Cloud API Integration Guide

This document describes how this service communicates with Meta's official WhatsApp Business Cloud API (Graph API) and how to configure your Meta Developer App.

---

## 1. Meta Developer Setup Checklist

To send live WhatsApp messages, complete the following in the [Meta for Developers](https://developers.facebook.com/) portal:

1. **Create an App**:
   - Type: **Business**.
   - Add the **WhatsApp** product to your app.
2. **Obtain Permanent System User Token**:
   - Temporary tokens expire in 24 hours. For a permanent token:
   - Go to **Business Manager** > **Business Settings** > **Users** > **System Users**.
   - Create a System User (role: Admin or Employee).
   - Generate a token with the following permissions:
     - `whatsapp_business_messaging`
     - `whatsapp_business_management`
   - Set this token as `META_ACCESS_TOKEN` in `.env.local`.
3. **Locate Phone Number ID and WABA ID**:
   - In App Dashboard > **WhatsApp** > **API Setup**:
   - Copy **Phone number ID** -> `META_PHONE_NUMBER_ID`.
   - Copy **WhatsApp Business Account ID** -> `META_WABA_ID`.
4. **App Secret & Webhooks**:
   - Go to App Dashboard > **App settings** > **Basic**.
   - Copy **App secret** -> `META_APP_SECRET`.
   - Create your own secret verify token string -> `META_WEBHOOK_VERIFY_TOKEN`.

---

## 2. Meta Graph API Endpoints

The service dispatches outbound HTTP requests via native `fetch` with an `AbortController` timeout:

```text
POST https://graph.facebook.com/{META_GRAPH_API_VERSION}/{META_PHONE_NUMBER_ID}/messages
Authorization: Bearer {META_ACCESS_TOKEN}
Content-Type: application/json
```

---

## 3. Supported Message Types

### Free-Form Text Message
```json
{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "919876543210",
  "type": "text",
  "text": {
    "preview_url": false,
    "body": "Hello Alice! Your package is out for delivery."
  }
}
```

### Pre-Approved Template Message
Templates allow business-initiated messaging outside the 24-hour customer care window.

```json
{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "919876543210",
  "type": "template",
  "template": {
    "name": "shipping_update",
    "language": {
      "code": "en_US"
    },
    "components": [
      {
        "type": "body",
        "parameters": [
          { "type": "text", "text": "Alice" },
          { "type": "text", "text": "ORD-1234" }
        ]
      },
      {
        "type": "button",
        "sub_type": "url",
        "index": "0",
        "parameters": [
          { "type": "text", "text": "track/ORD-1234" }
        ]
      }
    ]
  }
}
```

---

## 4. Key Meta Rules & Constraints

### 24-Hour Customer Care Window
- Free-form text messages can only be delivered if the user sent an inbound message to your number within the last 24 hours.
- Outside this window, Meta will reject text messages with error code `131047` ("Re-engagement message").
- To message users outside the 24-hour window, you must use an approved **Template Message**.

### Test Numbers (Development Mode)
- While your Meta App is in **Development Mode**, you can only send messages to phone numbers that you have explicitly added to your **To** test numbers list in the Meta App Dashboard (**WhatsApp** > **API Setup**).
- Sending to unlisted numbers returns error `131030` ("Recipient phone number not in allowed list").

---

## 5. Common Error Codes & Troubleshooting

| Error Code | Meaning | Resolution |
|---|---|---|
| `190` | Invalid OAuth access token | Regenerate System User token; check token permissions. |
| `131030` | Recipient phone number not in allowed list | Add recipient number to test numbers in Meta Console (Dev Mode) or switch app to Live Mode. |
| `131047` | Message failed outside 24-hour window | Use an approved Template message instead of free-form text. |
| `132000` | Template does not exist | Check `templateName` and `templateLanguage` match your approved Meta template exactly. |
| `132001` | Template parameter count mismatch | Verify that your `templateParameters` match the number of variables in the template body. |
