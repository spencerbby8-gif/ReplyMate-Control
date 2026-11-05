/**
 * Applies src/db/hardening.sql to the CONTROL-PLANE database.
 *
 *   npx tsx scripts/apply-hardening.ts
 *
 * SAFETY GATE: this script refuses to run against anything that looks like the
 * ReplyMate production Supabase project. The control plane and the app data plane
 * are different databases with different owners, and a hardening script that
 * could reach the wrong one is a production incident waiting to happen.
 *
 * The gate checks, in order:
 *   1. DATABASE_URL must be set.
 *   2. It must NOT be a Supabase host (supabase.co / supabase.com / pooler).
 *   3. It must NOT point at a database that contains ReplyMate app tables
 *      (message, memory_fact, contact, draft, ...).
 *   4. It SHOULD contain ctl_* tables, i.e. `drizzle-kit push` has already run.
 *
 * Nothing here is a migration of the app schema. It creates triggers, revokes
 * PUBLIC privileges and adds indexes on ctl_* tables only.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });

const REPLYMATE_APP_TABLES = [
  "message",
  "memory_fact",
  "contact",
  "contact_summary",
  "contact_channel",
  "draft",
  "style_profile",
  "app_kv",
  "provider_def",
  "usage_event",
];

const SUPABASE_HOST = /(supabase\.(co|com)|pooler\.supabase)/i;

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");

  if (SUPABASE_HOST.test(url)) {
    throw new Error(
      "REFUSED: DATABASE_URL points at a Supabase host. This script only hardens the control-plane " +
        "database. Applying it to the ReplyMate production project requires an owner-approved phase " +
        "and supabase/migrations/0001_control_plane.sql reviewed by hand.",
    );
  }

  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: url });
  await client.connect();

  try {
    // Gate 3: refuse if this database holds ReplyMate app tables.
    const appTables = await client.query<{ table_name: string }>(
      `select table_name from information_schema.tables
        where table_schema = 'public' and table_name = any($1::text[])`,
      [REPLYMATE_APP_TABLES],
    );
    if (appTables.rows.length > 0) {
      throw new Error(
        `REFUSED: this database contains ReplyMate app tables (${appTables.rows
          .map((r) => r.table_name)
          .join(", ")}). That is the production data plane, not the control plane.`,
      );
    }

    // Gate 4: confirm the control plane schema is present.
    const ctlTables = await client.query<{ n: string }>(
      `select count(*)::text as n from information_schema.tables
        where table_schema = 'public' and table_name like 'ctl\\_%'`,
    );
    const count = Number(ctlTables.rows[0]?.n ?? 0);
    if (count === 0) {
      throw new Error(
        "REFUSED: no ctl_* tables found. Run `npx drizzle-kit push` first — hardening applies to an existing control-plane schema.",
      );
    }
    console.log(`[hardening] control-plane database confirmed (${count} ctl_* tables).`);

    const here = dirname(fileURLToPath(import.meta.url));
    const sql = readFileSync(resolve(here, "../src/db/hardening.sql"), "utf8");
    await client.query(sql);
    console.log("[hardening] applied src/db/hardening.sql");

    // Verify the immutability trigger actually fires. A hardening script that
    // does not prove its own effect is just a hopeful one.
    //
    // SUBTLETY, found by this script failing on its own check: these are ROW
    // triggers, so PostgreSQL applies the WHERE predicate first and only fires
    // the trigger for rows that match. `where id = -1` matches nothing, the
    // statement "succeeds" with 0 rows, and the verification reports a false
    // negative while the trigger is in fact working. So we insert a real probe
    // row (INSERT is permitted — the table is append-only, not read-only) and
    // attack that. The row stays behind, correctly labelled as a self-test.
    const probe = await client.query<{ id: string }>(
      `insert into public.ctl_audit_log (action, entity, outcome, detail)
       values ('hardening.selftest', 'audit_immutability', 'success',
               '{"probe":true,"note":"written by scripts/apply-hardening.ts to verify the immutability trigger"}')
       returning id::text as id`,
    );
    const probeId = probe.rows[0].id;

    const updateBlocked = await client
      .query("update public.ctl_audit_log set action = 'tampered' where id = $1", [probeId])
      .then(() => false)
      .catch((error: { code?: string }) => error.code === "42501");
    const deleteBlocked = await client
      .query("delete from public.ctl_audit_log where id = $1", [probeId])
      .then(() => false)
      .catch((error: { code?: string }) => error.code === "42501");

    // Prove the row is genuinely untouched, not merely that an error was raised.
    const intact = await client.query<{ action: string }>(
      "select action from public.ctl_audit_log where id = $1",
      [probeId],
    );
    const unchanged = intact.rows[0]?.action === "hardening.selftest";

    console.log(
      `[hardening] audit immutability: update blocked=${updateBlocked}, delete blocked=${deleteBlocked}, row intact=${unchanged}`,
    );
    if (!updateBlocked || !deleteBlocked || !unchanged) {
      throw new Error(
        `Audit immutability trigger did not behave as expected (update=${updateBlocked}, delete=${deleteBlocked}, intact=${unchanged}).`,
      );
    }

    const triggers = await client.query<{ tgname: string }>(
      `select tgname from pg_trigger where not tgisinternal and tgrelid = 'public.ctl_audit_log'::regclass order by tgname`,
    );
    console.log(`[hardening] triggers on ctl_audit_log: ${triggers.rows.map((t) => t.tgname).join(", ")}`);
    console.log("[hardening] done.");
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`[hardening] failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
