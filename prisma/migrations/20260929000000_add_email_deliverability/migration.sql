-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "EmailDomainVerificationStatus" AS ENUM ('PENDING', 'VERIFIED', 'FAILED', 'REVOKED');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "EmailDnsStatus" AS ENUM ('PENDING', 'VERIFIED', 'MISCONFIGURED', 'FAILED', 'MISSING');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "EmailFailureCategory" AS ENUM (
    'AUTHENTICATION_FAILED',
    'SPAM_BLOCK',
    'INVALID_RECIPIENT',
    'MAILBOX_FULL',
    'DNS_LOOKUP_FAILURE',
    'RATE_LIMITED',
    'TLS_ERROR',
    'QUOTA_EXCEEDED',
    'UNKNOWN'
  );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "EmailDomain" (
  "id" TEXT NOT NULL,
  "clientId" TEXT NOT NULL,
  "domain" TEXT NOT NULL,
  "verificationStatus" "EmailDomainVerificationStatus" NOT NULL DEFAULT 'PENDING',
  "verificationToken" TEXT NOT NULL,
  "spfStatus" "EmailDnsStatus" NOT NULL DEFAULT 'PENDING',
  "spfRecord" TEXT,
  "spfExpected" TEXT,
  "dkimStatus" "EmailDnsStatus" NOT NULL DEFAULT 'PENDING',
  "dkimSelector" TEXT NOT NULL DEFAULT 'whub',
  "dkimRecord" TEXT,
  "dkimPublicKey" TEXT,
  "dmarcStatus" "EmailDnsStatus" NOT NULL DEFAULT 'PENDING',
  "dmarcRecord" TEXT,
  "dmarcPolicy" TEXT,
  "mxStatus" "EmailDnsStatus" NOT NULL DEFAULT 'PENDING',
  "reputationScore" INTEGER NOT NULL DEFAULT 100,
  "bounceRate" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
  "complaintRate" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
  "checkErrors" TEXT,
  "lastCheckedAt" TIMESTAMP(3),
  "verifiedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "EmailDomain_pkey" PRIMARY KEY ("id")
);

-- AlterTable EmailSenderIdentity
ALTER TABLE "EmailSenderIdentity" 
  ADD COLUMN IF NOT EXISTS "domainId" TEXT,
  ADD COLUMN IF NOT EXISTS "reputationScore" INTEGER NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS "bounceRate" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
  ADD COLUMN IF NOT EXISTS "complaintRate" DOUBLE PRECISION NOT NULL DEFAULT 0.0;

-- AlterTable EmailDelivery
ALTER TABLE "EmailDelivery" 
  ADD COLUMN IF NOT EXISTS "failureCategory" "EmailFailureCategory",
  ADD COLUMN IF NOT EXISTS "diagnosticDetails" TEXT,
  ADD COLUMN IF NOT EXISTS "smtpCode" TEXT;

-- CreateIndexes
CREATE UNIQUE INDEX IF NOT EXISTS "EmailDomain_clientId_domain_key" ON "EmailDomain"("clientId", "domain");
CREATE INDEX IF NOT EXISTS "EmailDomain_clientId_idx" ON "EmailDomain"("clientId");
CREATE INDEX IF NOT EXISTS "EmailDomain_domain_idx" ON "EmailDomain"("domain");
CREATE INDEX IF NOT EXISTS "EmailDomain_verificationStatus_idx" ON "EmailDomain"("verificationStatus");

CREATE INDEX IF NOT EXISTS "EmailSenderIdentity_domainId_idx" ON "EmailSenderIdentity"("domainId");
CREATE INDEX IF NOT EXISTS "EmailDelivery_clientId_failureCategory_idx" ON "EmailDelivery"("clientId", "failureCategory");

-- AddForeignKeys
DO $$ BEGIN
  ALTER TABLE "EmailDomain" 
    ADD CONSTRAINT "EmailDomain_clientId_fkey" 
    FOREIGN KEY ("clientId") REFERENCES "ApiClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "EmailSenderIdentity" 
    ADD CONSTRAINT "EmailSenderIdentity_domainId_fkey" 
    FOREIGN KEY ("domainId") REFERENCES "EmailDomain"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Enable Row Level Security
ALTER TABLE "EmailDomain" ENABLE ROW LEVEL SECURITY;
