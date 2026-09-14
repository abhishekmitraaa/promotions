import { normalizePhoneNumber, generateApiKey, hashApiKey, generateSecureOtp, hashOtp, verifyHmacSha256, signHmacSha256 } from "../src/lib/crypto";
import { checkRateLimit } from "../src/lib/rate-limit";
import { createMessageSchema } from "../src/lib/validation/messages";
import { requestOtpSchema, verifyOtpSchema } from "../src/lib/validation/otp";
import { isMetaConfigured } from "../src/lib/env";

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
  const res1 = checkRateLimit(rateKey, 2, 60000);
  const res2 = checkRateLimit(rateKey, 2, 60000);
  const res3 = checkRateLimit(rateKey, 2, 60000);
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

  console.log("\n-------------------------------------------------");
  console.log(`Summary: ${passed} PASSED, ${failed} FAILED`);
  console.log("-------------------------------------------------\n");

  if (failed > 0) {
    process.exit(1);
  }
  process.exit(0);
}

runVerification().catch((err) => {
  console.error("Verification error:", err);
  process.exit(1);
});
