-- ==============================================================================
-- Migration: 20260929010000_add_campaign_automation
-- Adds Campaign Automation, Journeys, Recurring Schedules, and Recipient State Tracking
-- ==============================================================================

-- 1. Create Enums
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'EmailAutomationStatus') THEN
    CREATE TYPE "EmailAutomationStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'ARCHIVED');
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'EmailAutomationTriggerType') THEN
    CREATE TYPE "EmailAutomationTriggerType" AS ENUM ('RECURRING_SCHEDULE', 'EVENT_TRIGGERED', 'SEGMENT_ENTRY', 'MANUAL');
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AudienceReEvaluationPolicy') THEN
    CREATE TYPE "AudienceReEvaluationPolicy" AS ENUM ('ALWAYS_RE_EVALUATE', 'SNAPSHOT_ONCE', 'STRICT_CONSENT_ONLY');
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'EmailEnrollmentStatus') THEN
    CREATE TYPE "EmailEnrollmentStatus" AS ENUM ('ACTIVE', 'WAITING', 'COMPLETED', 'PAUSED', 'ABANDONED', 'FAILED');
  END IF;
END $$;

-- 2. Create EmailAutomation Table
CREATE TABLE IF NOT EXISTS "EmailAutomation" (
  "id" TEXT NOT NULL,
  "clientId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "status" "EmailAutomationStatus" NOT NULL DEFAULT 'DRAFT',
  "triggerType" "EmailAutomationTriggerType" NOT NULL DEFAULT 'MANUAL',
  "triggerConfig" TEXT,
  "reEvaluationPolicy" "AudienceReEvaluationPolicy" NOT NULL DEFAULT 'ALWAYS_RE_EVALUATE',
  "steps" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastExecutedAt" TIMESTAMP(3),
  "nextRunAt" TIMESTAMP(3),
  "executionCount" INTEGER NOT NULL DEFAULT 0,
  "activeEnrollmentsCount" INTEGER NOT NULL DEFAULT 0,
  "completedEnrollmentsCount" INTEGER NOT NULL DEFAULT 0,
  "abandonedEnrollmentsCount" INTEGER NOT NULL DEFAULT 0,

  CONSTRAINT "EmailAutomation_pkey" PRIMARY KEY ("id")
);

-- Indexes for EmailAutomation
CREATE UNIQUE INDEX IF NOT EXISTS "EmailAutomation_clientId_name_key" ON "EmailAutomation"("clientId", "name");
CREATE INDEX IF NOT EXISTS "EmailAutomation_clientId_idx" ON "EmailAutomation"("clientId");
CREATE INDEX IF NOT EXISTS "EmailAutomation_status_idx" ON "EmailAutomation"("status");
CREATE INDEX IF NOT EXISTS "EmailAutomation_nextRunAt_idx" ON "EmailAutomation"("nextRunAt");

-- Foreign Keys for EmailAutomation
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'EmailAutomation_clientId_fkey'
  ) THEN
    ALTER TABLE "EmailAutomation" ADD CONSTRAINT "EmailAutomation_clientId_fkey"
      FOREIGN KEY ("clientId") REFERENCES "ApiClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- 3. Create EmailAutomationEnrollment Table
CREATE TABLE IF NOT EXISTS "EmailAutomationEnrollment" (
  "id" TEXT NOT NULL,
  "automationId" TEXT NOT NULL,
  "contactId" TEXT NOT NULL,
  "clientId" TEXT NOT NULL,
  "currentStepId" TEXT,
  "status" "EmailEnrollmentStatus" NOT NULL DEFAULT 'ACTIVE',
  "abandonedReason" TEXT,
  "contextData" TEXT,
  "nextActionAt" TIMESTAMP(3),
  "enrolledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "abandonedAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "EmailAutomationEnrollment_pkey" PRIMARY KEY ("id")
);

-- Indexes for EmailAutomationEnrollment
CREATE UNIQUE INDEX IF NOT EXISTS "EmailAutomationEnrollment_automationId_contactId_key" ON "EmailAutomationEnrollment"("automationId", "contactId");
CREATE INDEX IF NOT EXISTS "EmailAutomationEnrollment_automationId_idx" ON "EmailAutomationEnrollment"("automationId");
CREATE INDEX IF NOT EXISTS "EmailAutomationEnrollment_contactId_idx" ON "EmailAutomationEnrollment"("contactId");
CREATE INDEX IF NOT EXISTS "EmailAutomationEnrollment_clientId_idx" ON "EmailAutomationEnrollment"("clientId");
CREATE INDEX IF NOT EXISTS "EmailAutomationEnrollment_status_idx" ON "EmailAutomationEnrollment"("status");
CREATE INDEX IF NOT EXISTS "EmailAutomationEnrollment_nextActionAt_idx" ON "EmailAutomationEnrollment"("nextActionAt");

-- Foreign Keys for EmailAutomationEnrollment
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'EmailAutomationEnrollment_automationId_fkey'
  ) THEN
    ALTER TABLE "EmailAutomationEnrollment" ADD CONSTRAINT "EmailAutomationEnrollment_automationId_fkey"
      FOREIGN KEY ("automationId") REFERENCES "EmailAutomation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'EmailAutomationEnrollment_contactId_fkey'
  ) THEN
    ALTER TABLE "EmailAutomationEnrollment" ADD CONSTRAINT "EmailAutomationEnrollment_contactId_fkey"
      FOREIGN KEY ("contactId") REFERENCES "EmailContact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'EmailAutomationEnrollment_clientId_fkey'
  ) THEN
    ALTER TABLE "EmailAutomationEnrollment" ADD CONSTRAINT "EmailAutomationEnrollment_clientId_fkey"
      FOREIGN KEY ("clientId") REFERENCES "ApiClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- 4. Alter EmailCampaign Table for Automation Linkage
ALTER TABLE "EmailCampaign" ADD COLUMN IF NOT EXISTS "automationId" TEXT;
ALTER TABLE "EmailCampaign" ADD COLUMN IF NOT EXISTS "automationStepId" TEXT;
ALTER TABLE "EmailCampaign" ADD COLUMN IF NOT EXISTS "recurrenceIndex" INTEGER;

CREATE INDEX IF NOT EXISTS "EmailCampaign_automationId_idx" ON "EmailCampaign"("automationId");

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'EmailCampaign_automationId_fkey'
  ) THEN
    ALTER TABLE "EmailCampaign" ADD CONSTRAINT "EmailCampaign_automationId_fkey"
      FOREIGN KEY ("automationId") REFERENCES "EmailAutomation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- 5. Row-Level Security Policies
ALTER TABLE "EmailAutomation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "EmailAutomationEnrollment" ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'whatsapp_hub') THEN
    GRANT ALL ON TABLE "EmailAutomation" TO whatsapp_hub;
    GRANT ALL ON TABLE "EmailAutomationEnrollment" TO whatsapp_hub;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE "EmailAutomation" FROM anon, authenticated;
    REVOKE ALL ON TABLE "EmailAutomationEnrollment" FROM anon, authenticated;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE policyname = 'whatsapp_hub_emailautomation_all'
  ) THEN
    CREATE POLICY "whatsapp_hub_emailautomation_all" ON "EmailAutomation" FOR ALL TO whatsapp_hub USING (true) WITH CHECK (true);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE policyname = 'whatsapp_hub_emailenrollment_all'
  ) THEN
    CREATE POLICY "whatsapp_hub_emailenrollment_all" ON "EmailAutomationEnrollment" FOR ALL TO whatsapp_hub USING (true) WITH CHECK (true);
  END IF;
END $$;
