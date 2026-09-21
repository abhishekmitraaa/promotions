import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { execSync } from "child_process";
import { prisma } from "../src/lib/prisma";
import { generateApiKey } from "../src/lib/crypto";

async function main() {
  console.log("\n==================================================================");
  console.log("🚀 WhatsApp Messaging Hub - Automated Local Setup");
  console.log("==================================================================\n");

  const rootDir = path.resolve(__dirname, "..");
  const envExamplePath = path.join(rootDir, ".env.example");
  const envLocalPath = path.join(rootDir, ".env.local");
  const envPath = path.join(rootDir, ".env");

  let createdLocalEnv = false;
  let activePepper = "";

  // Step 1: Ensure .env.local or .env exists
  if (!fs.existsSync(envLocalPath) && !fs.existsSync(envPath)) {
    console.log("📄 No .env.local found. Generating fresh configuration from .env.example...");
    let content = fs.readFileSync(envExamplePath, "utf-8");

    // Generate cryptographically random pepper & session secret
    const generatedPepper = crypto.randomBytes(32).toString("hex");
    const generatedSessionSecret = crypto.randomBytes(32).toString("hex");
    activePepper = generatedPepper;

    content = content.replace(
      /API_KEY_PEPPER="[^"]*"/,
      `API_KEY_PEPPER="${generatedPepper}"`
    );
    content = content.replace(
      /AUTH_SESSION_SECRET="[^"]*"/,
      `AUTH_SESSION_SECRET="${generatedSessionSecret}"`
    );

    fs.writeFileSync(envLocalPath, content, "utf-8");
    createdLocalEnv = true;
    console.log("✅ Created .env.local with random API pepper and session secret");
  } else {
    console.log("✅ Environment configuration file present");
    const targetFile = fs.existsSync(envLocalPath) ? envLocalPath : envPath;
    const existingContent = fs.readFileSync(targetFile, "utf-8");
    const pepperMatch = existingContent.match(/API_KEY_PEPPER="([^"]+)"/);
    if (pepperMatch) activePepper = pepperMatch[1];
  }

  if (activePepper) {
    process.env.API_KEY_PEPPER = activePepper;
  }

  // Step 2: Push database schema using Prisma
  console.log("\n📦 Synchronizing Supabase PostgreSQL database schema...");
  try {
    execSync("npx prisma generate", { stdio: "inherit", cwd: rootDir });
    execSync("npx prisma db push --skip-generate", { stdio: "inherit", cwd: rootDir });
    console.log("✅ Database schema synchronized successfully");
  } catch (err) {
    console.error("❌ Failed to push Prisma database schema:", err);
    process.exit(1);
  }

  // Step 3: Ensure at least one API client and key exist
  console.log("\n🔑 Checking for active API keys...");
  const existingKey = await prisma.apiKey.findFirst({
    where: { revokedAt: null },
    include: { client: true },
  });

  if (existingKey) {
    console.log(`ℹ️ Existing active API key found: '${existingKey.name}' for client '${existingKey.client.name}' (Prefix: ${existingKey.keyPrefix})`);
  } else {
    console.log("Creating default development client and initial API key...");
    const client = await prisma.apiClient.create({
      data: {
        name: "Development Client",
        description: "Default client created by npm run setup",
      },
    });

    const { rawKey, keyPrefix, keyHash } = generateApiKey(activePepper);

    await prisma.apiKey.create({
      data: {
        clientId: client.id,
        name: "Default Dev Key",
        keyPrefix,
        keyHash,
      },
    });

    console.log("\n------------------------------------------------------------------");
    console.log("🔐 INITIAL DEVELOPMENT API KEY (SAVE THIS KEY):");
    console.log(`\n  ${rawKey}\n`);
    console.log("Header usage:");
    console.log(`  Authorization: Bearer ${rawKey}`);
    console.log("------------------------------------------------------------------");
  }

  console.log("\n==================================================================");
  console.log("🎉 Local Setup Completed Successfully!");
  console.log("==================================================================");
  console.log("\nQuick Start Guide:");
  console.log("  1. Start dev server:      npm run dev");
  console.log("  2. Open Dashboard:        http://localhost:3000/dashboard");
  console.log("  3. Provision Admin:       DEMO_ADMIN_PASSWORD=your_password npm run auth:seed-admin");
  console.log("  4. Check Health API:      http://localhost:3000/api/health");
  console.log("  5. Run Test Suite:        npm test\n");
}

main()
  .catch((e) => {
    console.error("❌ Setup failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
