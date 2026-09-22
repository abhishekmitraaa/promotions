import assert from "node:assert/strict";
import {
  evaluateDestructiveTestAllowed,
  assertDestructiveTestAllowed,
  PRODUCTION_SUPABASE_PROJECT_REF,
} from "./test-db-guard";

async function runGuardTests() {
  console.log("==================================================================");
  console.log("🛡️  RUNNING DESTRUCTIVE TEST SAFETY GUARD VERIFICATION");
  console.log("==================================================================\n");

  let passed = 0;
  let failed = 0;

  function testCase(name: string, fn: () => void) {
    try {
      fn();
      console.log(`  ✅ [PASS] ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ❌ [FAIL] ${name}:`, err);
      failed++;
    }
  }

  const PROD_POOLED_URL =
    "postgresql://whatsapp_hub.peqynzeioiauynfpdsdv:SecretPassword123@aws-0-ap-south-1.pooler.supabase.com:6543/postgres?pgbouncer=true";
  const PROD_DIRECT_URL =
    "postgresql://whatsapp_hub.peqynzeioiauynfpdsdv:SecretPassword123@aws-0-ap-south-1.pooler.supabase.com:5432/postgres";
  const PROD_HOST_URL =
    "postgresql://postgres:SecretPassword123@db.peqynzeioiauynfpdsdv.supabase.co:5432/postgres";
  const LOCAL_PG_URL =
    "postgresql://postgres:postgres@localhost:5432/whatsapp_hub_test";
  const LOCAL_127_URL =
    "postgresql://postgres:postgres@127.0.0.1:5432/whatsapp_hub_test";
  const LOCAL_IPV6_URL =
    "postgresql://postgres:postgres@[::1]:5432/whatsapp_hub_test";
  const DOCKER_HOST_URL =
    "postgresql://postgres:postgres@host.docker.internal:5432/whatsapp_hub_test";
  const CI_POSTGRES_URL =
    "postgresql://postgres:postgres@postgres:5432/whatsapp_hub_test";
  const REMOTE_ARBITRARY_URL =
    "postgresql://myuser:mypassword@db.mycompany-cluster.rds.amazonaws.com:5432/production_data";
  const REMOTE_SUPABASE_OTHER_URL =
    "postgresql://postgres:mypassword@aws-0-us-west-1.pooler.supabase.com:6543/postgres";
  const SQLITE_FILE_URL =
    "file:./dev.db";

  // Case 1: NODE_ENV=production => DENY
  testCase("Case 1: NODE_ENV=production unconditionally rejects destructive tests", () => {
    const res = evaluateDestructiveTestAllowed("test-suite", {
      NODE_ENV: "production",
      DATABASE_URL: LOCAL_PG_URL,
      ALLOW_DESTRUCTIVE_TESTS: "true",
    });
    assert.equal(res.allowed, false);
    assert.equal(res.code, "DENIED_PRODUCTION_NODE_ENV");
    assert.match(res.reason, /NODE_ENV=production/);
  });

  // Case 2: Production Supabase target + no override => DENY
  testCase("Case 2: Production Supabase target with no override is rejected", () => {
    const res = evaluateDestructiveTestAllowed("test-suite", {
      NODE_ENV: "test",
      DATABASE_URL: PROD_POOLED_URL,
    });
    assert.equal(res.allowed, false);
    assert.equal(res.code, "DENIED_PRODUCTION_SUPABASE");
  });

  // Case 3: Production Supabase target + ALLOW_DESTRUCTIVE_TESTS=true => DENY (Critical Regression Test)
  testCase("Case 3: Production Supabase target + ALLOW_DESTRUCTIVE_TESTS=true is STRICTLY REJECTED", () => {
    for (const url of [PROD_POOLED_URL, PROD_DIRECT_URL, PROD_HOST_URL]) {
      const res = evaluateDestructiveTestAllowed("test-suite", {
        NODE_ENV: "test",
        DATABASE_URL: url,
        ALLOW_DESTRUCTIVE_TESTS: "true",
      });
      assert.equal(res.allowed, false);
      assert.equal(res.code, "DENIED_PRODUCTION_SUPABASE");
      assert.match(res.reason, new RegExp(PRODUCTION_SUPABASE_PROJECT_REF));
    }
  });

  // Case 4: Production Supabase target + every available test override => DENY
  testCase("Case 4: Production Supabase target + ALL overrides combined is STILL STRICTLY REJECTED", () => {
    const res = evaluateDestructiveTestAllowed("test-suite", {
      NODE_ENV: "test",
      DATABASE_URL: PROD_POOLED_URL,
      ALLOW_DESTRUCTIVE_TESTS: "true",
      ALLOW_REMOTE_DISPOSABLE_TEST_DB: "true",
      CI: "true",
    });
    assert.equal(res.allowed, false);
    assert.equal(res.code, "DENIED_PRODUCTION_SUPABASE");
  });

  // Case 5: Local disposable Postgres target + valid test configuration => ALLOW
  testCase("Case 5: Local disposable Postgres target (localhost, 127.0.0.1, ::1, host.docker.internal) + ALLOW_DESTRUCTIVE_TESTS=true => ALLOW", () => {
    for (const url of [LOCAL_PG_URL, LOCAL_127_URL, LOCAL_IPV6_URL, DOCKER_HOST_URL]) {
      const res = evaluateDestructiveTestAllowed("test-suite", {
        NODE_ENV: "test",
        DATABASE_URL: url,
        ALLOW_DESTRUCTIVE_TESTS: "true",
      });
      assert.equal(res.allowed, true);
      assert.equal(res.code, "ALLOWED_LOCAL_DISPOSABLE");
    }
  });

  // Case 6: CI disposable Postgres target + valid CI configuration => ALLOW
  testCase("Case 6: CI disposable Postgres target (localhost or docker postgres service in CI) => ALLOW", () => {
    const resLocalhost = evaluateDestructiveTestAllowed("test-suite", {
      NODE_ENV: "test",
      CI: "true",
      DATABASE_URL: LOCAL_PG_URL,
      ALLOW_DESTRUCTIVE_TESTS: "true",
    });
    assert.equal(resLocalhost.allowed, true);

    const resDockerService = evaluateDestructiveTestAllowed("test-suite", {
      NODE_ENV: "test",
      CI: "true",
      DATABASE_URL: CI_POSTGRES_URL,
      ALLOW_DESTRUCTIVE_TESTS: "true",
    });
    assert.equal(resDockerService.allowed, true);
    assert.equal(resDockerService.code, "ALLOWED_CI_DISPOSABLE");
  });

  // Case 7: Arbitrary remote database + ALLOW_DESTRUCTIVE_TESTS=true => DENY (Deny by default)
  testCase("Case 7: Arbitrary remote database + ALLOW_DESTRUCTIVE_TESTS=true alone is DENIED", () => {
    const res = evaluateDestructiveTestAllowed("test-suite", {
      NODE_ENV: "test",
      DATABASE_URL: REMOTE_ARBITRARY_URL,
      ALLOW_DESTRUCTIVE_TESTS: "true",
    });
    assert.equal(res.allowed, false);
    assert.equal(res.code, "DENIED_REMOTE_NOT_DISPOSABLE");
  });

  // Case 8: Malformed or unrecognized database target => DENY
  testCase("Case 8: Malformed or unrecognized database URL is DENIED", () => {
    const resMalformed = evaluateDestructiveTestAllowed("test-suite", {
      NODE_ENV: "test",
      DATABASE_URL: "not a valid url :// invalid",
      ALLOW_DESTRUCTIVE_TESTS: "true",
    });
    assert.equal(resMalformed.allowed, false);
    assert.equal(resMalformed.code, "DENIED_MALFORMED_URL");

    const resBadProtocol = evaluateDestructiveTestAllowed("test-suite", {
      NODE_ENV: "test",
      DATABASE_URL: "mysql://user:pass@localhost:3306/db",
      ALLOW_DESTRUCTIVE_TESTS: "true",
    });
    assert.equal(resBadProtocol.allowed, false);
    assert.equal(resBadProtocol.code, "DENIED_UNKNOWN_TARGET");
  });

  // Case 9: Missing DATABASE_URL => DENY with useful error
  testCase("Case 9: Missing DATABASE_URL is DENIED with useful error", () => {
    const res = evaluateDestructiveTestAllowed("test-suite", {
      NODE_ENV: "test",
      DATABASE_URL: "",
      DIRECT_URL: "",
      ALLOW_DESTRUCTIVE_TESTS: "true",
    });
    assert.equal(res.allowed, false);
    assert.equal(res.code, "DENIED_MISSING_DATABASE_URL");
    assert.match(res.reason, /DATABASE_URL is not set/);
  });

  // Case 10: Production-like Supabase hostname without disposable confirmation => DENY
  testCase("Case 10: Non-prod Supabase hostname + ALLOW_DESTRUCTIVE_TESTS=true without disposable confirmation is DENIED", () => {
    const res = evaluateDestructiveTestAllowed("test-suite", {
      NODE_ENV: "test",
      DATABASE_URL: REMOTE_SUPABASE_OTHER_URL,
      ALLOW_DESTRUCTIVE_TESTS: "true",
    });
    assert.equal(res.allowed, false);
    assert.equal(res.code, "DENIED_REMOTE_NOT_DISPOSABLE");
  });

  // Case 11: Local database without explicit ALLOW_DESTRUCTIVE_TESTS opt-in => DENY
  testCase("Case 11: Local database without ALLOW_DESTRUCTIVE_TESTS=true is DENIED (opt-in required)", () => {
    const res = evaluateDestructiveTestAllowed("test-suite", {
      NODE_ENV: "test",
      DATABASE_URL: LOCAL_PG_URL,
    });
    assert.equal(res.allowed, false);
    assert.equal(res.code, "DENIED_LOCAL_MISSING_OPT_IN");
  });

  // Case 12: SQLite file database + ALLOW_DESTRUCTIVE_TESTS=true => ALLOW
  testCase("Case 12: SQLite file database + ALLOW_DESTRUCTIVE_TESTS=true => ALLOW", () => {
    const res = evaluateDestructiveTestAllowed("test-suite", {
      NODE_ENV: "test",
      DATABASE_URL: SQLITE_FILE_URL,
      ALLOW_DESTRUCTIVE_TESTS: "true",
    });
    assert.equal(res.allowed, true);
    assert.equal(res.code, "ALLOWED_SQLITE_FILE");
  });

  // Case 13: SQLite file database without ALLOW_DESTRUCTIVE_TESTS=true => DENY
  testCase("Case 13: SQLite file database without opt-in => DENY", () => {
    const res = evaluateDestructiveTestAllowed("test-suite", {
      NODE_ENV: "test",
      DATABASE_URL: SQLITE_FILE_URL,
    });
    assert.equal(res.allowed, false);
    assert.equal(res.code, "DENIED_LOCAL_MISSING_OPT_IN");
  });

  // Case 14: Confirmed remote disposable DB => ALLOW
  testCase("Case 14: Confirmed remote disposable DB (ALLOW_REMOTE_DISPOSABLE_TEST_DB=true AND ALLOW_DESTRUCTIVE_TESTS=true) => ALLOW", () => {
    const res = evaluateDestructiveTestAllowed("test-suite", {
      NODE_ENV: "test",
      DATABASE_URL: REMOTE_SUPABASE_OTHER_URL,
      ALLOW_DESTRUCTIVE_TESTS: "true",
      ALLOW_REMOTE_DISPOSABLE_TEST_DB: "true",
    });
    assert.equal(res.allowed, true);
    assert.equal(res.code, "ALLOWED_REMOTE_DISPOSABLE");
  });

  // Case 15: Secret leak prevention test
  testCase("Case 15: Reason text NEVER exposes passwords, tokens, or raw connection strings", () => {
    const res = evaluateDestructiveTestAllowed("test-suite", {
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://myuser:SuperSecretPassword999@remote-db.example.com:5432/my_db",
      ALLOW_DESTRUCTIVE_TESTS: "true",
    });
    assert.equal(res.allowed, false);
    assert.equal(res.reason.includes("SuperSecretPassword999"), false);
    assert.equal(res.reason.includes("myuser:"), false);
    assert.equal(res.reason.includes("postgresql://"), false);
    assert.ok(res.reason.includes("remote-db.example.com"));
  });

  // Case 16: assertDestructiveTestAllowed throws Error with clean message
  testCase("Case 16: assertDestructiveTestAllowed throws Error when denied", () => {
    assert.throws(
      () => {
        // Temporarily mutate process.env to test assertDestructiveTestAllowed wrapper
        const orig = process.env.NODE_ENV;
        try {
          process.env.NODE_ENV = "production";
          assertDestructiveTestAllowed("assert-test");
        } finally {
          process.env.NODE_ENV = orig;
        }
      },
      (err: Error) => {
        return err.message.includes("SAFETY GATE TRIGGERED") && err.message.includes("NODE_ENV=production");
      }
    );
  });

  console.log("\n------------------------------------------------------------------");
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log("------------------------------------------------------------------\n");

  if (failed > 0) {
    throw new Error(`Guard test suite failed with ${failed} failure(s)`);
  }
}

runGuardTests().catch((err) => {
  console.error("❌ Guard tests failed:", err);
  process.exit(1);
});
