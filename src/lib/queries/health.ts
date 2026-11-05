import { sql } from "drizzle-orm";
import { db } from "@/db";

/**
 * Control-plane health facts.
 *
 * These are structural checks against THIS database. They never touch the
 * ReplyMate production project — see scripts/apply-hardening.ts for the gate that
 * enforces the same separation at migration time.
 */

/** How many ctl_* tables exist. Zero means the schema was never pushed. */
export async function countControlTables(): Promise<number> {
  const rows = await db.execute<{ count: string }>(
    sql`select count(*)::text as count from information_schema.tables
        where table_schema = 'public' and table_name like 'ctl\_%'`,
  );
  const raw = Array.isArray(rows) ? rows[0] : (rows as unknown as { rows?: Array<{ count: string }> }).rows?.[0];
  return Number(raw?.count ?? 0);
}

/** Whether the audit immutability triggers are installed. */
export async function auditImmutabilityInstalled(): Promise<boolean> {
  const rows = await db.execute<{ count: string }>(
    sql`select count(*)::text as count from pg_trigger
        where not tgisinternal
          and tgrelid = 'public.ctl_audit_log'::regclass
          and tgname in ('ctl_audit_log_no_update', 'ctl_audit_log_no_delete')`,
  );
  const raw = Array.isArray(rows) ? rows[0] : (rows as unknown as { rows?: Array<{ count: string }> }).rows?.[0];
  return Number(raw?.count ?? 0) === 2;
}

/**
 * Whether any ReplyMate app table exists in this database.
 *
 * This must always be false. It is checked at runtime so that a misconfigured
 * DATABASE_URL pointing at the production project surfaces immediately on the
 * dashboard instead of quietly reading someone's messages.
 */
export async function appDataPlanePresent(): Promise<{ present: boolean; tables: string[] }> {
  const rows = await db.execute<{ table_name: string }>(
    sql`select table_name from information_schema.tables
        where table_schema = 'public'
          and table_name in ('message','memory_fact','contact','contact_summary','contact_channel',
                             'draft','style_profile','app_kv','provider_def','usage_event')`,
  );
  const list = Array.isArray(rows)
    ? rows
    : ((rows as unknown as { rows?: Array<{ table_name: string }> }).rows ?? []);
  const tables = list.map((row) => row.table_name);
  return { present: tables.length > 0, tables };
}
