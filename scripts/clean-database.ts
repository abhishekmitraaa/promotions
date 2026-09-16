import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function clean() {
  if (process.env.NODE_ENV === "production" || process.env.ALLOW_DATABASE_CLEAN !== "true") {
    console.error("❌ FATAL: clean-database is locked. Running clean-database against production or without ALLOW_DATABASE_CLEAN=true is strictly forbidden.");
    process.exit(1);
  }
  console.log("Cleaning dummy data from development database...");
  const delDeliveries = await prisma.webhookDelivery.deleteMany({});
  const delEndpoints = await prisma.webhookEndpoint.deleteMany({});
  const delEvents = await prisma.messageEvent.deleteMany({});
  const delMessages = await prisma.message.deleteMany({});
  const delOtps = await prisma.otpVerification.deleteMany({});
  const delKeys = await prisma.apiKey.deleteMany({});
  const delClients = await prisma.apiClient.deleteMany({});

  console.log("Deleted dummy records successfully:", {
    messages: delMessages.count,
    events: delEvents.count,
    deliveries: delDeliveries.count,
    endpoints: delEndpoints.count,
    otps: delOtps.count,
    keys: delKeys.count,
    clients: delClients.count,
  });

  await prisma.$disconnect();
}

clean().catch((e) => {
  console.error(e);
  process.exit(1);
});
