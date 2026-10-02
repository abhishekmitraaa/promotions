-- ==============================================================================
-- Migration: 20261002000000_immutable_provider_binding
-- Adds immutable providerConfigId & senderIdentityId bindings to EmailDelivery,
-- supporting indexes, and Supabase RLS safety policies.
-- ==============================================================================

-- 1. Add immutable binding columns to EmailDelivery
ALTER TABLE "EmailDelivery" ADD COLUMN IF NOT EXISTS "providerConfigId" TEXT;
ALTER TABLE "EmailDelivery" ADD COLUMN IF NOT EXISTS "senderIdentityId" TEXT;

-- 2. Foreign Keys for EmailDelivery bindings
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'EmailDelivery_providerConfigId_fkey'
  ) THEN
    ALTER TABLE "EmailDelivery" ADD CONSTRAINT "EmailDelivery_providerConfigId_fkey"
      FOREIGN KEY ("providerConfigId") REFERENCES "EmailProviderConfig"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'EmailDelivery_senderIdentityId_fkey'
  ) THEN
    ALTER TABLE "EmailDelivery" ADD CONSTRAINT "EmailDelivery_senderIdentityId_fkey"
      FOREIGN KEY ("senderIdentityId") REFERENCES "EmailSenderIdentity"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- 3. Indexes for immutable provider bindings
CREATE INDEX IF NOT EXISTS "EmailDelivery_providerConfigId_idx" ON "EmailDelivery"("providerConfigId");
CREATE INDEX IF NOT EXISTS "EmailDelivery_senderIdentityId_idx" ON "EmailDelivery"("senderIdentityId");

-- 4. Supabase RLS Policy Remediation for EmailDomain (Safe execution across table owners and app roles)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'whatsapp_hub') THEN
    BEGIN
      GRANT ALL ON TABLE "EmailDomain" TO whatsapp_hub;
    EXCEPTION
      WHEN OTHERS THEN null;
    END;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    BEGIN
      REVOKE ALL ON TABLE "EmailDomain" FROM anon, authenticated;
    EXCEPTION
      WHEN OTHERS THEN null;
    END;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE policyname = 'whatsapp_hub_emaildomain_all'
  ) THEN
    BEGIN
      IF (SELECT tableowner FROM pg_tables WHERE tablename = 'EmailDomain') = current_user OR (SELECT usesuper FROM pg_user WHERE usename = current_user) THEN
        CREATE POLICY "whatsapp_hub_emaildomain_all" ON "EmailDomain" FOR ALL TO whatsapp_hub USING (true) WITH CHECK (true);
      END IF;
    EXCEPTION
      WHEN OTHERS THEN null;
    END;
  END IF;
END $$;

-- 5. Ensure _prisma_migrations does not have active RLS blocking migrations
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = '_prisma_migrations') THEN
    BEGIN
      IF (SELECT tableowner FROM pg_tables WHERE tablename = '_prisma_migrations') = current_user OR (SELECT usesuper FROM pg_user WHERE usename = current_user) THEN
        ALTER TABLE "_prisma_migrations" DISABLE ROW LEVEL SECURITY;
      END IF;
    EXCEPTION
      WHEN OTHERS THEN null;
    END;
  END IF;
END $$;
