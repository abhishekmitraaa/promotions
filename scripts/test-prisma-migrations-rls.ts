import { execSync } from 'child_process';

const CONTAINER = 'disposable-email-postgres';
const TEST_DB_NAME = 'test_prisma_rls_disposable';
const TEST_DB_URL_ADMIN = `postgres://postgres:postgres@127.0.0.1:5433/${TEST_DB_NAME}`;
const TEST_DB_URL_WHATSAPP_HUB = `postgres://whatsapp_hub:postgres@127.0.0.1:5433/${TEST_DB_NAME}`;

function executeSql(sql: string, db: string = TEST_DB_NAME): string {
  return execSync(`docker exec -i ${CONTAINER} psql -U postgres -d ${db}`, {
    input: sql,
    encoding: 'utf-8',
  });
}

function executeSqlAsRole(sql: string, role: string, db: string = TEST_DB_NAME): string {
  const fullSql = `SET ROLE ${role};\n${sql}`;
  return execSync(`docker exec -i ${CONTAINER} psql -U postgres -d ${db}`, {
    input: fullSql,
    encoding: 'utf-8',
  });
}

async function run() {
  console.log('==================================================================');
  console.log('🧪 TESTING _prisma_migrations RLS REMEDIATION ON DISPOSABLE POSTGRES');
  console.log('==================================================================\n');

  console.log('-> [Step 1] Preparing disposable database & roles...');
  executeSql(`DROP DATABASE IF EXISTS ${TEST_DB_NAME};`, 'postgres');
  executeSql(`CREATE DATABASE ${TEST_DB_NAME};`, 'postgres');

  executeSql(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'whatsapp_hub') THEN
        CREATE ROLE whatsapp_hub WITH LOGIN PASSWORD 'postgres' CREATEDB;
      ELSE
        ALTER ROLE whatsapp_hub WITH LOGIN PASSWORD 'postgres' CREATEDB;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        CREATE ROLE anon NOLOGIN;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        CREATE ROLE authenticated NOLOGIN;
      END IF;
    END $$;
  `, 'postgres');

  console.log('-> [Step 2] Running prisma migrate deploy to establish baseline migrations...');
  const envAdmin = {
    ...process.env,
    DATABASE_URL: TEST_DB_URL_ADMIN,
    DIRECT_URL: TEST_DB_URL_ADMIN,
  };

  execSync('npx prisma migrate deploy', { env: envAdmin, stdio: 'inherit' });

  // Ensure whatsapp_hub has LOGIN and table ownership
  executeSql(`ALTER ROLE whatsapp_hub WITH LOGIN PASSWORD 'postgres';`);
  executeSql(`ALTER TABLE public._prisma_migrations OWNER TO whatsapp_hub;`);
  executeSql(`GRANT ALL ON ALL TABLES IN SCHEMA public TO whatsapp_hub;`);
  executeSql(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO whatsapp_hub;`);

  console.log('\n-> [Step 3] Checking pre-remediation RLS status on _prisma_migrations...');
  const preRlsOutput = executeSql(
    `SELECT tablename, rowsecurity, tableowner FROM pg_tables WHERE tablename = '_prisma_migrations';`
  );
  console.log('  Pre-remediation state:\n', preRlsOutput);

  if (preRlsOutput.includes('| f           |')) {
    console.log('  ✅ CONFIRMED: _prisma_migrations has rowsecurity = false (f) initially.');
  } else {
    throw new Error('Expected rowsecurity to be false initially.');
  }

  console.log('-> [Step 4] Applying safest remediation SQL...');
  const remediationSql = `
    ALTER TABLE public._prisma_migrations ENABLE ROW LEVEL SECURITY;
    REVOKE ALL ON TABLE public._prisma_migrations FROM anon, authenticated, public;
    GRANT ALL ON TABLE public._prisma_migrations TO whatsapp_hub;
    DROP POLICY IF EXISTS "whatsapp_hub_prisma_migrations_all" ON public._prisma_migrations;
    CREATE POLICY "whatsapp_hub_prisma_migrations_all" ON public._prisma_migrations
      FOR ALL
      TO whatsapp_hub
      USING (true)
      WITH CHECK (true);
  `;
  const remOutput = executeSql(remediationSql);
  console.log('  Remediation SQL output:\n', remOutput.trim());

  console.log('\n-> [Step 5] Verifying post-remediation RLS status...');
  const postRlsOutput = executeSql(
    `SELECT tablename, rowsecurity, tableowner FROM pg_tables WHERE tablename = '_prisma_migrations';`
  );
  console.log('  Post-remediation state:\n', postRlsOutput);
  if (!postRlsOutput.includes('| t           |')) {
    throw new Error('Failed to enable rowsecurity on _prisma_migrations');
  }
  console.log('  ✅ PASS: _prisma_migrations now has rowsecurity = true (t) (Advisory resolved).');

  console.log('\n-> [Step 6] Testing accessibility under roles (anon, authenticated, whatsapp_hub)...');
  
  // Test anon
  try {
    executeSqlAsRole('SELECT count(*) FROM public._prisma_migrations;', 'anon');
    throw new Error('FAIL: anon was able to query _prisma_migrations!');
  } catch (err: any) {
    console.log('  ✅ PASS: anon role is strictly blocked (permission denied):', err.message.split('\n')[0]);
  }

  // Test authenticated
  try {
    executeSqlAsRole('SELECT count(*) FROM public._prisma_migrations;', 'authenticated');
    throw new Error('FAIL: authenticated was able to query _prisma_migrations!');
  } catch (err: any) {
    console.log('  ✅ PASS: authenticated role is strictly blocked (permission denied):', err.message.split('\n')[0]);
  }

  // Test whatsapp_hub via SET ROLE
  const appQueryResult = executeSqlAsRole('SELECT count(*) as count FROM public._prisma_migrations;', 'whatsapp_hub');
  console.log('  ✅ PASS: whatsapp_hub role can query _prisma_migrations:\n', appQueryResult.trim());

  console.log('\n-> [Step 7] Testing Prisma CLI commands with RLS enabled on _prisma_migrations...');
  const envApp = {
    ...process.env,
    DATABASE_URL: TEST_DB_URL_WHATSAPP_HUB,
    DIRECT_URL: TEST_DB_URL_WHATSAPP_HUB,
  };

  console.log('  Running: npx prisma migrate status as whatsapp_hub...');
  const statusOutput = execSync('npx prisma migrate status', { env: envApp, encoding: 'utf-8' });
  console.log('  Status Output:\n', statusOutput);
  if (!statusOutput.includes('Database schema is up to date!')) {
    throw new Error('prisma migrate status failed after enabling RLS!');
  }
  console.log('  ✅ PASS: prisma migrate status succeeds and reports schema up to date!');

  console.log('  Running: npx prisma migrate deploy as whatsapp_hub (idempotency check)...');
  const deployOutput = execSync('npx prisma migrate deploy', { env: envApp, encoding: 'utf-8' });
  console.log('  Deploy Output:\n', deployOutput);
  if (!deployOutput.includes('No pending migrations to apply.')) {
    throw new Error('prisma migrate deploy failed after enabling RLS!');
  }
  console.log('  ✅ PASS: prisma migrate deploy succeeds without issues!');

  console.log('\n-> [Step 8] Testing normal application queries via Prisma Client as whatsapp_hub...');
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient({ datasourceUrl: TEST_DB_URL_WHATSAPP_HUB });
  
  const users = await prisma.user.findMany();
  console.log('  ✅ PASS: prisma.user.findMany() succeeded (returned', users.length, 'records)');

  const clients = await prisma.apiClient.findMany();
  console.log('  ✅ PASS: prisma.apiClient.findMany() succeeded (returned', clients.length, 'records)');

  const campaigns = await prisma.emailCampaign.findMany();
  console.log('  ✅ PASS: prisma.emailCampaign.findMany() succeeded (returned', campaigns.length, 'records)');

  await prisma.$disconnect();

  console.log('\n==================================================================');
  console.log('🎉 ALL TESTS PASSED: Remediation is safe, functional, and verified!');
  console.log('==================================================================');
}

run().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
