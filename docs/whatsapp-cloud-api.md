# Meta WhatsApp Cloud API Integration Guide

## Meta Graph API Endpoint Pattern

The server dispatches native fetch HTTP requests to:

```text
https://graph.facebook.com/{META_GRAPH_API_VERSION}/{META_PHONE_NUMBER_ID}/messages
```

## Supported Payload Structures

### 1. Text Message
```json
{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "919876543210",
  "type": "text",
  "text": {
    "preview_url": false,
    "body": "Hello world"
  }
}
```

### 2. Template Message
```json
{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "919876543210",
  "type": "template",
  "template": {
    "name": "hello_world",
    "language": { "code": "en_US" }
  }
}
```

## Important Meta Constraints
- **24-Hour Customer Service Window**: Free-form text messages can only be delivered if the recipient has messaged your business in the last 24 hours. Outside this window, only pre-approved **Template Messages** can be sent.
- **Recipient Test Number List**: In Meta Development mode, recipients must be added to your account's designated test phone numbers list.
