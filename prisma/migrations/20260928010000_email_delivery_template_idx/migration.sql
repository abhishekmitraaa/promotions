-- Migration: 20260928010000_email_delivery_template_idx
-- Reconcile missing index on EmailDelivery(templateId)

CREATE INDEX IF NOT EXISTS "EmailDelivery_templateId_idx" ON "EmailDelivery"("templateId");
