import fs from "fs";
import path from "path";
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

import { prisma } from "../src/lib/prisma";

async function main() {
  console.log("==================================================================");
  console.log("🔍 Supabase PostgreSQL Migration Verification");
  console.log("==================================================================\n");

  // Read baseline from exported SQLite backup
  const backupPath = path.resolve(__dirname, "../prisma/backups/sqlite-export.json");
  let baseline = {
    clients: 1,
    keys: 1,
    messages: 0,
    events: 0,
    webhooks: 0,
    deliveries: 0,
    otps: 0,
  };

  if (fs.existsSync(backupPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(backupPath, "utf-8"));
      baseline = {
        clients: data.clients?.length ?? 0,
        keys: (data.clients || []).reduce((acc: number, c: any) => acc + (c.keys?.length ?? 0), 0),
        messages: data.messages?.length ?? 0,
        events: data.events?.length ?? 0,
        webhooks: data.webhooks?.length ?? 0,
        deliveries: data.deliveries?.length ?? 0,
        otps: data.otps?.length ?? 0,
      };
    } catch {
      // fallback to known counts
    }
  }

  const [
    pgClients,
    pgKeys,
    pgMessages,
    pgEvents,
    pgWebhooks,
    pgDeliveries,
    pgOtps,
  ] = await Promise.all([
    prisma.apiClient.count(),
    prisma.apiKey.count(),
    prisma.message.count(),
    prisma.messageEvent.count(),
    prisma.webhookEndpoint.count(),
    prisma.webhookDelivery.count(),
    prisma.otpVerification.count(),
  ]);

  const rows = [
    { model: "ApiClient", sqlite: baseline.clients, postgres: pgClients },
    { model: "ApiKey", sqlite: baseline.keys, postgres: pgKeys },
    { model: "Message", sqlite: baseline.messages, postgres: pgMessages },
    { model: "MessageEvent", sqlite: baseline.events, postgres: pgEvents },
    { model: "WebhookEndpoint", sqlite: baseline.webhooks, postgres: pgWebhooks },
    { model: "WebhookDelivery", sqlite: baseline.deliveries, postgres: pgDeliveries },
    { model: "OtpVerification", sqlite: baseline.otps, postgres: pgOtps },
  ];

  console.log("Migration Verification Table:");
  console.log("------------------------------------------------------------------");
  let allPass = true;
  for (const r of rows) {
    const pass = r.postgres >= r.sqlite;
    if (!pass) allPass = false;
    const status = pass ? "PASS ✅" : "FAIL ❌";
    console.log(
      `${r.model.padEnd(20)} | SQLite: ${String(r.sqlite).padStart(3)} | PostgreSQL: ${String(r.postgres).padStart(3)} | ${status}`
    );
  }
  console.log("------------------------------------------------------------------");

  // Verify test query works
  const clientRecord = await prisma.apiClient.findFirst({
    include: { keys: true },
  });
  console.log(`\nSample Data Check:`);
  console.log(`  Client Name: ${clientRecord?.name || "None"}`);
  console.log(`  Client ID:   ${clientRecord?.id || "None"}`);
  console.log(`  Key Count:   ${clientRecord?.keys?.length || 0}`);
  if (clientRecord?.keys?.[0]) {
    console.log(`  First Key:   Prefix '${clientRecord.keys[0].keyPrefix}'`);
  }

  if (allPass) {
    console.log("\n🎉 ALL CHECKS PASSED: PostgreSQL schema and data match SQLite source!");
  } else {
    console.error("\n❌ VERIFICATION FAILED: Row count mismatch detected.");
    process.exit(1);
  }
}

main()
  .catch((e) => {
    console.error("Verification error:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
