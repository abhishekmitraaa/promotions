-- Migration: 20260925120000_add_email_auth
-- Additive migration for transactional email authentication, email verification, and password reset.

-- 1. Add email verification fields to User
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "emailVerified" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "emailVerifiedAt" TIMESTAMP(3);

-- 2. Add performance index on codeHash for token lookup in OtpVerification
CREATE INDEX IF NOT EXISTS "OtpVerification_codeHash_idx" ON "OtpVerification"("codeHash");
