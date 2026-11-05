/**
 * READ-ONLY audit of the live Supabase project.
 *
 *   npx tsx scripts/audit-supabase.ts
 *
 * Hard rules:
 *  - SELECT / information_schema / pg_catalog ONLY. No DDL, no DML, no GRANT.
 *  - The connection string and both API keys are read from process.env and are
 *    NEVER printed. Only host, port, database and query results appear.
 *  - This script is the evidence source for docs/task-summaries/TASK-002.md.
 *
 * It answers, from real data rather than assumption:
 *   which tables exist · who owns them · RLS state · grants to anon/authenticated
 *   · the migration ledger · whether any ctl_* table is present · whether
 *   ReplyMate end-user content is reachable · auth configuration signals.
 */
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });

type Row = Record<string, unknown>;

function section(title: string) {
  console.log(`\n${"=".repeat(72)}\n${title}\n${"=".repeat(72)}`);
}

function table(rows: Row[], columns: string[]) {
  if (rows.length === 0) {
    console.log("  (no rows)");
    return;
  }
  const widths = columns.map((c) =>
    Math.min(46, Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length))),
  );
  console.log(`  ${columns.map((c, i) => c.padEnd(widths[i])).join(" | ")}`);
  console.log(`  ${widths.map((w) => "-".repeat(w)).join("-+-")}`);
  for (const row of rows) {
    console.log(`  ${columns.map((c, i) => String(row[c] ?? "").slice(0, widths[i]).padEnd(widths[i])).join(" | ")}`);
  }
  console.log(`  (${rows.length} row${rows.length === 1 ? "" : "s"})`);
}

async function main() {
  const poolerUrl = process.env.SUPABASE_TRANSACTION_POOLER;
  const projectUrl = process.env.SUPABASE_PROJECT_URL;
  const publishable = process.env.SUPABASE_PUBLISHABLE_KEY;
  const secret = process.env.SUPABASE_SECRET_KEY;

  if (!poolerUrl || !projectUrl) {
    throw new Error("SUPABASE_TRANSACTION_POOLER and SUPABASE_PROJECT_URL are required.");
  }

  const parsed = new URL(projectUrl);
  console.log(`Target project : ${parsed.host}`);
  console.log(`Pooler host    : ${new URL(poolerUrl).host}:${new URL(poolerUrl).port}`);
  console.log(`Pooler database: ${new URL(poolerUrl).pathname.slice(1)}`);
  console.log(`Keys present   : publishable=${Boolean(publishable)} secret=${Boolean(secret)}`);
  console.log("Mode           : READ ONLY (SELECT / catalogs only)");

  const { default: pg } = await import("pg");
  const client = new pg.Client({
    connectionString: poolerUrl,
    ssl: { rejectUnauthorized: false },
    statement_timeout: 20_000,
    connectionTimeoutMillis: 20_000,
  });
  await client.connect();

  const q = async (sql: string, params: unknown[] = []): Promise<Row[]> => {
    const result = await client.query(sql, params);
    return result.rows as Row[];
  };

  try {
    section("1. Server identity and version");
    table(
      await q(`select version() as version, current_database() as database,
                      current_user as role, inet_server_port() as port`),
      ["database", "role", "port"],
    );
    console.log(`  ${(await q("select version() as v"))[0]?.v}`);

    section("2. All tables in public, with RLS state and row counts");
    const tables = await q(`
      select c.relname as table_name,
             c.relrowsecurity as rls_enabled,
             c.relforcerowsecurity as rls_forced,
             pg_catalog.pg_get_userbyid(c.relowner) as owner,
             (select reltuples::bigint from pg_class where oid = c.oid) as approx_rows
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
      order by c.relname`);
    table(tables, ["table_name", "rls_enabled", "rls_forced", "owner", "approx_rows"]);

    section("3. Are any control-plane (ctl_*) tables present in this project?");
    const ctl = tables.filter((t) => String(t.table_name).startsWith("ctl_"));
    if (ctl.length === 0) {
      console.log("  NONE. The control plane is NOT deployed to this project.");
      console.log("  This is the ReplyMate app data plane only.");
    } else {
      table(ctl, ["table_name", "rls_enabled", "owner"]);
    }

    section("4. Are ReplyMate app content tables present?");
    const appTables = [
      "message", "memory_fact", "contact", "contact_summary", "contact_channel",
      "draft", "style_profile", "app_kv", "provider_def", "usage_event",
    ];
    const present = tables.filter((t) => appTables.includes(String(t.table_name)));
    table(present, ["table_name", "rls_enabled", "approx_rows"]);
    const missing = appTables.filter((t) => !present.some((p) => p.table_name === t));
    if (missing.length > 0) console.log(`  Missing app tables: ${missing.join(", ")}`);

    section("5. Migration ledger (public.rm_schema_migrations)");
    const ledgerExists = present.length > 0 || tables.some((t) => t.table_name === "rm_schema_migrations");
    if (tables.some((t) => t.table_name === "rm_schema_migrations")) {
      table(await q("select version, label, applied_at from public.rm_schema_migrations order by version"), [
        "version", "label", "applied_at",
      ]);
    } else {
      console.log("  rm_schema_migrations NOT present.");
    }
    void ledgerExists;

    section("6. Official CLI migration history (supabase_migrations.schema_migrations)");
    const cli = await q(`select version, name from supabase_migrations.schema_migrations order by version`).catch(
      () => [] as Row[],
    );
    if (cli.length === 0) {
      console.log("  ABSENT or unreadable — consistent with ReplyMate's documented approach:");
      console.log("  migrations were applied via psql over the pooler, never `supabase db push`.");
    } else {
      table(cli, ["version", "name"]);
    }

    section("7. RLS policies (names, commands, roles — not definitions)");
    table(
      await q(`select schemaname, tablename, policyname, cmd, roles::text as roles
               from pg_policies where schemaname='public' order by tablename, policyname`),
      ["tablename", "policyname", "cmd", "roles"],
    );

    section("8. Grants to anon / authenticated / service_role");
    table(
      await q(`select table_name, grantee, string_agg(privilege_type, ',' order by privilege_type) as privileges
               from information_schema.role_table_grants
               where table_schema='public' and grantee in ('anon','authenticated','service_role')
               group by table_name, grantee order by table_name, grantee`),
      ["table_name", "grantee", "privileges"],
    );

    section("9. Roles present");
    table(
      await q(`select rolname, rolsuper, rolcanlogin, rolcreatedb, rolcreaterole
               from pg_roles where rolname not like 'pg\\_%' order by rolname`),
      ["rolname", "rolsuper", "rolcanlogin", "rolcreatedb", "rolcreaterole"],
    );

    section("10. Extensions installed");
    table(await q("select extname, extversion from pg_extension order by extname"), ["extname", "extversion"]);

    section("11. Database size and table sizes (quota evidence)");
    table(
      await q(`select pg_size_pretty(pg_database_size(current_database())) as database_size`),
      ["database_size"],
    );
    table(
      await q(`select t.relname as table_name,
                      pg_size_pretty(pg_total_relation_size(c.oid)) as total_size,
                      t.n_live_tup as live_rows
               from pg_stat_user_tables t join pg_class c on c.oid = t.relid
               order by pg_total_relation_size(c.oid) desc limit 15`),
      ["table_name", "total_size", "live_rows"],
    );

    section("12. Storage buckets");
    const buckets = await q("select id, name, public, file_size_limit from storage.buckets order by id").catch(
      () => [] as Row[],
    );
    if (buckets.length === 0) console.log("  none, or storage schema not readable with this role");
    else table(buckets, ["id", "name", "public", "file_size_limit"]);

    section("13. Exact row counts for content tables (counts only, no content)");
    for (const t of appTables) {
      if (!present.some((p) => p.table_name === t)) continue;
      const rows = await q(`select count(*)::text as n from public."${t}"`).catch((e: Error) => [
        { n: `ERROR ${e.name}` },
      ]);
      console.log(`  ${t.padEnd(18)} ${rows[0]?.n}`);
    }

    section("14. Edge Functions and Realtime configuration (catalog-visible evidence)");
    const realtime = await q(
      `select table_name from information_schema.tables where table_schema='realtime' order by table_name`,
    ).catch(() => [] as Row[]);
    console.log(`  realtime schema tables: ${realtime.length}`);
    if (realtime.length > 0) table(realtime.slice(0, 12), ["table_name"]);
    const functions = await q(
      `select n.nspname as schema, p.proname as function_name
       from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname not in ('pg_catalog','information_schema') order by 1,2 limit 40`,
    );
    table(functions, ["schema", "function_name"]);

    section("15. supabase_functions schema (Edge Function hooks, if exposed)");
    const sf = await q(
      `select table_name from information_schema.tables where table_schema='supabase_functions' order by table_name`,
    ).catch(() => [] as Row[]);
    if (sf.length === 0) console.log("  not readable with this role");
    else table(sf, ["table_name"]);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`\nAUDIT FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
