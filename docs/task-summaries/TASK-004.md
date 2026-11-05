# TASK-004 — Migration workflow and ledger comparison

**Status:** COMPLETE (read only; nothing applied)
**Branch:** `feat/admin-foundation` · **PR:** #1

## Objective

Compare the actual database migration ledger against the repository migrations and identify missing,
duplicated or unapplied migrations — without applying anything.

## What was built

| File | Purpose |
|---|---|
| `src/lib/supabase/migrations.ts` | `compareLedgers()` (pure) and `compareLiveToRepository()` (live). Returns `missing`, `undocumented`, `duplicated`, `contiguous` and `errors`. |
| `src/app/(admin)/privacy/page.tsx` | Now shows the comparison with an explicit `in agreement` / `DRIFT` / `not comparable` badge, rather than only the repository's own claim. |
| `tests/migration-ledger.test.ts` | 12 cases covering agreement, drift in every direction, gaps, duplicates and empty states. |

The two sources compared are **independent**: the live `public.rm_schema_migrations` table read
through the allow-listed bridge, and `docs/supabase/README.md` in the Android repository parsed by
`fetchSupabaseMigrationLedger()`. Neither is derived from the other, so agreement is evidence.

## Result — the live project and the repository agree

```
live       [1, 2, 3, 4]
documented [1, 2, 3, 4]
missing []  undocumented []  duplicated []  contiguous true  → ok
```

| Version | Live label | Live applied | Repo file |
|---|---|---|---|
| 1 | foundation: blueprint v1 cloud schema + RLS + sync plumbing | 2026-08-06 18:05:26Z | `0001_foundation.sql` |
| 2 | p3 parity: widen contact_channel.channel check | 2026-08-06 20:42:40Z | `0002_widen_channel_checks.sql` |
| 3 | P16 integrity: anon revoked (0001 contract) | 2026-08-15 13:21:54Z | `0003_revoke_anon_surface.sql` |
| 4 | P16 integrity: public avatars storage bucket + owner-scoped object policies | 2026-08-15 13:21:55Z | `0004_avatars_bucket.sql` |

**No missing migrations. No duplicates. No unapplied repository migration. No live version absent from
the repository.** The repository's `verify_0001.sql` and `verify_0003_0004.sql` are verification
scripts, not ledger rows, and the comparison correctly ignores the README's non-numeric `verify`
entries (a dedicated test pins this).

`supabase_migrations.schema_migrations` (the official CLI history table) is **absent**, exactly as
`docs/supabase/README.md` documents: migrations were applied by `psql` over the Supavisor pooler,
never `supabase db push`. That is recorded accepted debt (finding F3), not drift, and the comparison
does not treat it as a failure.

## Migration workflow, as it now stands

1. **Author** SQL under `supabase/migrations/` with an explicit applied/not-applied status.
2. **Compare** — this task's tooling — to establish the current state before proposing a change.
3. **Apply by hand**, by the owner, over the session pooler with `psql`.
4. **Record** the version in `public.rm_schema_migrations`, matching the `000N_*.sql` convention.
5. **Re-compare** to confirm the ledger and the repository agree again.

This platform performs steps 1, 2 and 5. It never performs 3 or 4.

## Control-plane migrations are separate

The `ctl_*` schema lives in the control-plane database and is managed by Drizzle
(`npx drizzle-kit push`), not by this ledger. `scripts/apply-hardening.ts` refuses to run against a
Supabase host or any database containing ReplyMate app tables, so the two workflows cannot be
crossed by accident.

## Remaining issues

- `supabase/migrations/0001_control_plane.sql` remains **authored, not applied**. Deploying the
  control plane into the production project is an owner decision.
- Adopting CLI-shaped migration names plus `supabase migration repair` would give
  `supabase migration list` parity. Deferred by the repository's own finding F3; not started here.
