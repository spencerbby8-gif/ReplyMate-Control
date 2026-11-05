import { fetchSupabaseMigrationLedger } from "@/lib/integrations/github";
import { readSchemaMigrations } from "@/lib/supabase/bridge";

/**
 * Migration ledger comparison.
 *
 * Compares the migrations the repository *says* were applied
 * (`docs/supabase/README.md`, parsed by `fetchSupabaseMigrationLedger`) against
 * the ledger the live database actually holds (`public.rm_schema_migrations`).
 *
 * READ ONLY. This module never applies, repairs or writes a migration. Applying
 * anything to the production project is an owner decision; the SQL in
 * `supabase/migrations/` is authored documentation.
 */

export type LedgerComparison = {
  ok: boolean;
  /** Live versions, ascending. */
  live: number[];
  /** Versions the repository documents as applied. */
  documented: number[];
  missing: number[];
  undocumented: number[];
  duplicated: number[];
  contiguous: boolean;
  labels: Array<{ version: number; label: string | null; appliedAt: string | null }>;
  repoRows: Array<{ version: string; file: string; applied: string }>;
  source: { live: string; repository: string | null };
  errors: string[];
};

/** Pure comparison, separated so the arithmetic is testable without a network. */
export function compareLedgers(input: {
  live: Array<{ version: number; label: string | null; applied_at: string | null }>;
  documented: Array<{ version: string; file: string; applied: string }>;
}): Omit<LedgerComparison, "source"> {
  const liveVersions = input.live.map((row) => row.version);
  const documentedVersions = input.documented
    .map((row) => Number.parseInt(row.version, 10))
    .filter((value) => Number.isFinite(value));

  const liveSet = new Set(liveVersions);
  const documentedSet = new Set(documentedVersions);

  const missing = [...documentedSet].filter((v) => !liveSet.has(v)).sort((a, b) => a - b);
  const undocumented = [...liveSet].filter((v) => !documentedSet.has(v)).sort((a, b) => a - b);

  const seen = new Set<number>();
  const duplicated: number[] = [];
  for (const version of liveVersions) {
    if (seen.has(version) && !duplicated.includes(version)) duplicated.push(version);
    seen.add(version);
  }

  const sorted = [...liveSet].sort((a, b) => a - b);
  const contiguous = sorted.every((version, index) => version === sorted[0] + index);

  return {
    ok: missing.length === 0 && undocumented.length === 0 && duplicated.length === 0 && contiguous,
    live: sorted,
    documented: [...documentedSet].sort((a, b) => a - b),
    missing,
    undocumented,
    duplicated,
    contiguous,
    labels: input.live.map((row) => ({
      version: row.version,
      label: row.label,
      appliedAt: row.applied_at,
    })),
    repoRows: input.documented,
    errors: [],
  };
}

/** Runs the comparison against the live project and the repository. */
export async function compareLiveToRepository(): Promise<LedgerComparison> {
  const errors: string[] = [];

  const [liveResult, repoResult] = await Promise.all([readSchemaMigrations(), fetchSupabaseMigrationLedger()]);

  if (!liveResult.ok) {
    errors.push(`live ledger unreadable: ${liveResult.error}`);
  }
  const repoRows = repoResult.ok ? repoResult.rows : [];
  if (!repoResult.ok) {
    errors.push(`repository ledger unreadable: ${repoResult.error}`);
  }

  const comparison = compareLedgers({
    live: liveResult.ok ? liveResult.data : [],
    documented: repoRows,
  });

  return {
    ...comparison,
    ok: comparison.ok && errors.length === 0,
    errors,
    source: {
      live: "public.rm_schema_migrations (read via the allow-listed bridge)",
      repository: repoResult.ok ? repoResult.source : null,
    },
  };
}
