-- RBAC authentication tables
CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'VIEWER');

CREATE TABLE "User" (
  "id" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "passwordHash" TEXT NOT NULL,
  "role" "UserRole" NOT NULL DEFAULT 'VIEWER',
  "active" BOOLEAN NOT NULL DEFAULT true,
  "lastLoginAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE INDEX "User_role_idx" ON "User"("role");
CREATE INDEX "User_active_idx" ON "User"("active");

CREATE TABLE "UserSession" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UserSession_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UserSession_tokenHash_key" ON "UserSession"("tokenHash");
CREATE INDEX "UserSession_userId_idx" ON "UserSession"("userId");
CREATE INDEX "UserSession_expiresAt_idx" ON "UserSession"("expiresAt");

ALTER TABLE "UserSession" ADD CONSTRAINT "UserSession_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Demo administrator requested for initial access.
-- Password is stored as an scrypt hash, never plaintext.
INSERT INTO "User" ("id","email","passwordHash","role","active","updatedAt")
VALUES (
  '9f9d8a7e-8b0d-4b63-a2f8-4e3c6f7a1001',
  'cosora.demo@gmail.com',
  'scrypt$16384$8$1$pzQ-q1sUI80yPxEVx91itg$FpDkMTfBs-ygedgCfk3YRRuZoCS4V7RTnR9iDzk8_DMjZBUT1Ctl-ATEKBsSxo1IKKQD26DDyV92FB8BSXQzoQ',
  'ADMIN',
  true,
  CURRENT_TIMESTAMP
)
ON CONFLICT ("email") DO NOTHING;
