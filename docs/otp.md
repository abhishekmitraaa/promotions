# OTP Verification Architecture & Usage

The service provides a complete, secure One-Time Password (OTP) generation and verification pipeline designed specifically for WhatsApp authentication workflows (logins, password resets, payment confirmations).

---

## 1. Security Architecture

### Zero Plaintext Storage
Raw OTP codes are **never** persisted in the database. Instead:
1. The service generates a 6-digit cryptographically random numeric code (`crypto.randomInt`).
2. The code is combined with the phone number and purpose:
   ```text
   digest = HMAC_SHA256(key = API_KEY_PEPPER, data = `${destination}:${purpose}:${code}`)
   ```
3. Only this digest is stored in the database.
4. During verification, the submitted code is hashed in the exact same manner and checked against the stored digest using timing-safe comparison.

### Automatic Invalidation
- **Single-Use**: Once verified successfully, an OTP is marked as used (`verified = true`) and cannot be used again.
- **Superseded Requests**: Requesting a new OTP for the same destination phone number and purpose automatically invalidates all previously active pending OTPs for that pair.
- **Configurable Expiration**: Controlled via `OTP_EXPIRY_SECONDS` (default: 300 seconds / 5 minutes).

### Strict Attempt Limits
- Each failed verification attempt increments `attempts`.
- If attempts exceed `OTP_MAX_ATTEMPTS` (default: 5), the OTP is permanently locked and invalidated to protect against brute-force guessing.

### In-Memory Sliding-Window Rate Limiting
- **Requesting OTPs**: Maximum 5 requests per minute per phone number.
- **Verifying OTPs**: Maximum 10 verification attempts per minute per phone number.

---

## 2. API Endpoints

### A. Request an OTP
`POST /api/v1/otp/request`

#### Headers
- `Authorization: Bearer <API_KEY>`
- `Content-Type: application/json`

#### Request Body
```json
{
  "to": "919876543210",
  "purpose": "login",
  "templateName": "auth_otp_code",
  "templateLanguage": "en_US"
}
```

#### Notes on Meta Delivery:
- In production, Meta mandates using an approved **Authentication Template** with an OTP button for automated copying.
- If `templateName` is provided, the service populates the template body parameter with the generated code.
- If running in local simulation mode without Meta credentials, the code is output to the local server console for testing.

---

### B. Verify an OTP
`POST /api/v1/otp/verify`

#### Headers
- `Authorization: Bearer <API_KEY>`
- `Content-Type: application/json`

#### Request Body
```json
{
  "to": "919876543210",
  "purpose": "login",
  "code": "582194"
}
```

#### Success Response (HTTP 200)
```json
{
  "success": true,
  "data": {
    "verified": true,
    "message": "OTP verified successfully"
  }
}
```

#### Failed / Expired Response (HTTP 400)
```json
{
  "success": false,
  "error": "Invalid or expired OTP code"
}
```
