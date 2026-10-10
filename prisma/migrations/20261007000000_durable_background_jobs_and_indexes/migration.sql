-- CreateEnum
CREATE TYPE "BackgroundJobStatus" AS ENUM ('QUEUED', 'PROCESSING', 'RETRYING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- AlterTable EmailCampaign: Add missing covering indexes reported by Supabase Performance Advisor
CREATE INDEX IF NOT EXISTS "EmailCampaign_listId_idx" ON "EmailCampaign"("listId");
CREATE INDEX IF NOT EXISTS "EmailCampaign_segmentId_idx" ON "EmailCampaign"("segmentId");

-- AlterTable EmailCampaignRecipient: Add concurrency locks, attempts, and error tracking
ALTER TABLE "EmailCampaignRecipient" 
  ADD COLUMN IF NOT EXISTS "attemptCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "lastAttemptAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "nextAttemptAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "lockedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "lockedBy" TEXT,
  ADD COLUMN IF NOT EXISTS "errorCode" TEXT,
  ADD COLUMN IF NOT EXISTS "errorMessage" TEXT;

CREATE INDEX IF NOT EXISTS "EmailCampaignRecipient_status_nextAttemptAt_idx" ON "EmailCampaignRecipient"("status", "nextAttemptAt");
CREATE INDEX IF NOT EXISTS "EmailCampaignRecipient_lockedAt_idx" ON "EmailCampaignRecipient"("lockedAt");

-- AlterTable EmailDelivery: Add concurrency lock and missing covering index
ALTER TABLE "EmailDelivery" 
  ADD COLUMN IF NOT EXISTS "lockedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "lockedBy" TEXT;

CREATE INDEX IF NOT EXISTS "EmailDelivery_templateVersionId_idx" ON "EmailDelivery"("templateVersionId");
CREATE INDEX IF NOT EXISTS "EmailDelivery_status_nextAttemptAt_idx" ON "EmailDelivery"("status", "nextAttemptAt");
CREATE INDEX IF NOT EXISTS "EmailDelivery_lockedAt_idx" ON "EmailDelivery"("lockedAt");

-- AlterTable EmailAutomationEnrollment: Add concurrency locking
ALTER TABLE "EmailAutomationEnrollment" 
  ADD COLUMN IF NOT EXISTS "attemptCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "lockedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "lockedBy" TEXT;

CREATE INDEX IF NOT EXISTS "EmailAutomationEnrollment_lockedAt_idx" ON "EmailAutomationEnrollment"("lockedAt");

-- CreateTable BackgroundJob: Authoritative background job persistence
CREATE TABLE IF NOT EXISTS "BackgroundJob" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" "BackgroundJobStatus" NOT NULL DEFAULT 'QUEUED',
    "payload" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "scheduledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "lastAttemptAt" TIMESTAMP(3),
    "nextAttemptAt" TIMESTAMP(3),
    "lockedAt" TIMESTAMP(3),
    "lockedBy" TEXT,
    "completedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "lastErrorMessage" TEXT,
    "deduplicationKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BackgroundJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "BackgroundJob_clientId_deduplicationKey_key" ON "BackgroundJob"("clientId", "deduplicationKey");
CREATE INDEX IF NOT EXISTS "BackgroundJob_clientId_status_idx" ON "BackgroundJob"("clientId", "status");
CREATE INDEX IF NOT EXISTS "BackgroundJob_status_availableAt_idx" ON "BackgroundJob"("status", "availableAt");
CREATE INDEX IF NOT EXISTS "BackgroundJob_status_nextAttemptAt_idx" ON "BackgroundJob"("status", "nextAttemptAt");
CREATE INDEX IF NOT EXISTS "BackgroundJob_type_status_idx" ON "BackgroundJob"("type", "status");
CREATE INDEX IF NOT EXISTS "BackgroundJob_lockedAt_idx" ON "BackgroundJob"("lockedAt");
CREATE INDEX IF NOT EXISTS "BackgroundJob_scheduledAt_idx" ON "BackgroundJob"("scheduledAt");

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'BackgroundJob_clientId_fkey'
  ) THEN
    ALTER TABLE "BackgroundJob" ADD CONSTRAINT "BackgroundJob_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "ApiClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
