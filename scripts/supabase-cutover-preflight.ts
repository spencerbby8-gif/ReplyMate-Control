/**
 * Supabase Auth cutover preflight — LIVE, READ-ONLY.
 *
 *   npx tsx scripts/supabase-cutover-preflight.ts
 *
 * Answers one question with evidence: can `AUTH_PROVIDER` be switched from
 * `local` to `supabase` right now, and if not, exactly what must change first?
 *
 * It changes nothing. Two GET requests against Supabase Auth and four COUNT
 * queries against the control-plane database. No setting is altered, no user is
 * created, no invitation is sent, no row is written.
 *
 * Exit code 0 only when the cutover is genuinely ready.
 */
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local", override: true });
loadEnv({ path: ".env", override: true });

const EXPECTED_REF = "xdcsxxwhvpiissetbrdr";

const ICON = { pass: "PASS", fail: "BLOCK", warn: "WARN", unknown: "UNKN" } as const;

async function main() {
  const { gatherCutoverFacts } = await import("../src/lib/supabase/cutover-live");
  const { evaluateCutover } = await import("../src/lib/supabase/cutover");

  console.log(`\nSupabase Auth cutover preflight — expected project ${EXPECTED_REF}`);
  console.log("Read-only: no project setting, user, invitation or row is modified.\n");

  const { facts, notes } = await gatherCutoverFacts(EXPECTED_REF);
  const verdict = evaluateCutover(facts);

  console.log("Facts gathered");
  console.log(`  current AUTH_PROVIDER      ${facts.currentProvider}`);
  console.log(`  project ref                ${facts.projectRef ?? "(unresolved)"}`);
  console.log(`  auth settings readable     ${facts.settingsReadable}`);
  console.log(`  auth users readable        ${facts.authUsersReadable}`);
  console.log(`  control-plane admins       ${facts.adminRows} (${facts.activeAdminRows} active, ${facts.ownerRows} owner)`);
  console.log(`  admins linked to supabase  ${facts.adminRowsWithSupabaseUserId}`);
  console.log(`  encryption key available   ${facts.encryptionKeyAvailable}`);
  console.log("");

  console.log("Checks");
  for (const check of verdict.checks) {
    console.log(`  ${ICON[check.status].padEnd(5)}  ${check.id}`);
    console.log(`         ${check.title}`);
    console.log(`         ${check.detail}`);
    if (check.action) console.log(`         -> ${check.action}`);
  }

  if (notes.length > 0) {
    console.log("\nNotes");
    notes.forEach((note) => console.log(`  - ${note}`));
  }

  console.log("\n" + "=".repeat(64));
  console.log(`VERDICT: ${verdict.summary}`);
  console.log("=".repeat(64));

  if (!verdict.ready) {
    console.log("\nDo NOT set AUTH_PROVIDER=supabase yet. Nothing was changed by this script.");
    process.exit(1);
  }
  console.log("\nCutover is safe to perform. Nothing was changed by this script.");
}

main().catch((error) => {
  console.error(`[cutover-preflight] failed: ${error instanceof Error ? error.name : "unknown"}`);
  process.exit(2);
});
