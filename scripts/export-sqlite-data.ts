import fs from "fs";
import path from "path";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const clients = await prisma.apiClient.findMany({ include: { keys: true } });
  const messages = await prisma.message.findMany();
  const events = await prisma.messageEvent.findMany();
  const webhooks = await prisma.webhookEndpoint.findMany({ include: { deliveries: true } });
  const deliveries = await prisma.webhookDelivery.findMany();
  const otps = await prisma.otpVerification.findMany();

  const exportData = {
    exportedAt: new Date().toISOString(),
    clients,
    messages,
    events,
    webhooks,
    deliveries,
    otps,
  };

  const backupPath = path.resolve(__dirname, "../prisma/backups/sqlite-export.json");
  fs.writeFileSync(backupPath, JSON.stringify(exportData, null, 2), "utf-8");
  console.log(`✅ Exported SQLite data to ${backupPath}`);
  console.log(`Summary: ${clients.length} clients, ${messages.length} messages, ${events.length} events, ${webhooks.length} webhooks, ${deliveries.length} deliveries, ${otps.length} otps`);
}

main()
  .catch((e) => {
    console.error("Export failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
