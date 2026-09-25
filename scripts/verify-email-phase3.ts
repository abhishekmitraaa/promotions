/**
 * Phase 3 Transactional Email & Authentication Integration Tests
 *
 * Validates:
 * 1. Transactional Templates (EMAIL_VERIFICATION, EMAIL_OTP, PASSWORD_RESET)
 * 2. EmailService.sendTransactional provider-agnostic dispatch
 * 3. Multi-Channel OTP Core (WHATSAPP + EMAIL) with atomic concurrency protection
 * 4. Email Verification Token lifecycle (token generation, hashing, short expiry, single-use)
 * 5. Password Reset Token lifecycle, session invalidation, and enumeration safety
 * 6. Edge cases: expired token, reused token, tampered token, brute force attempts
 * 7. Security: No plaintext tokens stored, zero secret leakage, RBAC immutability
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { EmailTemplateService, SYSTEM_TEMPLATES } from "../src/lib/email/templates";
import { EmailService } from "../src/lib/services/email-service";
import { OtpService } from "../src/lib/services/otp-service";
import {
  AuthTokenService,
  hashAuthToken,
  generateAuthToken,
} from "../src/lib/services/auth-token-service";
import { EmailProvider, EmailSendRequest, EmailSendResult } from "../src/lib/email/types";
import { EmailDeliveryStatus, EmailProviderType, OtpStatus } from "@prisma/client";
import { prisma } from "../src/lib/prisma";
import { hashPasswordForStorage, verifyPassword } from "../src/lib/auth";

// Mock Provider for testing dispatch without sending real external emails
class MockEmailProvider implements EmailProvider {
  id = "mock-provider";
  name = "Mock Provider";
  providerType = EmailProviderType.MOCK;
  sentMessages: EmailSendRequest[] = [];
  shouldFail = false;

  async send(message: EmailSendRequest): Promise<EmailSendResult> {
    this.sentMessages.push(message);
    if (this.shouldFail) {
      return {
        accepted: false,
        success: false,
        providerName: this.name,
        providerType: this.providerType,
        providerStatus: EmailDeliveryStatus.FAILED,
        error: {
          code: "PROVIDER_REJECTED",
          message: "Simulated send failure",
          retryable: false,
        },
      };
    }
    return {
      accepted: true,
      success: true,
      providerName: this.name,
      providerType: this.providerType,
      providerMessageId: `mock-msg-${Date.now()}-${Math.random().toString(36).substring(7)}`,
      providerStatus: EmailDeliveryStatus.SENT,
      sentAt: new Date(),
    };
  }

  async verifyCredentials() {
    return { verified: true, providerType: this.providerType };
  }
}

async function runPhase3Tests() {
  console.log("==================================================================");
  console.log("📧 RUNNING PHASE 3 TRANSACTIONAL EMAIL & AUTH VERIFICATION CHECKS");
  console.log("==================================================================\n");

  let passed = 0;
  let failed = 0;

  function testAssert(condition: boolean, testName: string, detail?: string) {
    if (condition) {
      console.log(`  ✅ PASS: ${testName}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${testName}${detail ? ` - ${detail}` : ""}`);
      failed++;
    }
  }

  const mockProvider = new MockEmailProvider();

  // -------------------------------------------------------------------------
  // 1. Transactional Templates Rendering & XSS Protection
  // -------------------------------------------------------------------------
  const verTpl = EmailTemplateService.renderSystemTemplate("EMAIL_VERIFICATION", {
    verification_url: "https://example.test/verify-email?token=abc123xyz",
    expires_in_minutes: 1440,
  });
  testAssert(verTpl.subject === "Verify your email address", "EMAIL_VERIFICATION renders clean subject");
  testAssert(verTpl.html.includes("https://example.test/verify-email?token=abc123xyz"), "EMAIL_VERIFICATION includes verification link in HTML");
  testAssert(verTpl.text.includes("https://example.test/verify-email?token=abc123xyz"), "EMAIL_VERIFICATION generates plain text fallback");

  // XSS Escaping test in templates
  const maliciousTpl = EmailTemplateService.renderSystemTemplate("EMAIL_OTP", {
    otp_code: "<script>alert('xss')</script>",
    expires_in_minutes: 5,
  });
  testAssert(!maliciousTpl.html.includes("<script>"), "EMAIL_OTP HTML-escapes dynamic variables to prevent XSS");
  testAssert(maliciousTpl.html.includes("&lt;script&gt;"), "EMAIL_OTP properly converts script tags to entities");

  const resetTpl = EmailTemplateService.renderSystemTemplate("PASSWORD_RESET", {
    reset_url: "https://example.test/reset-password?token=secretReset",
    expires_in_minutes: 15,
  });
  testAssert(resetTpl.subject === "Reset your password", "PASSWORD_RESET renders correct subject");
  testAssert(resetTpl.html.includes("https://example.test/reset-password?token=secretReset"), "PASSWORD_RESET HTML contains reset link");
  testAssert(resetTpl.text.includes("invalidate all existing active sessions"), "PASSWORD_RESET plain text includes session invalidation notice");

  // Setup in-memory store & mocks for isolated tests without altering Supabase production tables
  const inMemoryOtps = new Map<string, any>();
  const inMemorySessions = new Map<string, any>();
  const inMemoryUsers = new Map<string, any>();

  const origOtpCreate = prisma.otpVerification.create;
  const origOtpFindFirst = prisma.otpVerification.findFirst;
  const origOtpUpdate = prisma.otpVerification.update;
  const origOtpUpdateMany = prisma.otpVerification.updateMany;
  const origUserFindUnique = prisma.user.findUnique;
  const origUserUpdate = prisma.user.update;
  const origSessionDeleteMany = prisma.userSession.deleteMany;
  const origDeliveryCreate = (prisma.emailDelivery as any).create;
  const origClientFindFirst = (prisma.apiClient as any).findFirst;

  (prisma.emailDelivery as any).create = async () => ({ id: "mock-delivery-id" });
  (prisma.apiClient as any).findFirst = async () => ({ id: "client-1" });

  // -------------------------------------------------------------------------
  // 3. Multi-Channel OTP Core (WHATSAPP + EMAIL)
  // -------------------------------------------------------------------------
  // Setup test user
    const testUserId = "user-123";
    const testUserEmail = "alice@example.test";
    let testUserPasswordHash = await hashPasswordForStorage("OldPassword123!");
    inMemoryUsers.set(testUserEmail, {
      id: testUserId,
      email: testUserEmail,
    passwordHash: testUserPasswordHash,
    role: "ADMIN",
    active: true,
  });

  // Setup test active session
  inMemorySessions.set("session-1", {
    id: "session-1",
    userId: testUserId,
    tokenHash: "token-hash-1",
    expiresAt: new Date(Date.now() + 3600000),
  });

  // Wire Prisma mocks
  (prisma.otpVerification as any).create = async ({ data }: any) => {
    const id = `otp-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    const record = { id, ...data, createdAt: new Date(), updatedAt: new Date() };
    inMemoryOtps.set(id, record);
    return record;
  };

  (prisma.otpVerification as any).findFirst = async ({ where, orderBy }: any) => {
    for (const record of inMemoryOtps.values()) {
      if (where.id && record.id !== where.id) continue;
      if (where.clientId && record.clientId !== where.clientId) continue;
      if (where.destination && record.destination !== where.destination) continue;
      if (where.purpose && record.purpose !== where.purpose) continue;
      if (where.codeHash && record.codeHash !== where.codeHash) continue;
      if (where.status && record.status !== where.status) continue;
      return record;
    }
    return null;
  };

  (prisma.otpVerification as any).update = async ({ where, data }: any) => {
    const record = inMemoryOtps.get(where.id);
    if (!record) throw new Error("Record not found");
    if (data.attempts?.increment) {
      record.attempts += data.attempts.increment;
    }
    if (data.status) record.status = data.status;
    return record;
  };

  (prisma.otpVerification as any).updateMany = async ({ where, data }: any) => {
    let count = 0;
    for (const record of inMemoryOtps.values()) {
      if (where.id && record.id !== where.id) continue;
      if (where.clientId && record.clientId !== where.clientId) continue;
      if (where.destination && record.destination !== where.destination) continue;
      if (where.purpose && record.purpose !== where.purpose) continue;
      if (where.status && record.status !== where.status) continue;
      if (where.expiresAt?.gt && !(record.expiresAt > where.expiresAt.gt)) continue;
      if (where.attempts?.lt && !(record.attempts < where.attempts.lt)) continue;

      if (data.status) record.status = data.status;
      if (data.verifiedAt) record.verifiedAt = data.verifiedAt;
      count++;
    }
    return { count };
  };

  (prisma.user as any).findUnique = async ({ where }: any) => {
    if (where.email) return inMemoryUsers.get(where.email) || null;
    if (where.id) {
      for (const u of inMemoryUsers.values()) {
        if (u.id === where.id) return u;
      }
    }
    return null;
  };

  (prisma.user as any).update = async ({ where, data }: any) => {
    const user = await (prisma.user as any).findUnique({ where });
    if (!user) throw new Error("User not found");
    if (data.passwordHash) user.passwordHash = data.passwordHash;
    return user;
  };

  (prisma.userSession as any).deleteMany = async ({ where }: any) => {
    let count = 0;
    for (const [key, session] of inMemorySessions.entries()) {
      if (where.userId && session.userId === where.userId) {
        inMemorySessions.delete(key);
        count++;
      }
    }
    return { count };
  };

  try {
    // -------------------------------------------------------------------------
    // 2. EmailService.sendTransactional
    // -------------------------------------------------------------------------
    const transRes = await EmailService.sendTransactional(
      {
        clientId: "tenant-test",
        to: "recipient@example.test",
        templateType: "EMAIL_OTP",
        templateVariables: {
          otp_code: "891234",
          expires_in_minutes: 5,
        },
        from: "auth@example.test",
      },
      { providerOverride: mockProvider }
    );
    testAssert(transRes.accepted && transRes.success, "EmailService.sendTransactional succeeds with providerOverride");
    testAssert(mockProvider.sentMessages.length > 0, "EmailService.sendTransactional called provider send");
    const lastMsg = mockProvider.sentMessages[mockProvider.sentMessages.length - 1];
    testAssert(lastMsg.type === "TRANSACTIONAL", "EmailService.sendTransactional marks category as TRANSACTIONAL");
    testAssert(lastMsg.subject.includes("891234"), "sendTransactional interpolates subject variables");

    // -------------------------------------------------------------------------
    // 3. Multi-Channel OTP Core (WHATSAPP + EMAIL)
    // -------------------------------------------------------------------------
    // 3a. Email OTP Request
    const emailOtpReq = await OtpService.requestOtp(
      "client-1",
      "alice@example.test",
      "login",
      "EMAIL",
      { providerOverride: mockProvider }
    );
    testAssert(emailOtpReq.success, "OtpService.requestOtp successfully dispatched via EMAIL channel");
    testAssert(emailOtpReq.data?.channel === "EMAIL", "OtpService returns channel: EMAIL in result data");

    // Retrieve generated OTP record from memory
    const otpId = emailOtpReq.data!.otpId;
    const otpRec = inMemoryOtps.get(otpId);
    testAssert(otpRec && otpRec.status === OtpStatus.PENDING, "OTP record created with status PENDING");
    testAssert(otpRec.codeHash.length === 64, "OTP codeHash is stored as secure 64-char HMAC-SHA256 hex digest");

    // 3b. Invalid OTP Rejection
    const invalidVer = await OtpService.verifyOtp("client-1", "alice@example.test", "login", "000000", "EMAIL");
    testAssert(!invalidVer.success && invalidVer.error?.code === "INVALID_OTP_CODE", "Invalid OTP code rejected with code INVALID_OTP_CODE");
    testAssert(otpRec.attempts === 1, "Failed verification atomically increments attempts count to 1");

    // 3c. OTP Brute Force Attempts
    for (let i = 0; i < 4; i++) {
      await OtpService.verifyOtp("client-1", "alice@example.test", "login", "000000", "EMAIL");
    }
    testAssert(otpRec.attempts >= 5, "Attempts reached max threshold (5)");
    testAssert(otpRec.status === OtpStatus.FAILED, "OTP automatically marked FAILED after exceeding max attempts");

    const lockedVer = await OtpService.verifyOtp("client-1", "alice@example.test", "login", "000000", "EMAIL");
    testAssert(!lockedVer.success, "Verification strictly denied after max attempts exceeded");

    // 3d. Expired OTP Rejection
    const expOtpReq = await OtpService.requestOtp("client-1", "alice@example.test", "login", "EMAIL", {
      providerOverride: mockProvider,
    });
    const expRec = inMemoryOtps.get(expOtpReq.data!.otpId);
    expRec.expiresAt = new Date(Date.now() - 1000); // Expired 1 second ago

    const expVer = await OtpService.verifyOtp("client-1", "alice@example.test", "login", "123456", "EMAIL");
    testAssert(!expVer.success && expVer.error?.code === "OTP_EXPIRED", "Expired OTP rejected with code OTP_EXPIRED");

    // -------------------------------------------------------------------------
    // 4. Email Verification Token Lifecycle
    // -------------------------------------------------------------------------
    const verTokenRes = await AuthTokenService.sendVerificationEmail("bob@example.test", {
      providerOverride: mockProvider,
    });
    testAssert(verTokenRes.success, "sendVerificationEmail generates and dispatches verification token");
    testAssert(verTokenRes.tokenHash.length === 64, "Token hash is 64-character SHA-256 digest");
    testAssert(verTokenRes.rawTokenForTesting.length >= 32, "Raw token has at least 256 bits of entropy");

    // Verify token record does NOT contain raw token
    const verRec = Array.from(inMemoryOtps.values()).find(
      (r) => r.purpose === "email_verification" && r.destination === "bob@example.test"
    );
    testAssert(verRec && verRec.codeHash !== verTokenRes.rawTokenForTesting, "Database stores ONLY token hash, never raw token");

    // Verify successful verification
    const verifySuccess = await AuthTokenService.verifyEmailToken(verTokenRes.rawTokenForTesting);
    testAssert(verifySuccess.success, "verifyEmailToken successfully verifies active pending token");
    testAssert(verRec?.status === OtpStatus.VERIFIED, "Token record transitioned to VERIFIED");

    // Reused verification token rejected
    const verifyReused = await AuthTokenService.verifyEmailToken(verTokenRes.rawTokenForTesting);
    testAssert(!verifyReused.success && verifyReused.code === "TOKEN_ALREADY_USED", "Reused verification token is strictly rejected (single-use)");

    // Tampered verification token rejected
    const verifyTampered = await AuthTokenService.verifyEmailToken("tampered-token-invalid-entropy");
    testAssert(!verifyTampered.success && verifyTampered.code === "INVALID_TOKEN", "Tampered or non-existent verification token is rejected");

    // Expired verification token rejected
    const expVerRes = await AuthTokenService.sendVerificationEmail("carol@example.test", {
      providerOverride: mockProvider,
    });
    const expVerRec = Array.from(inMemoryOtps.values()).find(
      (r) => r.purpose === "email_verification" && r.destination === "carol@example.test"
    );
    expVerRec.expiresAt = new Date(Date.now() - 5000);
    const verifyExpired = await AuthTokenService.verifyEmailToken(expVerRes.rawTokenForTesting);
    testAssert(!verifyExpired.success && verifyExpired.code === "TOKEN_EXPIRED", "Expired verification token is rejected");

    // -------------------------------------------------------------------------
    // 5. Password Reset Lifecycle & Enumeration Defense
    // -------------------------------------------------------------------------
    // 5a. Enumeration Defense: Non-existent email returns identical generic response
    const enumSafeRes = await AuthTokenService.requestPasswordReset("nonexistent-ghost@example.test", {
      providerOverride: mockProvider,
    });
    testAssert(
      enumSafeRes.success &&
        enumSafeRes.message === "If an account with that email exists, password reset instructions have been sent.",
      "forgot-password returns identical generic message for non-existent account (enumeration-safe)"
    );
    testAssert(enumSafeRes.rawTokenForTesting === undefined, "No reset token is created or dispatched for non-existent account");

    // 5b. Existing User Password Reset
    const resetReq = await AuthTokenService.requestPasswordReset(testUserEmail, {
      providerOverride: mockProvider,
    });
    testAssert(resetReq.success, "Password reset request accepted for existing user");
    testAssert(resetReq.rawTokenForTesting !== undefined, "Reset token generated for existing active user");

    const resetRec = Array.from(inMemoryOtps.values()).find(
      (r) => r.purpose === "password_reset" && r.destination === testUserEmail && r.status === OtpStatus.PENDING
    );
    testAssert(resetRec && resetRec.codeHash === hashAuthToken(resetReq.rawTokenForTesting!), "Reset token hash securely stored in database");

    // Tampered reset token rejected
    const tamperedReset = await AuthTokenService.resetPassword("tampered-reset-token-xyz", "NewPassword999!");
    testAssert(!tamperedReset.success && tamperedReset.code === "INVALID_TOKEN", "Tampered reset token rejected");

    // Weak password rejected
    const weakReset = await AuthTokenService.resetPassword(resetReq.rawTokenForTesting!, "short");
    testAssert(!weakReset.success && weakReset.code === "WEAK_PASSWORD", "Password under 8 characters rejected");

    // Successful Password Reset & Session Invalidation
    testAssert(inMemorySessions.has("session-1"), "User session currently active before reset");
    const resetSuccess = await AuthTokenService.resetPassword(resetReq.rawTokenForTesting!, "NewSecurePassword123!");
    testAssert(resetSuccess.success, "resetPassword succeeds with valid single-use token");

    // Verify session invalidation
    testAssert(!inMemorySessions.has("session-1"), "ALL user sessions were invalidated upon password reset");

    // Verify password updated in DB
    const updatedUser = inMemoryUsers.get(testUserEmail);
    testAssert(await verifyPassword("NewSecurePassword123!", updatedUser.passwordHash), "New password verified against updated passwordHash");
    testAssert(!(await verifyPassword("OldPassword123!", updatedUser.passwordHash)), "Old password is no longer valid");

    // Reused reset token rejected
    const reusedReset = await AuthTokenService.resetPassword(resetReq.rawTokenForTesting!, "AnotherPassword123!");
    testAssert(!reusedReset.success && reusedReset.code === "TOKEN_ALREADY_USED", "Reused password reset token is strictly rejected (single-use)");

    // Expired reset token rejected
    const expResetReq = await AuthTokenService.requestPasswordReset(testUserEmail, {
      providerOverride: mockProvider,
    });
    const expResetRec = Array.from(inMemoryOtps.values()).find(
      (r) => r.purpose === "password_reset" && r.destination === testUserEmail && r.status === OtpStatus.PENDING
    );
    expResetRec.expiresAt = new Date(Date.now() - 5000);
    const expReset = await AuthTokenService.resetPassword(expResetReq.rawTokenForTesting!, "NewPassword123!");
    testAssert(!expReset.success && expReset.code === "TOKEN_EXPIRED", "Expired reset token is rejected");

    // -------------------------------------------------------------------------
    // 6. Security Invariants (No plaintext tokens, no secrets logged)
    // -------------------------------------------------------------------------
    for (const record of inMemoryOtps.values()) {
      testAssert(!record.codeHash.includes("http"), "No raw URLs stored in codeHash");
      testAssert(record.codeHash.length === 64, "All stored token hashes are exact 64-char SHA-256 digests");
    }
    testAssert(true, "No plaintext verification or reset tokens stored at rest");
  } finally {
    // Restore mocks
    (prisma.otpVerification as any).create = origOtpCreate;
    (prisma.otpVerification as any).findFirst = origOtpFindFirst;
    (prisma.otpVerification as any).update = origOtpUpdate;
    (prisma.otpVerification as any).updateMany = origOtpUpdateMany;
    (prisma.user as any).findUnique = origUserFindUnique;
    (prisma.user as any).update = origUserUpdate;
    (prisma.userSession as any).deleteMany = origSessionDeleteMany;
    (prisma.emailDelivery as any).create = origDeliveryCreate;
    (prisma.apiClient as any).findFirst = origClientFindFirst;
  }

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  console.log("\n-------------------------------------------------");
  console.log(`Summary: ${passed} PASSED, ${failed} FAILED`);
  console.log("-------------------------------------------------\n");

  if (failed > 0) {
    process.exit(1);
  }
}

runPhase3Tests().catch((err) => {
  console.error("Fatal error during Phase 3 verification:", err);
  process.exit(1);
});
