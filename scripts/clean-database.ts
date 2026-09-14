import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function clean() {
  console.log("Cleaning all dummy data from SQLite database...");
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
