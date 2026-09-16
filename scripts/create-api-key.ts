import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

import { prisma } from "../src/lib/prisma";
import { generateApiKey } from "../src/lib/crypto";

async function main() {
  const args = process.argv.slice(2);
  let clientName = "Default Client";
  let keyName = "Primary API Key";
  let description = "Generated via create-api-key CLI script";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--client" && args[i + 1]) {
      clientName = args[i + 1];
      i++;
    } else if (args[i] === "--key" && args[i + 1]) {
      keyName = args[i + 1];
      i++;
    } else if (args[i] === "--desc" && args[i + 1]) {
      description = args[i + 1];
      i++;
    }
  }

  console.log("\n=======================================================");
  console.log("🔑 Creating API Client & Generating API Key...");
  console.log("=======================================================\n");

  let client = await prisma.apiClient.findFirst({
    where: { name: clientName },
  });

  if (!client) {
    client = await prisma.apiClient.create({
      data: {
        name: clientName,
        description,
      },
    });
    console.log(`✅ Created API Client: ${client.name} (ID: ${client.id})`);
  } else {
    console.log(`ℹ️ Using existing API Client: ${client.name} (ID: ${client.id})`);
  }

  const { rawKey, keyPrefix, keyHash } = generateApiKey();

  const apiKeyRecord = await prisma.apiKey.create({
    data: {
      clientId: client.id,
      name: keyName,
      keyPrefix,
      keyHash,
    },
  });

  console.log(`✅ Created API Key Record: ${apiKeyRecord.name} (ID: ${apiKeyRecord.id})`);
  console.log("\n-------------------------------------------------------");
  console.log("🔐 RAW API KEY (COPY IT NOW - IT WILL NOT BE SHOWN AGAIN):");
  console.log(`\n  ${rawKey}\n`);
  console.log("-------------------------------------------------------");
  console.log("Header usage:");
  console.log(`Authorization: Bearer ${rawKey}\n`);
}

main()
  .catch((e) => {
    console.error("❌ Failed to create API key:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
