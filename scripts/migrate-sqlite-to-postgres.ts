import fs from "fs";
import path from "path";
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

import { prisma } from "../src/lib/prisma";
import { encryptWebhookSecret } from "../src/lib/crypto";

async function main() {
  console.log("\n==================================================================");
  console.log("📦 SQLite to Supabase PostgreSQL Data Migration");
  console.log("==================================================================\n");

  const backupJsonPath = path.resolve(__dirname, "../prisma/backups/sqlite-export.json");
  if (!fs.existsSync(backupJsonPath)) {
    console.error(`❌ Source backup file not found at ${backupJsonPath}`);
    console.error("Please ensure prisma/backups/sqlite-export.json exists before running data migration.");
    process.exit(1);
  }

  const exportData = JSON.parse(fs.readFileSync(backupJsonPath, "utf-8"));
  console.log(`📄 Loaded SQLite export from: ${backupJsonPath}`);
  console.log(`Timestamp of export: ${exportData.exportedAt || "unknown"}`);

  // 1. Migrate ApiClients
  console.log("\n1. Migrating ApiClients...");
  const clients = exportData.clients || [];
  for (const client of clients) {
    await prisma.apiClient.upsert({
      where: { id: client.id },
      create: {
        id: client.id,
        name: client.name,
        description: client.description,
        active: client.active,
        createdAt: new Date(client.createdAt),
        updatedAt: new Date(client.updatedAt),
      },
      update: {
        name: client.name,
        description: client.description,
        active: client.active,
      },
    });

    // Migrate nested ApiKeys for this client
    if (client.keys && Array.isArray(client.keys)) {
      for (const key of client.keys) {
        await prisma.apiKey.upsert({
          where: { keyHash: key.keyHash },
          create: {
            id: key.id,
            clientId: client.id,
            name: key.name,
            keyPrefix: key.keyPrefix,
            keyHash: key.keyHash,
            lastUsedAt: key.lastUsedAt ? new Date(key.lastUsedAt) : null,
            expiresAt: key.expiresAt ? new Date(key.expiresAt) : null,
            revokedAt: key.revokedAt ? new Date(key.revokedAt) : null,
            createdAt: new Date(key.createdAt),
          },
          update: {
            name: key.name,
            lastUsedAt: key.lastUsedAt ? new Date(key.lastUsedAt) : null,
            expiresAt: key.expiresAt ? new Date(key.expiresAt) : null,
            revokedAt: key.revokedAt ? new Date(key.revokedAt) : null,
          },
        });
      }
    }
  }
  console.log(`✅ Upserted ${clients.length} ApiClient(s)`);

  const defaultClientId = clients[0]?.id || "76a6a294-629c-4b5f-9c4d-f2f26fce4b22";

  // 2. Migrate WebhookEndpoints
  console.log("\n2. Migrating WebhookEndpoints...");
  const webhooks = exportData.webhooks || [];
  for (const ep of webhooks) {
    const encryptedSecret = ep.encryptedSecret || encryptWebhookSecret(ep.secretHash || "default_secret");
    await prisma.webhookEndpoint.upsert({
      where: { id: ep.id },
      create: {
        id: ep.id,
        clientId: ep.clientId || defaultClientId,
        name: ep.name,
        url: ep.url,
        encryptedSecret,
        active: ep.active,
        subscribedEvents: ep.subscribedEvents,
        createdAt: new Date(ep.createdAt),
        updatedAt: new Date(ep.updatedAt),
      },
      update: {
        name: ep.name,
        url: ep.url,
        active: ep.active,
        subscribedEvents: ep.subscribedEvents,
      },
    });
  }
  console.log(`✅ Upserted ${webhooks.length} WebhookEndpoint(s)`);

  // 3. Migrate Messages
  console.log("\n3. Migrating Messages...");
  const messages = exportData.messages || [];
  for (const msg of messages) {
    await prisma.message.upsert({
      where: { id: msg.id },
      create: {
        id: msg.id,
        clientId: msg.clientId || defaultClientId,
        providerMessageId: msg.providerMessageId || null,
        direction: msg.direction,
        type: msg.type,
        status: msg.status,
        from: msg.from,
        to: msg.to,
        body: msg.body,
        templateName: msg.templateName,
        templateLanguage: msg.templateLanguage,
        templateParameters: msg.templateParameters,
        mediaId: msg.mediaId,
        mediaUrl: msg.mediaUrl,
        errorCode: msg.errorCode,
        errorMessage: msg.errorMessage,
        metadata: msg.metadata,
        idempotencyKey: msg.idempotencyKey || null,
        sentAt: msg.sentAt ? new Date(msg.sentAt) : null,
        deliveredAt: msg.deliveredAt ? new Date(msg.deliveredAt) : null,
        readAt: msg.readAt ? new Date(msg.readAt) : null,
        failedAt: msg.failedAt ? new Date(msg.failedAt) : null,
        createdAt: new Date(msg.createdAt),
        updatedAt: new Date(msg.updatedAt),
      },
      update: {
        status: msg.status,
        deliveredAt: msg.deliveredAt ? new Date(msg.deliveredAt) : null,
        readAt: msg.readAt ? new Date(msg.readAt) : null,
      },
    });
  }
  console.log(`✅ Upserted ${messages.length} Message(s)`);

  // 4. Migrate MessageEvents
  console.log("\n4. Migrating MessageEvents...");
  const events = exportData.events || [];
  for (const ev of events) {
    await prisma.messageEvent.upsert({
      where: { id: ev.id },
      create: {
        id: ev.id,
        clientId: ev.clientId || defaultClientId,
        providerEventId: ev.providerEventId || null,
        providerMessageId: ev.providerMessageId || null,
        eventType: ev.eventType,
        payload: ev.payload,
        processingStatus: ev.processingStatus,
        errorMessage: ev.errorMessage,
        receivedAt: new Date(ev.receivedAt),
        processedAt: ev.processedAt ? new Date(ev.processedAt) : null,
        createdAt: new Date(ev.createdAt),
      },
      update: {
        processingStatus: ev.processingStatus,
        errorMessage: ev.errorMessage,
        processedAt: ev.processedAt ? new Date(ev.processedAt) : null,
      },
    });
  }
  console.log(`✅ Upserted ${events.length} MessageEvent(s)`);

  // 5. Migrate WebhookDeliveries
  console.log("\n5. Migrating WebhookDeliveries...");
  const deliveries = exportData.deliveries || [];
  for (const del of deliveries) {
    await prisma.webhookDelivery.upsert({
      where: { id: del.id },
      create: {
        id: del.id,
        clientId: del.clientId || defaultClientId,
        endpointId: del.endpointId,
        eventId: del.eventId,
        messageEventId: del.messageEventId,
        eventType: del.eventType,
        payload: del.payload,
        status: del.status,
        attemptCount: del.attemptCount,
        nextAttemptAt: del.nextAttemptAt ? new Date(del.nextAttemptAt) : null,
        lastAttemptAt: del.lastAttemptAt ? new Date(del.lastAttemptAt) : null,
        responseStatus: del.responseStatus,
        responseBody: del.responseBody,
        errorMessage: del.errorMessage,
        createdAt: new Date(del.createdAt),
        updatedAt: new Date(del.updatedAt),
      },
      update: {
        status: del.status,
        attemptCount: del.attemptCount,
        lastAttemptAt: del.lastAttemptAt ? new Date(del.lastAttemptAt) : null,
      },
    });
  }
  console.log(`✅ Upserted ${deliveries.length} WebhookDelivery(ies)`);

  // 6. Migrate OtpVerifications
  console.log("\n6. Migrating OtpVerifications...");
  const otps = exportData.otps || [];
  for (const otp of otps) {
    await prisma.otpVerification.upsert({
      where: { id: otp.id },
      create: {
        id: otp.id,
        clientId: otp.clientId || defaultClientId,
        destination: otp.destination,
        purpose: otp.purpose,
        codeHash: otp.codeHash,
        status: otp.status,
        expiresAt: new Date(otp.expiresAt),
        attempts: otp.attempts,
        verifiedAt: otp.verifiedAt ? new Date(otp.verifiedAt) : null,
        createdAt: new Date(otp.createdAt),
        updatedAt: new Date(otp.updatedAt),
      },
      update: {
        status: otp.status,
        attempts: otp.attempts,
        verifiedAt: otp.verifiedAt ? new Date(otp.verifiedAt) : null,
      },
    });
  }
  console.log(`✅ Upserted ${otps.length} OtpVerification(s)`);

  console.log("\n==================================================================");
  console.log("🎉 SQLite to Supabase PostgreSQL Migration Completed Successfully!");
  console.log("==================================================================\n");
}

main()
  .catch((e) => {
    console.error("❌ Data migration failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
