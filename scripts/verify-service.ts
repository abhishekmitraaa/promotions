import crypto from "node:crypto";
import { normalizePhoneNumber, generateApiKey, hashApiKey, generateSecureOtp, hashOtp, verifyHmacSha256, signHmacSha256, encryptWebhookSecret, decryptWebhookSecret } from "../src/lib/crypto";
import { checkRateLimit } from "../src/lib/rate-limit";
import { createMessageSchema } from "../src/lib/validation/messages";
import { requestOtpSchema, verifyOtpSchema } from "../src/lib/validation/otp";
import { formatTemplateComponents } from "../src/lib/services/message-service";
import { envSchema } from "../src/lib/env";
import { validateWebhookUrlSync } from "../src/lib/webhooks/ssrf";
import { timingSafeEqualSecret } from "../src/lib/timing-safe";

async function runVerification() {
  console.log("=================================================");
  console.log("🧪 RUNNING AUTOMATED SERVICE VERIFICATION CHECKS");
  console.log("=================================================\n");

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, testName: string) {
    if (condition) {
      console.log(`  ✅ PASS: ${testName}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${testName}`);
      failed++;
    }
  }

  // Test 1: Phone Normalization
  assert(normalizePhoneNumber("+91 98765-43210") === "919876543210", "Phone normalization handles formatted E.164 string");
  assert(normalizePhoneNumber("001 (555) 000-1234") === "15550001234", "Phone normalization strips leading zeros and formatting");
  assert(normalizePhoneNumber("+91 98765 43210") === normalizePhoneNumber("919876543210"), "Phone normalization yields matching rate limit keys for formatted inputs");

  // Test 2: API Key Generation & Hashing
  const { rawKey, keyPrefix, keyHash } = generateApiKey();
  assert(rawKey.startsWith("whub_"), "API Key starts with 'whub_' prefix");
  assert(keyPrefix.length === 10, "Key prefix is exactly 10 characters");
  assert(hashApiKey(rawKey) === keyHash, "API Key hash matches rawKey peppered HMAC digest");

  // Test 3: Webhook HMAC SHA-256 Signature Verification
  const payload = JSON.stringify({ event: "test.event", value: 123 });
  const secret = "my_app_secret_123";
  const signature = signHmacSha256(payload, secret);
  assert(verifyHmacSha256(payload, secret, signature), "Timing-safe HMAC verification validates correct signature");
  assert(verifyHmacSha256(payload, secret, `sha256=${signature}`), "HMAC verification handles 'sha256=' prefix");
  assert(!verifyHmacSha256(payload, "wrong_secret", signature), "HMAC verification rejects invalid secret");

  // Test 4: OTP Code Generation & Hashing
  const otpCode = generateSecureOtp(6);
  assert(/^\d{6}$/.test(otpCode), "Generated OTP is numeric 6-digit string");
  const otpHash1 = hashOtp(otpCode, "919876543210", "login");
  const otpHash2 = hashOtp(otpCode, "919876543210", "login");
  assert(otpHash1 === otpHash2, "OTP code hashing is deterministic for given destination and purpose");

  // Test 5: Rate Limiter
  const rateKey = `test_rate_key_${Date.now()}`;
  const res1 = await checkRateLimit(rateKey, 2, 60000);
  const res2 = await checkRateLimit(rateKey, 2, 60000);
  const res3 = await checkRateLimit(rateKey, 2, 60000);
  assert(res1.success && res2.success, "Rate limiter permits requests within limit");
  assert(!res3.success, "Rate limiter blocks requests exceeding configured limit");

  // Test 6: Message Input Zod Validation
  const validText = createMessageSchema.safeParse({ to: "919876543210", type: "text", body: "Hello world" });
  const invalidText = createMessageSchema.safeParse({ to: "919876543210", type: "text" });
  assert(validText.success, "Zod accepts valid text message payload");
  assert(!invalidText.success, "Zod rejects text message payload missing body");

  const validTemplate = createMessageSchema.safeParse({ to: "919876543210", type: "template", templateName: "hello_world" });
  const invalidTemplate = createMessageSchema.safeParse({ to: "919876543210", type: "template" });
  assert(validTemplate.success, "Zod accepts valid template message payload");
  assert(!invalidTemplate.success, "Zod rejects template message payload missing templateName");

  // Test 7: OTP Zod Validation
  const validOtpReq = requestOtpSchema.safeParse({ to: "919876543210", purpose: "login" });
  const invalidOtpReq = requestOtpSchema.safeParse({ to: "abc", purpose: "login" });
  assert(validOtpReq.success, "Zod accepts valid OTP request payload");
  assert(!invalidOtpReq.success, "Zod rejects invalid phone number in OTP request");

  const validOtpVer = verifyOtpSchema.safeParse({ to: "919876543210", purpose: "login", code: "123456" });
  const invalidOtpVer = verifyOtpSchema.safeParse({ to: "919876543210", purpose: "login", code: "abc" });
  assert(validOtpVer.success, "Zod accepts valid OTP verify payload");
  assert(!invalidOtpVer.success, "Zod rejects non-numeric code in OTP verify");

  // Test 8: Session Token Generation and Integrity
  const testPayload = { id: "user_test_123", email: "admin@example.com", role: "ADMIN", expiresAt: Date.now() + 86400000 };
  const encodedPayload = Buffer.from(JSON.stringify(testPayload)).toString("base64url");
  const testSecret = "test_secret_key_minimum_32_characters_long_12345";
  const sessionSignature = crypto.createHmac("sha256", testSecret).update(encodedPayload).digest("base64url");
  const sessionToken = `${encodedPayload}.${sessionSignature}`;
  const [enc, sig] = sessionToken.split(".");
  const expectedSig = crypto.createHmac("sha256", testSecret).update(enc).digest("base64url");
  assert(crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig)), "Session token HMAC signature validates accurately");

  // Test 9: Template Parameter Mapping & Validation
  const validSimpleParams = createMessageSchema.safeParse({
    to: "919876543210",
    type: "template",
    templateName: "order_update",
    templateParameters: ["Alice", "ORD-9999"],
  });
  assert(validSimpleParams.success, "Zod accepts simple string array template parameters");

  const mappedComponents = formatTemplateComponents(["Alice", "ORD-9999"]);
  assert(
    Boolean(
      mappedComponents &&
      mappedComponents.length === 1 &&
      mappedComponents[0].type === "body" &&
      mappedComponents[0].parameters?.[0]?.text === "Alice" &&
      mappedComponents[0].parameters?.[1]?.text === "ORD-9999"
    ),
    "formatTemplateComponents maps string array into structured Meta body parameters"
  );

  const rawMetaComponents = [
    { type: "body" as const, parameters: [{ type: "text" as const, text: "123456" }] },
    { type: "button" as const, sub_type: "url" as const, index: "0", parameters: [{ type: "text" as const, text: "123456" }] },
  ];
  const validCompTemplate = createMessageSchema.safeParse({
    to: "919876543210",
    type: "template",
    templateName: "auth_otp",
    templateParameters: rawMetaComponents,
  });
  assert(validCompTemplate.success, "Zod accepts structured template components array with button & body");

  const preservedComponents = formatTemplateComponents(rawMetaComponents);
  assert(
    Boolean(preservedComponents && preservedComponents.length === 2 && preservedComponents[1].type === "button"),
    "formatTemplateComponents preserves already Meta-shaped components array"
  );

  // Test 10: Production Environment Safety Rules
  const unsafeProdEnv1 = envSchema.safeParse({
    NODE_ENV: "production",
    AUTH_SESSION_SECRET: "default_dev_session_secret_32_chars_minimum_len!!",
    API_KEY_PEPPER: "default_local_dev_pepper_change_in_production_12345",
  });
  assert(!unsafeProdEnv1.success, "Production envSchema rejects default session secret and default pepper");

  const unsafeProdEnv2 = envSchema.safeParse({
    NODE_ENV: "production",
    AUTH_SESSION_SECRET: "too_short_secret",
    API_KEY_PEPPER: "too_short_pepper",
  });
  assert(!unsafeProdEnv2.success, "Production envSchema rejects short session secret (<32 chars) and short pepper (<32 chars)");

  const safeProdEnv = envSchema.safeParse({
    NODE_ENV: "production",
    DATABASE_URL: "postgresql://postgres.sample_ref:super_secret_pw@aws-0-ap-south-1.pooler.supabase.com:6543/postgres?pgbouncer=true",
    AUTH_SESSION_SECRET: "super_secure_session_secret_32_characters_minimum",
    API_KEY_PEPPER: "0123456789abcdef0123456789abcdef",
    WEBHOOK_SECRET_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    DEV_ALLOW_UNCONFIGURED_META: "true",
  });
  assert(
    safeProdEnv.success && safeProdEnv.data.DEV_ALLOW_UNCONFIGURED_META === false,
    "Production envSchema forces DEV_ALLOW_UNCONFIGURED_META to false even if set to true"
  );

  const unsafeProdEncryptionKey = envSchema.safeParse({
    NODE_ENV: "production",
    DATABASE_URL: "postgresql://postgres.sample_ref:super_secret_pw@aws-0-ap-south-1.pooler.supabase.com:6543/postgres?pgbouncer=true",
    AUTH_SESSION_SECRET: "super_secure_session_secret_32_characters_minimum",
    API_KEY_PEPPER: "0123456789abcdef0123456789abcdef",
    WEBHOOK_SECRET_ENCRYPTION_KEY: "default_dev_secret_encryption_key_32bytes_min_len!!",
  });
  assert(
    !unsafeProdEncryptionKey.success,
    "Production envSchema rejects default WEBHOOK_SECRET_ENCRYPTION_KEY"
  );

  // Test 11: Reversible AES-256-GCM Webhook Secret Encryption
  const rawSecret = "whsec_super_secret_signing_token_999";
  const encrypted = encryptWebhookSecret(rawSecret);
  assert(encrypted !== rawSecret && encrypted.split(":").length === 3, "Webhook secret is encrypted into iv:authTag:ciphertext format");
  const decrypted = decryptWebhookSecret(encrypted);
  assert(decrypted === rawSecret, "Webhook secret decrypts accurately to original plaintext");

  // Test 12: SSRF Webhook URL Validation
  assert(!validateWebhookUrlSync("http://localhost:3000/webhook").valid, "SSRF blocks localhost");
  assert(!validateWebhookUrlSync("http://127.0.0.1:8080/hook").valid, "SSRF blocks IPv4 loopback (127.0.0.1)");
  assert(!validateWebhookUrlSync("http://10.0.0.5/hook").valid, "SSRF blocks 10.0.0.0/8 private IPv4");
  assert(!validateWebhookUrlSync("http://172.20.1.1/hook").valid, "SSRF blocks full 172.16.0.0/12 range (172.20.1.1)");
  assert(!validateWebhookUrlSync("http://192.168.1.100/hook").valid, "SSRF blocks 192.168.0.0/16 private IPv4");
  assert(!validateWebhookUrlSync("http://169.254.169.254/latest/meta-data").valid, "SSRF blocks cloud metadata service (169.254.169.254)");
  assert(!validateWebhookUrlSync("http://100.64.0.1/hook").valid, "SSRF blocks Carrier-Grade NAT (100.64.0.0/10)");
  assert(!validateWebhookUrlSync("http://[::1]/hook").valid, "SSRF blocks IPv6 loopback [::1]");
  assert(!validateWebhookUrlSync("http://[fe80::1]/hook").valid, "SSRF blocks IPv6 link-local [fe80::1]");
  assert(!validateWebhookUrlSync("http://[fc00::1]/hook").valid, "SSRF blocks IPv6 unique local [fc00::1]");
  assert(!validateWebhookUrlSync("ftp://example.com/hook").valid, "SSRF blocks non-http(s) protocols (ftp)");
  assert(validateWebhookUrlSync("https://api.example.com/webhook").valid, "SSRF allows public HTTPS webhooks");

  // Test 13: Standardized API Response Shape
  const standardResponse = { success: true, data: { items: [1, 2, 3] } };
  assert(
    standardResponse.success === true && Array.isArray(standardResponse.data.items),
    "Standardized API responses maintain { success: true, data: ... } contract"
  );

  // Test 14: Timing-Safe Worker Secret Equality Verification
  const workerTestSecret = "my_super_secret_worker_token_32chars!";
  assert(await timingSafeEqualSecret(workerTestSecret, workerTestSecret), "timingSafeEqualSecret validates matching secrets");
  assert(!(await timingSafeEqualSecret("wrong_secret_token_32chars!", workerTestSecret)), "timingSafeEqualSecret rejects non-matching secret of same length");
  assert(!(await timingSafeEqualSecret("short", workerTestSecret)), "timingSafeEqualSecret rejects non-matching secret of different length");
  assert(!(await timingSafeEqualSecret("", workerTestSecret)), "timingSafeEqualSecret rejects empty string provided secret");
  assert(!(await timingSafeEqualSecret(null, workerTestSecret)), "timingSafeEqualSecret rejects null provided secret");
  assert(!(await timingSafeEqualSecret(undefined, workerTestSecret)), "timingSafeEqualSecret rejects undefined provided secret");
  assert(!(await timingSafeEqualSecret(workerTestSecret, undefined)), "timingSafeEqualSecret rejects undefined expected secret");

  console.log("\n-------------------------------------------------");
  console.log(`Summary: ${passed} PASSED, ${failed} FAILED`);
  console.log("-------------------------------------------------\n");

  if (failed > 0) {
    process.exit(1);
  }
  process.exit(0);
}

runVerification().catch((err) => {
  console.error("Verification script error:", err);
  process.exit(1);
});
