-- Outbound WhatsApp retry support: attempt counter and claim/in-flight lock on Message.

ALTER TABLE "Message" ADD COLUMN "attemptCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Message" ADD COLUMN "lockedAt" TIMESTAMP(3);
ALTER TABLE "Message" ADD COLUMN "lockedBy" TEXT;

CREATE INDEX "Message_lockedAt_idx" ON "Message"("lockedAt");
