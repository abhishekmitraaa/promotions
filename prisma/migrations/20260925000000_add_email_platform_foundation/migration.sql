-- CreateEnum
CREATE TYPE "EmailProviderType" AS ENUM ('GMAIL', 'SES', 'SMTP', 'MOCK');

-- CreateEnum
CREATE TYPE "EmailProviderStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'FAILED');

-- CreateEnum
CREATE TYPE "EmailType" AS ENUM ('TRANSACTIONAL', 'PROMOTIONAL');

-- CreateEnum
CREATE TYPE "EmailContactStatus" AS ENUM ('SUBSCRIBED', 'UNSUBSCRIBED', 'BOUNCED', 'COMPLAINED', 'SUPPRESSED', 'PENDING');

-- CreateEnum
CREATE TYPE "EmailSubscriptionStatus" AS ENUM ('SUBSCRIBED', 'UNSUBSCRIBED', 'PENDING');

-- CreateEnum
CREATE TYPE "EmailTemplateType" AS ENUM ('TRANSACTIONAL', 'PROMOTIONAL');

-- CreateEnum
CREATE TYPE "EmailCampaignStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'RUNNING', 'PAUSED', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "EmailDeliveryStatus" AS ENUM ('QUEUED', 'PROCESSING', 'SENT', 'DELIVERED', 'BOUNCED', 'COMPLAINED', 'FAILED');

-- CreateEnum
CREATE TYPE "EmailEventType" AS ENUM ('SENT', 'DELIVERED', 'OPENED', 'CLICKED', 'BOUNCED', 'COMPLAINT', 'UNSUBSCRIBED', 'FAILED');

-- CreateEnum
CREATE TYPE "EmailSuppressionReason" AS ENUM ('HARD_BOUNCE', 'COMPLAINT', 'UNSUBSCRIBED', 'MANUAL', 'INVALID');

-- CreateTable
CREATE TABLE "EmailProviderConfig" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "providerType" "EmailProviderType" NOT NULL,
    "status" "EmailProviderStatus" NOT NULL DEFAULT 'ACTIVE',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "encryptedCredentials" TEXT,
    "encryptedOAuthRefreshToken" TEXT,
    "senderEmail" TEXT,
    "senderName" TEXT,
    "configMetadata" TEXT,
    "lastVerifiedAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailProviderConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailSenderIdentity" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "providerConfigId" TEXT,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "replyToEmail" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailSenderIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailContact" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "normalizedEmail" TEXT NOT NULL,
    "firstName" TEXT,
    "lastName" TEXT,
    "metadata" TEXT,
    "status" "EmailContactStatus" NOT NULL DEFAULT 'PENDING',
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "hasMarketingConsent" BOOLEAN NOT NULL DEFAULT false,
    "consentTimestamp" TIMESTAMP(3),
    "consentSource" TEXT,
    "unsubscribedAt" TIMESTAMP(3),
    "unsubscribeReason" TEXT,
    "lastEmailedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailContact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailList" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailList_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailListMember" (
    "id" TEXT NOT NULL,
    "listId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "status" "EmailSubscriptionStatus" NOT NULL DEFAULT 'SUBSCRIBED',
    "subscribedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unsubscribedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailListMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailSegment" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "criteria" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailSegment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailTemplate" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "type" "EmailTemplateType" NOT NULL,
    "activeVersionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailTemplateVersion" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "subject" TEXT NOT NULL,
    "htmlContent" TEXT NOT NULL,
    "textContent" TEXT,
    "variableSchema" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailTemplateVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailCampaign" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "EmailCampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "type" "EmailType" NOT NULL DEFAULT 'PROMOTIONAL',
    "templateVersionId" TEXT,
    "segmentId" TEXT,
    "listId" TEXT,
    "senderIdentityId" TEXT,
    "scheduledAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "totalRecipients" INTEGER NOT NULL DEFAULT 0,
    "sentCount" INTEGER NOT NULL DEFAULT 0,
    "deliveredCount" INTEGER NOT NULL DEFAULT 0,
    "bouncedCount" INTEGER NOT NULL DEFAULT 0,
    "complaintCount" INTEGER NOT NULL DEFAULT 0,
    "unsubscribedCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailCampaignRecipient" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "contactId" TEXT,
    "email" TEXT NOT NULL,
    "metadataSnapshot" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailCampaignRecipient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailDelivery" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "providerType" "EmailProviderType" NOT NULL,
    "providerMessageId" TEXT,
    "campaignRecipientId" TEXT,
    "transactionalReference" TEXT,
    "category" "EmailType" NOT NULL,
    "from" TEXT NOT NULL,
    "to" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "status" "EmailDeliveryStatus" NOT NULL DEFAULT 'QUEUED',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMP(3),
    "nextAttemptAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailEvent" (
    "id" TEXT NOT NULL,
    "clientId" TEXT,
    "deliveryId" TEXT,
    "providerEventId" TEXT,
    "eventType" "EmailEventType" NOT NULL,
    "recipient" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailSuppression" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "normalizedEmail" TEXT NOT NULL,
    "reason" "EmailSuppressionReason" NOT NULL,
    "source" TEXT,
    "metadata" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailSuppression_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EmailProviderConfig_clientId_idx" ON "EmailProviderConfig"("clientId");

-- CreateIndex
CREATE INDEX "EmailProviderConfig_providerType_idx" ON "EmailProviderConfig"("providerType");

-- CreateIndex
CREATE INDEX "EmailProviderConfig_status_idx" ON "EmailProviderConfig"("status");

-- CreateIndex
CREATE INDEX "EmailSenderIdentity_clientId_idx" ON "EmailSenderIdentity"("clientId");

-- CreateIndex
CREATE INDEX "EmailSenderIdentity_providerConfigId_idx" ON "EmailSenderIdentity"("providerConfigId");

-- CreateIndex
CREATE UNIQUE INDEX "EmailSenderIdentity_clientId_email_key" ON "EmailSenderIdentity"("clientId", "email");

-- CreateIndex
CREATE INDEX "EmailContact_clientId_idx" ON "EmailContact"("clientId");

-- CreateIndex
CREATE INDEX "EmailContact_normalizedEmail_idx" ON "EmailContact"("normalizedEmail");

-- CreateIndex
CREATE INDEX "EmailContact_status_idx" ON "EmailContact"("status");

-- CreateIndex
CREATE UNIQUE INDEX "EmailContact_clientId_normalizedEmail_key" ON "EmailContact"("clientId", "normalizedEmail");

-- CreateIndex
CREATE INDEX "EmailList_clientId_idx" ON "EmailList"("clientId");

-- CreateIndex
CREATE INDEX "EmailList_active_idx" ON "EmailList"("active");

-- CreateIndex
CREATE UNIQUE INDEX "EmailList_clientId_name_key" ON "EmailList"("clientId", "name");

-- CreateIndex
CREATE INDEX "EmailListMember_listId_idx" ON "EmailListMember"("listId");

-- CreateIndex
CREATE INDEX "EmailListMember_contactId_idx" ON "EmailListMember"("contactId");

-- CreateIndex
CREATE INDEX "EmailListMember_status_idx" ON "EmailListMember"("status");

-- CreateIndex
CREATE UNIQUE INDEX "EmailListMember_listId_contactId_key" ON "EmailListMember"("listId", "contactId");

-- CreateIndex
CREATE INDEX "EmailSegment_clientId_idx" ON "EmailSegment"("clientId");

-- CreateIndex
CREATE INDEX "EmailSegment_active_idx" ON "EmailSegment"("active");

-- CreateIndex
CREATE UNIQUE INDEX "EmailSegment_clientId_name_key" ON "EmailSegment"("clientId", "name");

-- CreateIndex
CREATE INDEX "EmailTemplate_clientId_idx" ON "EmailTemplate"("clientId");

-- CreateIndex
CREATE INDEX "EmailTemplate_type_idx" ON "EmailTemplate"("type");

-- CreateIndex
CREATE UNIQUE INDEX "EmailTemplate_clientId_name_key" ON "EmailTemplate"("clientId", "name");

-- CreateIndex
CREATE INDEX "EmailTemplateVersion_templateId_idx" ON "EmailTemplateVersion"("templateId");

-- CreateIndex
CREATE UNIQUE INDEX "EmailTemplateVersion_templateId_version_key" ON "EmailTemplateVersion"("templateId", "version");

-- CreateIndex
CREATE INDEX "EmailCampaign_clientId_idx" ON "EmailCampaign"("clientId");

-- CreateIndex
CREATE INDEX "EmailCampaign_status_idx" ON "EmailCampaign"("status");

-- CreateIndex
CREATE INDEX "EmailCampaign_scheduledAt_idx" ON "EmailCampaign"("scheduledAt");

-- CreateIndex
CREATE INDEX "EmailCampaign_templateVersionId_idx" ON "EmailCampaign"("templateVersionId");

-- CreateIndex
CREATE INDEX "EmailCampaign_senderIdentityId_idx" ON "EmailCampaign"("senderIdentityId");

-- CreateIndex
CREATE INDEX "EmailCampaignRecipient_campaignId_idx" ON "EmailCampaignRecipient"("campaignId");

-- CreateIndex
CREATE INDEX "EmailCampaignRecipient_contactId_idx" ON "EmailCampaignRecipient"("contactId");

-- CreateIndex
CREATE INDEX "EmailCampaignRecipient_status_idx" ON "EmailCampaignRecipient"("status");

-- CreateIndex
CREATE UNIQUE INDEX "EmailCampaignRecipient_campaignId_email_key" ON "EmailCampaignRecipient"("campaignId", "email");

-- CreateIndex
CREATE INDEX "EmailDelivery_clientId_idx" ON "EmailDelivery"("clientId");

-- CreateIndex
CREATE INDEX "EmailDelivery_status_idx" ON "EmailDelivery"("status");

-- CreateIndex
CREATE INDEX "EmailDelivery_to_idx" ON "EmailDelivery"("to");

-- CreateIndex
CREATE INDEX "EmailDelivery_providerMessageId_idx" ON "EmailDelivery"("providerMessageId");

-- CreateIndex
CREATE INDEX "EmailDelivery_category_idx" ON "EmailDelivery"("category");

-- CreateIndex
CREATE INDEX "EmailDelivery_createdAt_idx" ON "EmailDelivery"("createdAt");

-- CreateIndex
CREATE INDEX "EmailDelivery_campaignRecipientId_idx" ON "EmailDelivery"("campaignRecipientId");

-- CreateIndex
CREATE UNIQUE INDEX "EmailDelivery_clientId_idempotencyKey_key" ON "EmailDelivery"("clientId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "EmailEvent_providerEventId_key" ON "EmailEvent"("providerEventId");

-- CreateIndex
CREATE INDEX "EmailEvent_clientId_idx" ON "EmailEvent"("clientId");

-- CreateIndex
CREATE INDEX "EmailEvent_deliveryId_idx" ON "EmailEvent"("deliveryId");

-- CreateIndex
CREATE INDEX "EmailEvent_eventType_idx" ON "EmailEvent"("eventType");

-- CreateIndex
CREATE INDEX "EmailEvent_providerEventId_idx" ON "EmailEvent"("providerEventId");

-- CreateIndex
CREATE INDEX "EmailEvent_occurredAt_idx" ON "EmailEvent"("occurredAt");

-- CreateIndex
CREATE INDEX "EmailSuppression_clientId_idx" ON "EmailSuppression"("clientId");

-- CreateIndex
CREATE INDEX "EmailSuppression_normalizedEmail_idx" ON "EmailSuppression"("normalizedEmail");

-- CreateIndex
CREATE INDEX "EmailSuppression_reason_idx" ON "EmailSuppression"("reason");

-- CreateIndex
CREATE UNIQUE INDEX "EmailSuppression_clientId_normalizedEmail_key" ON "EmailSuppression"("clientId", "normalizedEmail");

-- AddForeignKey
ALTER TABLE "EmailProviderConfig" ADD CONSTRAINT "EmailProviderConfig_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "ApiClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailSenderIdentity" ADD CONSTRAINT "EmailSenderIdentity_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "ApiClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailSenderIdentity" ADD CONSTRAINT "EmailSenderIdentity_providerConfigId_fkey" FOREIGN KEY ("providerConfigId") REFERENCES "EmailProviderConfig"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailContact" ADD CONSTRAINT "EmailContact_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "ApiClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailList" ADD CONSTRAINT "EmailList_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "ApiClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailListMember" ADD CONSTRAINT "EmailListMember_listId_fkey" FOREIGN KEY ("listId") REFERENCES "EmailList"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailListMember" ADD CONSTRAINT "EmailListMember_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "EmailContact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailSegment" ADD CONSTRAINT "EmailSegment_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "ApiClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailTemplate" ADD CONSTRAINT "EmailTemplate_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "ApiClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailTemplateVersion" ADD CONSTRAINT "EmailTemplateVersion_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "EmailTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailCampaign" ADD CONSTRAINT "EmailCampaign_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "ApiClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailCampaign" ADD CONSTRAINT "EmailCampaign_templateVersionId_fkey" FOREIGN KEY ("templateVersionId") REFERENCES "EmailTemplateVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailCampaign" ADD CONSTRAINT "EmailCampaign_segmentId_fkey" FOREIGN KEY ("segmentId") REFERENCES "EmailSegment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailCampaign" ADD CONSTRAINT "EmailCampaign_listId_fkey" FOREIGN KEY ("listId") REFERENCES "EmailList"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailCampaign" ADD CONSTRAINT "EmailCampaign_senderIdentityId_fkey" FOREIGN KEY ("senderIdentityId") REFERENCES "EmailSenderIdentity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailCampaignRecipient" ADD CONSTRAINT "EmailCampaignRecipient_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "EmailCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailCampaignRecipient" ADD CONSTRAINT "EmailCampaignRecipient_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "EmailContact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailDelivery" ADD CONSTRAINT "EmailDelivery_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "ApiClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailDelivery" ADD CONSTRAINT "EmailDelivery_campaignRecipientId_fkey" FOREIGN KEY ("campaignRecipientId") REFERENCES "EmailCampaignRecipient"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailEvent" ADD CONSTRAINT "EmailEvent_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "ApiClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailEvent" ADD CONSTRAINT "EmailEvent_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "EmailDelivery"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailSuppression" ADD CONSTRAINT "EmailSuppression_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "ApiClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- ==============================================================================
-- Row Level Security (RLS) & Role Privileges for Email Platform Foundation
-- ==============================================================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'whatsapp_hub') THEN
    CREATE ROLE whatsapp_hub NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
END $$;

ALTER TABLE "EmailProviderConfig" ENABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE "EmailProviderConfig" TO whatsapp_hub;
REVOKE ALL ON TABLE "EmailProviderConfig" FROM anon, authenticated;
CREATE POLICY "whatsapp_hub_emailproviderconfig_all" ON "EmailProviderConfig" FOR ALL TO whatsapp_hub USING (true) WITH CHECK (true);

ALTER TABLE "EmailSenderIdentity" ENABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE "EmailSenderIdentity" TO whatsapp_hub;
REVOKE ALL ON TABLE "EmailSenderIdentity" FROM anon, authenticated;
CREATE POLICY "whatsapp_hub_emailsenderidentity_all" ON "EmailSenderIdentity" FOR ALL TO whatsapp_hub USING (true) WITH CHECK (true);

ALTER TABLE "EmailContact" ENABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE "EmailContact" TO whatsapp_hub;
REVOKE ALL ON TABLE "EmailContact" FROM anon, authenticated;
CREATE POLICY "whatsapp_hub_emailcontact_all" ON "EmailContact" FOR ALL TO whatsapp_hub USING (true) WITH CHECK (true);

ALTER TABLE "EmailList" ENABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE "EmailList" TO whatsapp_hub;
REVOKE ALL ON TABLE "EmailList" FROM anon, authenticated;
CREATE POLICY "whatsapp_hub_emaillist_all" ON "EmailList" FOR ALL TO whatsapp_hub USING (true) WITH CHECK (true);

ALTER TABLE "EmailListMember" ENABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE "EmailListMember" TO whatsapp_hub;
REVOKE ALL ON TABLE "EmailListMember" FROM anon, authenticated;
CREATE POLICY "whatsapp_hub_emaillistmember_all" ON "EmailListMember" FOR ALL TO whatsapp_hub USING (true) WITH CHECK (true);

ALTER TABLE "EmailSegment" ENABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE "EmailSegment" TO whatsapp_hub;
REVOKE ALL ON TABLE "EmailSegment" FROM anon, authenticated;
CREATE POLICY "whatsapp_hub_emailsegment_all" ON "EmailSegment" FOR ALL TO whatsapp_hub USING (true) WITH CHECK (true);

ALTER TABLE "EmailTemplate" ENABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE "EmailTemplate" TO whatsapp_hub;
REVOKE ALL ON TABLE "EmailTemplate" FROM anon, authenticated;
CREATE POLICY "whatsapp_hub_emailtemplate_all" ON "EmailTemplate" FOR ALL TO whatsapp_hub USING (true) WITH CHECK (true);

ALTER TABLE "EmailTemplateVersion" ENABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE "EmailTemplateVersion" TO whatsapp_hub;
REVOKE ALL ON TABLE "EmailTemplateVersion" FROM anon, authenticated;
CREATE POLICY "whatsapp_hub_emailtemplateversion_all" ON "EmailTemplateVersion" FOR ALL TO whatsapp_hub USING (true) WITH CHECK (true);

ALTER TABLE "EmailCampaign" ENABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE "EmailCampaign" TO whatsapp_hub;
REVOKE ALL ON TABLE "EmailCampaign" FROM anon, authenticated;
CREATE POLICY "whatsapp_hub_emailcampaign_all" ON "EmailCampaign" FOR ALL TO whatsapp_hub USING (true) WITH CHECK (true);

ALTER TABLE "EmailCampaignRecipient" ENABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE "EmailCampaignRecipient" TO whatsapp_hub;
REVOKE ALL ON TABLE "EmailCampaignRecipient" FROM anon, authenticated;
CREATE POLICY "whatsapp_hub_emailcampaignrecipient_all" ON "EmailCampaignRecipient" FOR ALL TO whatsapp_hub USING (true) WITH CHECK (true);

ALTER TABLE "EmailDelivery" ENABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE "EmailDelivery" TO whatsapp_hub;
REVOKE ALL ON TABLE "EmailDelivery" FROM anon, authenticated;
CREATE POLICY "whatsapp_hub_emaildelivery_all" ON "EmailDelivery" FOR ALL TO whatsapp_hub USING (true) WITH CHECK (true);

ALTER TABLE "EmailEvent" ENABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE "EmailEvent" TO whatsapp_hub;
REVOKE ALL ON TABLE "EmailEvent" FROM anon, authenticated;
CREATE POLICY "whatsapp_hub_emailevent_all" ON "EmailEvent" FOR ALL TO whatsapp_hub USING (true) WITH CHECK (true);

ALTER TABLE "EmailSuppression" ENABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE "EmailSuppression" TO whatsapp_hub;
REVOKE ALL ON TABLE "EmailSuppression" FROM anon, authenticated;
CREATE POLICY "whatsapp_hub_emailsuppression_all" ON "EmailSuppression" FOR ALL TO whatsapp_hub USING (true) WITH CHECK (true);
