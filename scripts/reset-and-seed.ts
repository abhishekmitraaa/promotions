import { prisma } from "../src/lib/prisma";
import { generateApiKey } from "../src/lib/crypto";

async function resetAndSeed() {
  console.log("\n=======================================================");
  console.log("🧹 1. PURGING ALL EXISTING DATA FROM SQLITE DATABASE");
  console.log("=======================================================\n");

  // Delete child records first to respect relational dependencies
  const deletedDeliveries = await prisma.webhookDelivery.deleteMany();
  const deletedEvents = await prisma.messageEvent.deleteMany();
  const deletedMessages = await prisma.message.deleteMany();
  const deletedEndpoints = await prisma.webhookEndpoint.deleteMany();
  const deletedOtps = await prisma.otpVerification.deleteMany();
  const deletedKeys = await prisma.apiKey.deleteMany();
  const deletedClients = await prisma.apiClient.deleteMany();

  console.log(`  🗑️ Deleted Webhook Deliveries : ${deletedDeliveries.count}`);
  console.log(`  🗑️ Deleted Message Events     : ${deletedEvents.count}`);
  console.log(`  🗑️ Deleted Messages           : ${deletedMessages.count}`);
  console.log(`  🗑️ Deleted Webhook Endpoints  : ${deletedEndpoints.count}`);
  console.log(`  🗑️ Deleted OTP Records        : ${deletedOtps.count}`);
  console.log(`  🗑️ Deleted API Keys           : ${deletedKeys.count}`);
  console.log(`  🗑️ Deleted API Clients        : ${deletedClients.count}`);
  console.log("  ✨ Database is completely empty and clean!\n");

  console.log("=======================================================");
  console.log("👤 2. DEPLOYING FAKE USER / ENTERPRISE API CLIENT");
  console.log("=======================================================\n");

  const clientName = "Apex Logistics Global";
  const clientDescription = "Enterprise client for freight tracking and customer notifications";
  const keyName = "Apex Production Key";

  const client = await prisma.apiClient.create({
    data: {
      name: clientName,
      description: clientDescription,
    },
  });

  const { rawKey, keyPrefix, keyHash } = generateApiKey();

  const apiKeyRecord = await prisma.apiKey.create({
    data: {
      clientId: client.id,
      name: keyName,
      keyPrefix,
      keyHash,
    },
  });

  console.log(`  🏢 Client Created    : ${client.name}`);
  console.log(`  🆔 Client ID         : ${client.id}`);
  console.log(`  🔑 Key Name          : ${apiKeyRecord.name}`);
  console.log(`  🏷️ Key Prefix        : ${apiKeyRecord.keyPrefix}`);
  console.log(`  🔐 RAW BEARER KEY    : ${rawKey}`);
  console.log("\n-------------------------------------------------------");
  console.log("Use this key for all authenticated /api/v1 requests:");
  console.log(`Authorization: Bearer ${rawKey}`);
  console.log("-------------------------------------------------------\n");

  return { client, apiKeyRecord, rawKey };
}

resetAndSeed()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error("❌ Reset and seed failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
