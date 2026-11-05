/**
 * LIVE integration verification against the real Supabase project.
 *
 *   npx tsx scripts/verify-integration.ts
 *
 * This is NOT a vitest suite. Vitest stays offline and deterministic; this script
 * performs real network and database operations and prints a pass/fail line per
 * assertion, so "the live integration works" is evidence rather than a claim.
 *
 * It is strictly READ ONLY. It creates no users, writes no rows, applies no
 * migration, and never prints a credential or an end-user identifier.
 *
 * Exit code 0 only when every assertion passes.
 */
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });

const EXPECTED_PROJECT_REF = "xdcsxxwhvpiissetbrdr";

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title: string) {
  console.log(`\n${title}`);
}

async function main() {
  const { env, supabase, supabaseBridgeConfigured, supabaseProjectRef } = await import("../src/config/env");
  const bridge = await import("../src/lib/supabase/bridge");
  const guard = await import("../src/lib/privacy/guard");
  const identity = await import("../src/lib/auth/identity");

  section("Configuration");
  check("SUPABASE_PROJECT_URL resolves to a URL", Boolean(supabase.url));
  check(
    "project ref is the expected ReplyMate project",
    supabaseProjectRef() === EXPECTED_PROJECT_REF,
    `ref=${supabaseProjectRef()}`,
  );
  check("publishable key present", Boolean(supabase.publishableKey));
  check("secret key present", Boolean(supabase.secretKey));
  check("transaction pooler present", Boolean(supabase.transactionPooler));
  check("bridge reports configured", supabaseBridgeConfigured);
  check(
    "no secret key is declared with a NEXT_PUBLIC_ prefix",
    !Boolean(process.env.NEXT_PUBLIC_SUPABASE_SECRET_KEY ?? process.env.NEXT_PUBLIC_SERVICE_ROLE_KEY),
    "a NEXT_PUBLIC_ secret would ship to browsers",
  );
  check(
    "key format detected",
    supabase.keyFormat === "new-publishable" || supabase.keyFormat === "legacy-jwt",
    `format=${supabase.keyFormat}`,
  );

  section("Reachability");
  const reach = await bridge.probeSupabaseReachable();
  check("project REST root reachable", reach.reachable, `HTTP ${reach.httpStatus} in ${reach.latencyMs}ms`);
  check("latency under 5s", reach.latencyMs < 5000, `${reach.latencyMs}ms`);

  section("Allow-listed reads (real queries)");
  const migrations = await bridge.readSchemaMigrations();
  check("rm_schema_migrations readable", migrations.ok, migrations.ok ? `${migrations.data.length} rows` : migrations.error);
  if (migrations.ok) {
    const versions = migrations.data.map((row) => row.version).sort((a, b) => a - b);
    check(
      "ledger versions are exactly 1..4 as documented in the Android repo",
      JSON.stringify(versions) === JSON.stringify([1, 2, 3, 4]),
      `versions=${versions.join(",")}`,
    );
  }

  const usage = await bridge.readUsageAggregates();
  check("usage_event aggregates readable", usage.ok, usage.ok ? `${usage.data.length} groups` : usage.error);
  if (usage.ok) {
    // The projection must not be able to carry content: only these five keys.
    const allowedKeys = new Set(["model", "kind", "requests", "tokens_in", "tokens_out"]);
    const leaked = usage.data.flatMap((row) => Object.keys(row).filter((k) => !allowedKeys.has(k)));
    check("usage projection carries no unexpected fields", leaked.length === 0, leaked.join(",") || "clean");
  }

  const providers = await bridge.readProviderDistribution();
  check("provider_def distribution readable", providers.ok, providers.ok ? `${providers.data.length} groups` : providers.error);
  if (providers.ok) {
    const allowedKeys = new Set(["type", "model_name", "active", "total"]);
    const leaked = providers.data.flatMap((row) => Object.keys(row).filter((k) => !allowedKeys.has(k)));
    check(
      "provider projection excludes key_ref and every other field",
      leaked.length === 0,
      leaked.join(",") || "clean",
    );
  }

  const count = await bridge.readEndUserCount();
  check("end-user count readable as a scalar", count.ok, count.ok ? `count=${count.data.count}` : count.error);
  if (count.ok) {
    check(
      "the count result exposes only count and truncated — no identities",
      Object.keys(count.data).sort().join(",") === "count,truncated",
      Object.keys(count.data).join(","),
    );
  }

  section("Privacy guard (must fire BEFORE any query is built)");
  for (const table of [
    "message",
    "memory_fact",
    "contact",
    "contact_summary",
    "contact_channel",
    "draft",
    "style_profile",
    "app_kv",
  ]) {
    let threw = false;
    try {
      guard.assertSafeSelect(table, ["id"]);
    } catch (error) {
      threw = guard.isPrivacyViolation(error);
    }
    check(`${table} is denied with PrivacyViolation`, threw);
  }
  let keyRefBlocked = false;
  try {
    guard.assertSafeSelect("provider_def", ["type", "key_ref"]);
  } catch (error) {
    keyRefBlocked = guard.isPrivacyViolation(error);
  }
  check("provider_def.key_ref is excluded", keyRefBlocked);
  let unknownBlocked = false;
  try {
    guard.assertSafeSelect("auth_users", ["id"]);
  } catch (error) {
    unknownBlocked = guard.isPrivacyViolation(error);
  }
  check("an unlisted table is denied by default", unknownBlocked);

  section("Identity strategy");
  const status = identity.identityStatus();
  check("active provider matches AUTH_PROVIDER", status.provider === env.AUTH_PROVIDER, `provider=${status.provider}`);
  const supabaseConfigured = identity.supabaseIdentity.isConfigured();
  check(
    "the supabase strategy reports itself configured from real credentials",
    supabaseConfigured.configured,
    supabaseConfigured.detail,
  );
  // A verification attempt with deliberately wrong credentials must be REFUSED by
  // Supabase, proving the round-trip is real. No user is created or modified.
  const wrong = await identity.supabaseIdentity.verify(
    `control-integration-probe-${Date.now()}@invalid.example`,
    "this-password-is-deliberately-wrong",
  );
  check(
    "supabase strategy completes a real round-trip and rejects bad credentials",
    !wrong.ok && wrong.code === "invalid_credentials",
    wrong.ok ? "UNEXPECTED SUCCESS" : `${wrong.code}`,
  );

  section("Local control-plane database (must be separate from Supabase)");
  const { db } = await import("../src/db");
  const { sql } = await import("drizzle-orm");
  const ctlRows = await db.execute<{ count: string }>(
    sql`select count(*)::text as count from information_schema.tables where table_schema='public' and table_name like 'ctl\_%'`,
  );
  const ctlCount = Number((Array.isArray(ctlRows) ? ctlRows[0] : (ctlRows as never as { rows: Array<{ count: string }> }).rows[0])?.count ?? 0);
  check("control-plane database holds the ctl_* schema", ctlCount >= 15, `${ctlCount} tables`);
  const isSupabaseHost = /supabase\.(co|com)|pooler\.supabase/i.test(env.DATABASE_URL);
  check(
    "DATABASE_URL is NOT the Supabase production project",
    !isSupabaseHost,
    isSupabaseHost ? "REFUSE: control plane would be sharing the production database" : "separate database",
  );
  const health = await import("../src/lib/queries/health");
  const dataPlane = await health.appDataPlanePresent();
  check(
    "no ReplyMate app table exists in the control-plane database",
    !dataPlane.present,
    dataPlane.present ? `FOUND: ${dataPlane.tables.join(",")}` : "clean separation",
  );
  check("audit immutability triggers installed", await health.auditImmutabilityInstalled());

  console.log(`\n${"=".repeat(60)}`);
  console.log(`RESULT: ${passed} passed, ${failed} failed`);
  console.log(`${"=".repeat(60)}`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(`\nVERIFICATION ERROR: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
