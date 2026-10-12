-- One-time Google OAuth transaction state, replacing the Redis-backed store.

CREATE TABLE "OAuthState" (
    "nonce" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "adminUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),

    CONSTRAINT "OAuthState_pkey" PRIMARY KEY ("nonce")
);

CREATE INDEX "OAuthState_expiresAt_idx" ON "OAuthState"("expiresAt");

ALTER TABLE "OAuthState" ENABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE "OAuthState" TO whatsapp_hub;
REVOKE ALL ON TABLE "OAuthState" FROM anon, authenticated;
CREATE POLICY "whatsapp_hub_oauthstate_all" ON "OAuthState" FOR ALL TO whatsapp_hub USING (true) WITH CHECK (true);
