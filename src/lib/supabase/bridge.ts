import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env, supabase, supabaseBridgeConfigured, supabaseProjectRef } from "@/config/env";
import { assertSafeSelect, checkTableAccess, PrivacyViolation } from "@/lib/privacy/guard";

/**
 * Supabase bridge to the ReplyMate cloud foundation.
 *
 * Contract (docs/PRIVACY.md):
 *  - READ ONLY. There is no write path from this platform to the app database.
 *  - Allow-list only. `assertSafeSelect` throws a PrivacyViolation otherwise.
 *  - Aggregate only for anything derived from end-user activity.
 *  - Message sync stays OFF. Nothing here can flip `SYNC_ENABLED`.
 *  - The service-role key lives in `process.env` only; it is never rendered,
 *    logged, or returned by an API route.
 */

export type BridgeStatus = {
  configured: boolean;
  projectUrl: string | null;
  projectRef: string | null;
  keyFormat: string;
  mode: "live" | "unconfigured";
  authProvider: typeof env.AUTH_PROVIDER;
  reason: string;
};

export function bridgeStatus(): BridgeStatus {
  if (!supabaseBridgeConfigured) {
    return {
      configured: false,
      projectUrl: supabase.url,
      projectRef: supabaseProjectRef(),
      keyFormat: supabase.keyFormat,
      mode: "unconfigured",
      authProvider: env.AUTH_PROVIDER,
      reason:
        "SUPABASE_PROJECT_URL, SUPABASE_PUBLISHABLE_KEY and SUPABASE_SECRET_KEY are not all present. The bridge stays closed rather than inventing data.",
    };
  }
  return {
    configured: true,
    projectUrl: supabase.url,
    projectRef: supabaseProjectRef(),
    keyFormat: supabase.keyFormat,
    mode: "live",
    authProvider: env.AUTH_PROVIDER,
    reason:
      "Secret key present. Allow-listed, read-only queries are permitted. The secret key bypasses RLS, so the allow-list in lib/privacy/guard.ts is the only thing standing between this platform and ReplyMate end-user content.",
  };
}

let cached: SupabaseClient | null = null;

export function supabaseAdmin(): SupabaseClient {
  if (!supabaseBridgeConfigured) {
    throw new PrivacyViolation(
      "Supabase bridge is not configured; refusing to construct an admin client.",
    );
  }
  if (!cached) {
    cached = createClient(supabase.url!, supabase.secretKey!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return cached;
}

export type BridgeResult<T> =
  | { ok: true; data: T; source: "supabase"; queriedAt: string }
  | { ok: false; data: null; source: "supabase"; error: string; code: "unconfigured" | "query_failed" };

function unavailable<T>(reason: string): BridgeResult<T> {
  return { ok: false, data: null, source: "supabase", error: reason, code: "unconfigured" };
}

/** Live reachability probe against the project's REST root. No key is sent. */
export async function probeSupabaseReachable(): Promise<{
  reachable: boolean;
  latencyMs: number;
  httpStatus: number | null;
  error: string | null;
}> {
  const url = supabase.url;
  if (!url) return { reachable: false, latencyMs: 0, httpStatus: null, error: "no project url configured" };
  const started = Date.now();
  try {
    const response = await fetch(`${url.replace(/\/$/, "")}/rest/v1/`, {
      method: "GET",
      cache: "no-store",
      signal: AbortSignal.timeout(6000),
    });
    return {
      reachable: response.ok || response.status === 401,
      latencyMs: Date.now() - started,
      httpStatus: response.status,
      error: null,
    };
  } catch (error) {
    return {
      reachable: false,
      latencyMs: Date.now() - started,
      httpStatus: null,
      error: error instanceof Error ? error.name : "unknown",
    };
  }
}

/** Schema ledger — proves which cloud migrations are actually applied. */
export async function readSchemaMigrations(): Promise<
  BridgeResult<Array<{ version: number; label: string | null; applied_at: string | null }>>
> {
  const status = bridgeStatus();
  if (!status.configured) return unavailable(status.reason);
  assertSafeSelect("rm_schema_migrations", ["version", "label", "applied_at"]);
  const { data, error } = await supabaseAdmin()
    .from("rm_schema_migrations")
    .select("version,label,applied_at")
    .order("version", { ascending: true });
  if (error) return { ok: false, data: null, source: "supabase", error: error.message, code: "query_failed" };
  return { ok: true, data: data ?? [], source: "supabase", queriedAt: new Date().toISOString() };
}

/** Aggregate usage telemetry. Counts and sums only — never rows of content. */
export async function readUsageAggregates(): Promise<
  BridgeResult<
    Array<{ model: string; kind: string; requests: number; tokens_in: number; tokens_out: number }>
  >
> {
  const status = bridgeStatus();
  if (!status.configured) return unavailable(status.reason);
  const table = "usage_event";
  const decision = checkTableAccess(table);
  if (!decision.allowed) throw new PrivacyViolation(decision.reason);

  // PostgREST cannot GROUP BY, so we pull the allow-listed non-content columns
  // and aggregate in-process. `body`-shaped columns do not exist on this table.
  const { data, error } = await supabaseAdmin()
    .from(table)
    .select("model,kind,tokens_in,tokens_out")
    .limit(10_000);
  if (error) return { ok: false, data: null, source: "supabase", error: error.message, code: "query_failed" };

  const grouped = new Map<string, { model: string; kind: string; requests: number; tokens_in: number; tokens_out: number }>();
  for (const row of data ?? []) {
    const key = `${row.model ?? "unknown"}|${row.kind ?? "unknown"}`;
    const bucket = grouped.get(key) ?? {
      model: String(row.model ?? "unknown"),
      kind: String(row.kind ?? "unknown"),
      requests: 0,
      tokens_in: 0,
      tokens_out: 0,
    };
    bucket.requests += 1;
    bucket.tokens_in += Number(row.tokens_in ?? 0);
    bucket.tokens_out += Number(row.tokens_out ?? 0);
    grouped.set(key, bucket);
  }
  return {
    ok: true,
    data: [...grouped.values()].sort((a, b) => b.requests - a.requests),
    source: "supabase",
    queriedAt: new Date().toISOString(),
  };
}

/** Provider/model distribution across the app fleet. No key material. */
export async function readProviderDistribution(): Promise<
  BridgeResult<Array<{ type: string; model_name: string; active: number; total: number }>>
> {
  const status = bridgeStatus();
  if (!status.configured) return unavailable(status.reason);
  // key_ref is deliberately absent from this projection.
  assertSafeSelect("provider_def", ["type", "model_name", "is_active"]);
  const { data, error } = await supabaseAdmin()
    .from("provider_def")
    .select("type,model_name,is_active")
    .limit(10_000);
  if (error) return { ok: false, data: null, source: "supabase", error: error.message, code: "query_failed" };

  const grouped = new Map<string, { type: string; model_name: string; active: number; total: number }>();
  for (const row of data ?? []) {
    const type = String(row.type ?? "unknown");
    const model = String(row.model_name ?? "unknown");
    const key = `${type}|${model}`;
    const bucket = grouped.get(key) ?? { type, model_name: model, active: 0, total: 0 };
    bucket.total += 1;
    if (row.is_active) bucket.active += 1;
    grouped.set(key, bucket);
  }
  return {
    ok: true,
    data: [...grouped.values()].sort((a, b) => b.total - a.total),
    source: "supabase",
    queriedAt: new Date().toISOString(),
  };
}

/**
 * Count of authenticated end users. Returns a SCALAR only — no emails, no ids,
 * no metadata leave this function, so nothing end-user-identifying can reach a
 * page or an audit row.
 */
export async function readEndUserCount(): Promise<
  BridgeResult<{ count: number; truncated: boolean }>
> {
  const status = bridgeStatus();
  if (!status.configured) return unavailable(status.reason);

  const PAGE_SIZE = 1000;
  const MAX_PAGES = 50;
  let total = 0;
  let truncated = false;

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const { data, error } = await supabaseAdmin().auth.admin.listUsers({ page, perPage: PAGE_SIZE });
    if (error) {
      return { ok: false, data: null, source: "supabase", error: error.message, code: "query_failed" };
    }
    const batch = data?.users?.length ?? 0;
    total += batch;
    if (batch < PAGE_SIZE) return { ok: true, data: { count: total, truncated }, source: "supabase", queriedAt: new Date().toISOString() };
    if (page === MAX_PAGES) truncated = true;
  }
  return { ok: true, data: { count: total, truncated }, source: "supabase", queriedAt: new Date().toISOString() };
}
