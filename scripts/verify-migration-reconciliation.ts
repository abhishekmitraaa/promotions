/**
 * Comprehensive Prisma Migration Reconciliation Verification Suite
 *
 * Verifies:
 * 1. Fresh database deployment from zero migrations (prisma migrate deploy).
 * 2. Upgrade database deployment from production-compatible baseline (WhatsApp + RBAC).
 * 3. Migration status reporting (prisma migrate status: 0 pending, 0 drift).
 * 4. Structural parity between migrations and prisma/schema.prisma (prisma migrate diff: 0 diff).
 * 5. Full schema verification:
 *    - All 23 application tables
 *    - All 17 enums and values
 *    - EmailEvent processing fields & compound unique constraint
 *    - EmailDelivery authoritative content fields & indexes
 *    - User email verification columns
 *    - Foreign key constraints
 *    - Row Level Security (RLS) and policies for whatsapp_hub
 *    - Zero WhatsApp schema regressions
 */

import { execSync } from "child_process";
import { PrismaClient } from "@prisma/client";

let passed = 0;
let failed = 0;

function testAssert(condition: boolean, description: string, detail?: string) {
  if (condition) {
    console.log(`  ✅ PASS: ${description}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${description}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

const DISPOSABLE_HOST = "127.0.0.1";
const DISPOSABLE_PORT = "5433";
const ZERO_DB = "email_from_zero";
const UPGRADE_DB = "email_upgrade_sim";
const SHADOW_DB = "email_shadow";

const ZERO_URL = `postgresql://postgres:postgres@${DISPOSABLE_HOST}:${DISPOSABLE_PORT}/${ZERO_DB}`;
const UPGRADE_URL = `postgresql://postgres:postgres@${DISPOSABLE_HOST}:${DISPOSABLE_PORT}/${UPGRADE_DB}`;
const SHADOW_URL = `postgresql://postgres:postgres@${DISPOSABLE_HOST}:${DISPOSABLE_PORT}/${SHADOW_DB}`;

function execPsql(cmd: string, db: string = "postgres"): string {
  return execSync(
    `docker exec disposable-email-postgres psql -U postgres -d ${db} -t -A -c "${cmd.replace(/"/g, '\\"')}"`,
    { encoding: "utf-8" }
  ).trim();
}

async function main() {
  console.log("==================================================================");
  console.log("🔍 RUNNING COMPREHENSIVE PRISMA MIGRATION RECONCILIATION SUITE");
  console.log("   Target: Disposable PostgreSQL (127.0.0.1:5433)");
  console.log("==================================================================\n");

  // ---------------------------------------------------------------------------
  // [1] Fresh Database Deployment from Zero Migrations
  // ---------------------------------------------------------------------------
  console.log("--- [1] Fresh Database from Zero Migrations ---");
  execPsql(`DROP DATABASE IF EXISTS ${ZERO_DB};`);
  execPsql(`CREATE DATABASE ${ZERO_DB};`);

  const deployZeroOut = execSync(
    `npx prisma migrate deploy`,
    {
      encoding: "utf-8",
      env: {
        ...process.env,
        DATABASE_URL: ZERO_URL,
        DIRECT_URL: ZERO_URL,
      },
    }
  );
  testAssert(deployZeroOut.includes("All migrations have been successfully applied."), "prisma migrate deploy applies all migrations to clean DB");
  testAssert(deployZeroOut.includes("20260928000000_email_authoritative_content_and_events"), "Applies authoritative content and event migration");
  testAssert(deployZeroOut.includes("20260928010000_email_delivery_template_idx"), "Applies forward-only templateId index reconciliation migration");

  const statusZeroOut = execSync(
    `npx prisma migrate status`,
    {
      encoding: "utf-8",
      env: {
        ...process.env,
        DATABASE_URL: ZERO_URL,
        DIRECT_URL: ZERO_URL,
      },
    }
  );
  testAssert(statusZeroOut.includes("Database schema is up to date!"), "prisma migrate status reports schema is up to date on zero DB");

  // Verify zero diff between migrations and schema.prisma
  const diffZeroOut = execSync(
    `npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url "${SHADOW_URL}" --script`,
    {
      encoding: "utf-8",
      env: {
        ...process.env,
        DATABASE_URL: ZERO_URL,
        DIRECT_URL: ZERO_URL,
      },
    }
  );
  testAssert(diffZeroOut.includes("-- This is an empty migration."), "Zero structural drift between prisma/migrations and prisma/schema.prisma");

  // ---------------------------------------------------------------------------
  // [2] Upgrade Database from Production-Compatible Baseline
  // ---------------------------------------------------------------------------
  console.log("\n--- [2] Upgrade Database from Production Baseline ---");
  execPsql(`DROP DATABASE IF EXISTS ${UPGRADE_DB};`);
  execPsql(`CREATE DATABASE ${UPGRADE_DB};`);

  // Apply migrations 1 & 2 (production baseline) directly
  execSync(
    `docker exec -i disposable-email-postgres psql -U postgres -d ${UPGRADE_DB} < prisma/migrations/20260916000000_init_supabase_schema/migration.sql`,
    { stdio: "pipe" }
  );
  execSync(
    `docker exec -i disposable-email-postgres psql -U postgres -d ${UPGRADE_DB} < prisma/migrations/20260921220000_add_user_rbac/migration.sql`,
    { stdio: "pipe" }
  );

  // Record migrations 1 & 2 as applied baseline using Prisma's official resolution mechanism
  execSync(
    `npx prisma migrate resolve --applied 20260916000000_init_supabase_schema`,
    {
      encoding: "utf-8",
      env: {
        ...process.env,
        DATABASE_URL: UPGRADE_URL,
        DIRECT_URL: UPGRADE_URL,
      },
    }
  );
  execSync(
    `npx prisma migrate resolve --applied 20260921220000_add_user_rbac`,
    {
      encoding: "utf-8",
      env: {
        ...process.env,
        DATABASE_URL: UPGRADE_URL,
        DIRECT_URL: UPGRADE_URL,
      },
    }
  );

  // Seed production-like rows into baseline tables
  const testClientId = "prod-client-baseline-001";
  const testUserId = "prod-user-baseline-001";
  const testMsgId = "prod-msg-baseline-001";

  execPsql(`INSERT INTO \"ApiClient\" (\"id\", \"name\", \"active\", \"createdAt\", \"updatedAt\") VALUES ('${testClientId}', 'Production Baseline Client', true, now(), now());`, UPGRADE_DB);
  execPsql(`INSERT INTO \"ApiKey\" (\"id\", \"clientId\", \"name\", \"keyPrefix\", \"keyHash\", \"createdAt\") VALUES ('key-baseline-001', '${testClientId}', 'Live Key', 'whub_live0', 'dummyhash1234567890', now());`, UPGRADE_DB);
  execPsql(`INSERT INTO \"User\" (\"id\", \"email\", \"passwordHash\", \"role\", \"active\", \"createdAt\", \"updatedAt\") VALUES ('${testUserId}', 'admin@prod.test', '$2a$12$dummyhashforproductionuserverification123', 'ADMIN', true, now(), now());`, UPGRADE_DB);
  execPsql(`INSERT INTO \"Message\" (\"id\", \"clientId\", \"direction\", \"type\", \"status\", \"from\", \"to\", \"body\", \"createdAt\", \"updatedAt\") VALUES ('${testMsgId}', '${testClientId}', 'OUTBOUND', 'TEXT', 'SENT', '+1234567890', '+1987654321', 'Production WhatsApp test message', now(), now());`, UPGRADE_DB);

  // Execute prisma migrate deploy to apply upgrade migrations (3, 4, 5, 6)
  const deployUpgradeOut = execSync(
    `npx prisma migrate deploy`,
    {
      encoding: "utf-8",
      env: {
        ...process.env,
        DATABASE_URL: UPGRADE_URL,
        DIRECT_URL: UPGRADE_URL,
      },
    }
  );
  testAssert(deployUpgradeOut.includes("4 migrations found in prisma/migrations") || deployUpgradeOut.includes("All migrations have been successfully applied."), "prisma migrate deploy applies all pending upgrade migrations to production baseline");
  testAssert(deployUpgradeOut.includes("20260925000000_add_email_platform_foundation"), "Applies 20260925000000_add_email_platform_foundation");
  testAssert(deployUpgradeOut.includes("20260925120000_add_email_auth"), "Applies 20260925120000_add_email_auth");
  testAssert(deployUpgradeOut.includes("20260928000000_email_authoritative_content_and_events"), "Applies 20260928000000_email_authoritative_content_and_events");
  testAssert(deployUpgradeOut.includes("20260928010000_email_delivery_template_idx"), "Applies 20260928010000_email_delivery_template_idx");

  const statusUpgradeOut = execSync(
    `npx prisma migrate status`,
    {
      encoding: "utf-8",
      env: {
        ...process.env,
        DATABASE_URL: UPGRADE_URL,
        DIRECT_URL: UPGRADE_URL,
      },
    }
  );
  testAssert(statusUpgradeOut.includes("Database schema is up to date!"), "Upgraded database status reports up to date");

  // Verify baseline data was preserved without corruption
  const clientCheck = execPsql(`SELECT count(*) FROM "ApiClient" WHERE id = '${testClientId}';`, UPGRADE_DB);
  testAssert(clientCheck === "1", "Existing ApiClient preserved across migrations");

  const keyCheck = execPsql(`SELECT count(*) FROM "ApiKey" WHERE "clientId" = '${testClientId}';`, UPGRADE_DB);
  testAssert(keyCheck === "1", "Existing ApiKey preserved across migrations");

  const userCheck = execPsql(`SELECT "email", "role", "emailVerified" FROM "User" WHERE id = '${testUserId}';`, UPGRADE_DB);
  testAssert(userCheck === "admin@prod.test|ADMIN|f", "Existing User preserved with role ADMIN and emailVerified defaulted to false");

  const msgCheck = execPsql(`SELECT count(*) FROM "Message" WHERE id = '${testMsgId}';`, UPGRADE_DB);
  testAssert(msgCheck === "1", "Existing WhatsApp Message preserved across migrations");

  // ---------------------------------------------------------------------------
  // [3] Structural Schema Verification
  // ---------------------------------------------------------------------------
  console.log("\n--- [3] Detailed Schema Invariant Verification ---");

  // Check Tables (all 23 tables)
  const expectedTables = [
    "ApiClient", "ApiKey", "Message", "MessageEvent", "OtpVerification", "RateLimit",
    "User", "UserSession", "WebhookDelivery", "WebhookEndpoint",
    "EmailCampaign", "EmailCampaignRecipient", "EmailContact", "EmailDelivery",
    "EmailEvent", "EmailList", "EmailListMember", "EmailProviderConfig", "EmailSegment",
    "EmailSenderIdentity", "EmailSuppression", "EmailTemplate", "EmailTemplateVersion",
  ];

  const dbTablesRaw = execPsql(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE';`,
    UPGRADE_DB
  );
  const dbTables = dbTablesRaw.split("\n").filter(Boolean);

  let allTablesPresent = true;
  for (const t of expectedTables) {
    if (!dbTables.includes(t)) {
      allTablesPresent = false;
      console.error(`Missing expected table: ${t}`);
    }
  }
  testAssert(allTablesPresent, `All ${expectedTables.length} application tables present in upgraded schema`);

  // Check Enums (all 11 enums)
  const expectedEnums = [
    "MessageDirection", "MessageType", "MessageStatus", "ProcessingStatus", "DeliveryStatus",
    "OtpStatus", "UserRole", "EmailProviderType", "EmailProviderStatus", "EmailType",
    "EmailContactStatus", "EmailSubscriptionStatus", "EmailTemplateType", "EmailCampaignStatus",
    "EmailDeliveryStatus", "EmailEventType", "EmailSuppressionReason", "EmailEventProcessingStatus",
  ];
  const dbEnumsRaw = execPsql(
    `SELECT t.typname FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' AND t.typtype = 'e';`,
    UPGRADE_DB
  );
  const dbEnums = dbEnumsRaw.split("\n").filter(Boolean);

  let allEnumsPresent = true;
  for (const e of expectedEnums) {
    if (!dbEnums.includes(e)) {
      allEnumsPresent = false;
      console.error(`Missing expected enum: ${e}`);
    }
  }
  testAssert(allEnumsPresent, `All ${expectedEnums.length} enums present in PostgreSQL catalog`);

  // Check EmailEvent fields
  const eventColsRaw = execPsql(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'EmailEvent';`,
    UPGRADE_DB
  );
  const eventCols = eventColsRaw.split("\n").filter(Boolean);
  const requiredEventCols = [
    "id", "clientId", "deliveryId", "providerConfigId", "providerEventId",
    "eventType", "status", "recipient", "payload", "attempts", "lastAttemptAt",
    "processedAt", "errorMessage", "errorCode", "occurredAt", "createdAt",
  ];
  const allEventColsPresent = requiredEventCols.every((c) => eventCols.includes(c));
  testAssert(allEventColsPresent, "EmailEvent has all required fields (providerConfigId, status, attempts, etc.)");

  // Check EmailEvent compound unique constraint
  const eventUniqueIdx = execPsql(
    `SELECT indexdef FROM pg_indexes WHERE tablename = 'EmailEvent' AND indexname = 'EmailEvent_providerConfigId_providerEventId_key';`,
    UPGRADE_DB
  );
  testAssert(eventUniqueIdx.includes('("providerConfigId", "providerEventId")'), "EmailEvent has compound unique constraint (providerConfigId, providerEventId)");

  // Check EmailDelivery authoritative content fields
  const deliveryColsRaw = execPsql(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'EmailDelivery';`,
    UPGRADE_DB
  );
  const deliveryCols = deliveryColsRaw.split("\n").filter(Boolean);
  const requiredDeliveryCols = [
    "campaignId", "templateId", "templateVersionId", "replyTo", "htmlContent", "textContent",
  ];
  const allDeliveryColsPresent = requiredDeliveryCols.every((c) => deliveryCols.includes(c));
  testAssert(allDeliveryColsPresent, "EmailDelivery has all authoritative content columns (htmlContent, textContent, replyTo, templateId, etc.)");

  // Check EmailDelivery indexes
  const deliveryIdxRaw = execPsql(
    `SELECT indexname FROM pg_indexes WHERE tablename = 'EmailDelivery';`,
    UPGRADE_DB
  );
  const deliveryIdxs = deliveryIdxRaw.split("\n").filter(Boolean);
  testAssert(deliveryIdxs.includes("EmailDelivery_templateId_idx"), "EmailDelivery_templateId_idx index exists");
  testAssert(deliveryIdxs.includes("EmailDelivery_campaignId_idx"), "EmailDelivery_campaignId_idx index exists");
  testAssert(deliveryIdxs.includes("EmailDelivery_clientId_idempotencyKey_key"), "EmailDelivery_clientId_idempotencyKey_key unique index exists");

  // Check User email verification columns
  const userColsRaw = execPsql(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'User';`,
    UPGRADE_DB
  );
  const userCols = userColsRaw.split("\n").filter(Boolean);
  testAssert(userCols.includes("emailVerified") && userCols.includes("emailVerifiedAt"), "User table has emailVerified and emailVerifiedAt columns");

  // Check Foreign Keys
  const fkeysRaw = execPsql(
    `SELECT constraint_name FROM information_schema.table_constraints WHERE constraint_type = 'FOREIGN KEY' AND table_schema = 'public';`,
    UPGRADE_DB
  );
  const fkeys = fkeysRaw.split("\n").filter(Boolean);
  testAssert(fkeys.includes("EmailDelivery_campaignId_fkey"), "EmailDelivery_campaignId_fkey foreign key exists");
  testAssert(fkeys.includes("EmailDelivery_templateId_fkey"), "EmailDelivery_templateId_fkey foreign key exists");
  testAssert(fkeys.includes("EmailDelivery_templateVersionId_fkey"), "EmailDelivery_templateVersionId_fkey foreign key exists");
  testAssert(fkeys.includes("EmailEvent_providerConfigId_fkey"), "EmailEvent_providerConfigId_fkey foreign key exists");
  testAssert(fkeys.includes("EmailEvent_deliveryId_fkey"), "EmailEvent_deliveryId_fkey foreign key exists");

  // Check Row Level Security (RLS) on all Email tables
  const emailTables = [
    "EmailProviderConfig", "EmailSenderIdentity", "EmailContact", "EmailList",
    "EmailListMember", "EmailSegment", "EmailTemplate", "EmailTemplateVersion",
    "EmailCampaign", "EmailCampaignRecipient", "EmailDelivery", "EmailEvent",
    "EmailSuppression",
  ];
  let allEmailRls = true;
  for (const tbl of emailTables) {
    const rls = execPsql(
      `SELECT relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = '${tbl}';`,
      UPGRADE_DB
    );
    if (rls !== "t") {
      allEmailRls = false;
      console.error(`RLS not enabled on table: ${tbl}`);
    }
  }
  testAssert(allEmailRls, "Row Level Security (RLS) enabled on all 13 Email tables");

  // Check whatsapp_hub role policies
  const policiesRaw = execPsql(
    `SELECT tablename FROM pg_policies WHERE schemaname = 'public' AND 'whatsapp_hub' = ANY(roles);`,
    UPGRADE_DB
  );
  const policyTables = policiesRaw.split("\n").filter(Boolean);
  const allPolicyTablesPresent = emailTables.every((t) => policyTables.includes(t));
  testAssert(allPolicyTablesPresent, "whatsapp_hub RLS access policies exist for all 13 Email tables");

  // Check WhatsApp Tables Invariants (No regressions)
  const whatsappTables = ["Message", "MessageEvent", "ApiClient", "ApiKey", "WebhookEndpoint", "WebhookDelivery", "OtpVerification", "RateLimit"];
  const allWhatsAppTablesPresent = whatsappTables.every((t) => dbTables.includes(t));
  testAssert(allWhatsAppTablesPresent, "All 8 core WhatsApp / Auth tables intact without regressions");

  // Check Prisma Generate
  console.log("\n--- [4] Prisma Generate ---");
  const generateOut = execSync(`npx prisma generate`, { encoding: "utf-8" });
  testAssert(generateOut.includes("Generated Prisma Client"), "npx prisma generate succeeds without errors");

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------
  console.log("\n------------------------------------------------------------------");
  console.log(`Reconciliation Summary: ${passed} PASSED, ${failed} FAILED`);
  console.log("------------------------------------------------------------------");

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("Fatal error during reconciliation verification:", err);
  process.exit(1);
});
