# Supabase migrations — AUTHORED, NOT APPLIED

> **Status: documentation only.** Nothing in this directory has been executed against any database,
> and nothing in this repository will execute it. Applying a migration to the ReplyMate production
> project requires an owner decision and a change-control entry under `docs/BLUEPRINT.md` §11 in
> [`spencerbby8-gif/ReplyMate`](https://github.com/spencerbby8-gif/ReplyMate).

## Why this directory exists

ReplyMate Control has two separate database concerns, and they must not be confused:

| Concern | Database | How it is managed |
|---|---|---|
| **Control plane** (`ctl_*` tables) | This platform's own Postgres (`DATABASE_URL`) | Drizzle schema in `src/db/schema.ts`, applied with `npx drizzle-kit push` during setup. Never points at the ReplyMate project. |
| **App data plane** (`contact`, `message`, `provider_def`, …) | The ReplyMate Supabase project | Owned by the Android repository. Migrations `0001`–`0004` are already applied and are recorded in `public.rm_schema_migrations`. **Read-only from here.** |

The SQL in this directory is for the *second* concern: it describes the minimum schema an owner would
need **if** they ever chose to host the control plane inside the same Supabase project instead of a
separate Postgres. It is written to be reviewed, not run.

## What is deliberately absent

- No migration touches `message`, `memory_fact`, `contact_summary`, `draft`, `style_profile`,
  `app_kv`, `contact` or `contact_channel`. The control plane has no reason to alter a content table
  and no right to.
- No migration grants this platform write access to any app table.
- No migration flips anything resembling sync. `SYNC_ENABLED` is an app-side constant pinned by
  `SupabaseConfigTest`; it is not a database setting and cannot be changed from here.
- No `service_role` key, password, connection string or other credential appears in any file.

## If an owner decides to proceed

1. Review `0001_control_plane.sql` against `src/db/schema.ts` — the schema file is authoritative.
2. Apply it with `psql` over the Supavisor **session pooler**, the same route used for the app's own
   `0001`–`0004` (the Direct Connection host is IPv6-only and unreachable from many sandboxes).
3. Record the applied version in `public.rm_schema_migrations`, matching the existing ledger
   convention (`000N_*.sql` names, not CLI timestamps).
4. Re-run `docs/supabase/migrations/verify_*.sql`-style structural checks before declaring success.

Until steps 1–4 happen deliberately, the correct deployment is a **separate database** for the
control plane, which is what this repository assumes by default.
