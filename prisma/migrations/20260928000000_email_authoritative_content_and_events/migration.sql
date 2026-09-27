-- Migration: 20260928000000_email_authoritative_content_and_events
-- Authoritative email content storage, EmailEvent schema alignment, and auth synchronization

-- 1. Create EmailEventProcessingStatus Enum
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'EmailEventProcessingStatus') THEN
    CREATE TYPE "EmailEventProcessingStatus" AS ENUM ('RECEIVED', 'PROCESSING', 'PROCESSED', 'FAILED');
  END IF;
END $$;

-- 2. Synchronize User model auth columns
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "emailVerified" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "emailVerifiedAt" TIMESTAMP(3);

-- 3. Add Authoritative Content and Association Columns to EmailDelivery
ALTER TABLE "EmailDelivery" ADD COLUMN IF NOT EXISTS "campaignId" TEXT;
ALTER TABLE "EmailDelivery" ADD COLUMN IF NOT EXISTS "templateId" TEXT;
ALTER TABLE "EmailDelivery" ADD COLUMN IF NOT EXISTS "templateVersionId" TEXT;
ALTER TABLE "EmailDelivery" ADD COLUMN IF NOT EXISTS "replyTo" TEXT;
ALTER TABLE "EmailDelivery" ADD COLUMN IF NOT EXISTS "htmlContent" TEXT;
ALTER TABLE "EmailDelivery" ADD COLUMN IF NOT EXISTS "textContent" TEXT;

-- Foreign keys for EmailDelivery associations
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'EmailDelivery_campaignId_fkey'
  ) THEN
    ALTER TABLE "EmailDelivery" ADD CONSTRAINT "EmailDelivery_campaignId_fkey"
    FOREIGN KEY ("campaignId") REFERENCES "EmailCampaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'EmailDelivery_templateId_fkey'
  ) THEN
    ALTER TABLE "EmailDelivery" ADD CONSTRAINT "EmailDelivery_templateId_fkey"
    FOREIGN KEY ("templateId") REFERENCES "EmailTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'EmailDelivery_templateVersionId_fkey'
  ) THEN
    ALTER TABLE "EmailDelivery" ADD CONSTRAINT "EmailDelivery_templateVersionId_fkey"
    FOREIGN KEY ("templateVersionId") REFERENCES "EmailTemplateVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "EmailDelivery_campaignId_idx" ON "EmailDelivery"("campaignId");

-- 4. Synchronize EmailEvent Columns and Constraints
ALTER TABLE "EmailEvent" ADD COLUMN IF NOT EXISTS "providerConfigId" TEXT;
ALTER TABLE "EmailEvent" ADD COLUMN IF NOT EXISTS "status" "EmailEventProcessingStatus" NOT NULL DEFAULT 'RECEIVED';
ALTER TABLE "EmailEvent" ADD COLUMN IF NOT EXISTS "attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "EmailEvent" ADD COLUMN IF NOT EXISTS "lastAttemptAt" TIMESTAMP(3);
ALTER TABLE "EmailEvent" ADD COLUMN IF NOT EXISTS "processedAt" TIMESTAMP(3);
ALTER TABLE "EmailEvent" ADD COLUMN IF NOT EXISTS "errorMessage" TEXT;
ALTER TABLE "EmailEvent" ADD COLUMN IF NOT EXISTS "errorCode" TEXT;

-- Drop legacy single-column providerEventId unique constraint if present
DROP INDEX IF EXISTS "EmailEvent_providerEventId_key";

-- Compound unique constraint for providerConfigId + providerEventId
CREATE UNIQUE INDEX IF NOT EXISTS "EmailEvent_providerConfigId_providerEventId_key"
ON "EmailEvent"("providerConfigId", "providerEventId");

-- Index for status and providerConfigId queries
CREATE INDEX IF NOT EXISTS "EmailEvent_providerConfigId_idx" ON "EmailEvent"("providerConfigId");
CREATE INDEX IF NOT EXISTS "EmailEvent_status_idx" ON "EmailEvent"("status");

-- Foreign key for EmailEvent providerConfig
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'EmailEvent_providerConfigId_fkey'
  ) THEN
    ALTER TABLE "EmailEvent" ADD CONSTRAINT "EmailEvent_providerConfigId_fkey"
    FOREIGN KEY ("providerConfigId") REFERENCES "EmailProviderConfig"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
