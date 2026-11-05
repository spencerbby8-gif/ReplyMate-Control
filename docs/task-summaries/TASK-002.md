# TASK-002 — Live audit of the Supabase project

**Status:** COMPLETE (read only; no production change made)
**Branch:** `feat/admin-foundation` · **PR:** #1
**Evidence source:** `scripts/audit-supabase.ts` (SQL/catalogs) + REST/Auth API probes + `scripts/verify-integration.ts`

## Scope discipline

Every query was `SELECT` against `information_schema`, `pg_catalog`, `pg_policies` or
`storage.buckets`. **No DDL, no DML, no GRANT, no REVOKE was executed.** No user was created, no row
was written, no migration was applied, no plan was changed. Credentials were passed to clients and
never printed; only host, port, database name and query results appear in this document.

## 1. Which database holds the 21 `ctl_*` tables — answered precisely

| Database | Contents | Role |
|---|---|---|
| **Supabase `xdcsxxwhvpiissetbrdr`** | 11 tables: 10 ReplyMate app tables + `rm_schema_migrations`. **Zero `ctl_*` tables.** | **Production app data plane.** Owned by the Android product. |
| **Local Postgres `127.0.0.1:5432/app_db`** (`DATABASE_URL`) | 22 `ctl_*` tables. **Zero ReplyMate app tables.** | **Control plane.** Development/preview in this sandbox. |

Verified both directions, not just one:

```
Supabase  → "Are any control-plane (ctl_*) tables present?"  NONE.
Local     → appDataPlanePresent()                            present=false, tables=[]
```

`scripts/apply-hardening.ts` refuses to run against a Supabase host or any database containing app
tables, so the separation is enforced by tooling as well as by observation. `verify-integration.ts`
asserts both facts on every run.

**Conclusion: no control-plane object has ever been created in the production project, and none was
created during this audit.** Deploying `ctl_*` there would be a production migration and needs owner
approval; `supabase/migrations/0001_control_plane.sql` remains authored-but-unapplied.

## 2. Server and schema

- **PostgreSQL 17.6**, x86_64, gcc 15.2.0. Connected as role `postgres` (not superuser), database
  `postgres`, via Supavisor transaction pooler on port 6543.
- **11 relations in `public`**, all owned by `postgres`, all with `relrowsecurity = true`,
  `relforcerowsecurity = false`.
- **Database size: 12 MB.**

| Table | RLS | Exact row count |
|---|---|---|
| `app_kv` | on | 0 |
| `contact` | on | 0 |
| `contact_channel` | on | 0 |
| `contact_summary` | on | 0 |
| `draft` | on | 0 |
| `memory_fact` | on | 0 |
| `message` | on | 0 |
| `provider_def` | on | 0 |
| `style_profile` | on | 0 |
| `usage_event` | on | 0 |
| `rm_schema_migrations` | on | 4 |

**All ten content tables are empty.** The cloud foundation was applied in August 2026 and no end-user
has synced anything — consistent with `SYNC_ENABLED = false` being pinned in the Android app. There
was therefore no ReplyMate user data at risk during this work, though the allow-list was still
enforced as though there were.

## 3. RLS policies and permissions

Ten policies, one per app table, all `cmd = ALL`, all `roles = {authenticated}`:
`app_kv_owner`, `contact_owner`, `contact_channel_owner`, `contact_summary_owner`, `draft_owner`,
`memory_fact_owner`, `message_owner`, `provider_def_owner`, `style_profile_owner`,
`usage_event_owner`. No policy exists on `rm_schema_migrations` — RLS with no policy means deny.

Grants, exactly as migration 0003 intended:

| Grantee | App tables (×10) | `rm_schema_migrations` |
|---|---|---|
| `anon` | **nothing** | **nothing** |
| `authenticated` | `DELETE, INSERT, SELECT, UPDATE` | **nothing** |
| `service_role` | `DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE` | same |

Migration 0003's revocation is **confirmed effective in the live database**: `anon` holds zero
privileges, and `authenticated` holds exactly CRUD with no `TRUNCATE`/`REFERENCES`/`TRIGGER`.

Empirically confirmed over REST:

```
publishable key → SELECT message      401  code 42501 (insufficient privilege)
publishable key → SELECT provider_def 401  code 42501
secret key      → SELECT message      200  []      ← BYPASSES RLS
```

> **Security consequence, recorded in TASK-001:** the secret key reads every content table. The
> privacy allow-list is the only control between this platform and end-user content. It fires before
> a query is built and was verified live against all eight content tables plus `provider_def.key_ref`.

Roles present (15): `anon`, `authenticated`, `authenticator`, `dashboard_user`, `pgbouncer`,
`postgres`, `service_role`, `supabase_admin` (the only superuser), `supabase_auth_admin`,
`supabase_etl_admin`, `supabase_privileged_role`, `supabase_read_only_user`,
`supabase_realtime_admin`, `supabase_replication_admin`, `supabase_storage_admin`.

## 4. Migration ledger — repository vs live

| Repo file | Live ledger | Match |
|---|---|---|
| `0001_foundation.sql` | v1 "foundation: blueprint v1 cloud schema + RLS + sync plumbing" — 2026-08-06 18:05:26Z | ✅ |
| `0002_widen_channel_checks.sql` | v2 "p3 parity: widen contact_channel.channel check…" — 2026-08-06 20:42:40Z | ✅ |
| `0003_revoke_anon_surface.sql` | v3 "P16 integrity: anon revoked (0001 contract)…" — 2026-08-15 13:21:54Z | ✅ |
| `0004_avatars_bucket.sql` | v4 "P16 integrity: public avatars storage bucket…" — 2026-08-15 13:21:55Z | ✅ |
| `verify_0001.sql`, `verify_0003_0004.sql` | verification scripts, not ledger rows | ✅ n/a |

**No missing migrations. No duplicates. No unapplied repository migration. No live version absent
from the repository.** The ledger is contiguous 1→4.

`supabase_migrations.schema_migrations` is **absent**, exactly as `docs/supabase/README.md` documents:
migrations were applied by `psql` over the pooler, never `supabase db push`. This is recorded accepted
debt (finding F3), not drift.

## 5. Auth configuration and actual behaviour

From the public `/auth/v1/settings` endpoint and `/auth/v1/admin/users` with the secret key:

| Setting | Live value |
|---|---|
| Enabled providers | `anonymous_users`, `email` |
| Disabled providers | `google`, apple, azure, discord, facebook, github, gitlab, phone, and 16 others |
| `disable_signup` | **false** (open signup) |
| `mailer_autoconfirm` | false |
| `mfa` | **null** — no MFA configuration exposed |
| `passkeys_enabled`, `saml_enabled` | present as settings keys |

**Users (aggregate only — no email or identifier is reproduced here):**

| Metric | Value |
|---|---|
| Total | 4 |
| By audience | `authenticated`: 4 |
| By provider | `email`: 1 · no provider recorded: 3 |
| With a non-empty email | 1 |
| Anonymous / no identity | 3 |
| Email confirmed | 0 |
| MFA factors enrolled | 0 |
| Created | 2026-08-07 … 2026-08-15 |

Two findings the owner should see:

1. **Google OAuth is disabled in this project, but ReplyMate 1.2.0 shipped "Google OAuth + PKCE via
   browser + deeplink"** (`releases/RELEASES.md`). Against this project that flow cannot succeed.
   Either the provider needs enabling in the dashboard or the app's Google path is dead in
   production. Not changed here — it is a production auth configuration change.
2. **`disable_signup: false`** means anyone can create an auth user. That is acceptable for the
   *app's* end users (it is how anonymous sign-in works), but it is why **administrator roles must
   never be derived from a Supabase claim**. They are not: role lives in `ctl_admin` in the control
   plane, and an anonymous signup receives no row and therefore no capability.

Verification round-trip performed: `signInWithPassword` with a deliberately wrong password against an
`@invalid.example` address → rejected as `invalid_credentials`. Proves the strategy is wired to the
live service. **No user was created, invited or modified.**

## 6. Edge Functions, Realtime, storage

- **Edge Functions: could not be enumerated.** `supabase_functions` schema is not readable by the
  `postgres` role, and the Management API requires a personal access token that is not present in
  this environment. Recorded as unknown rather than assumed absent.
- **Realtime: provisioned.** Schema `realtime` contains `messages`, `schema_migrations`,
  `subscription`. No publication content was inspected.
- **Storage: one bucket** — `avatars`, `public = true`, no `file_size_limit`, `type = STANDARD`,
  versioning disabled. Matches migration 0004. Zero objects.

## 7. Extensions and what they permit

Installed: `pg_stat_statements` 1.11, `pgcrypto` 1.3, `plpgsql` 1.0.

**Not installed:** `pg_cron`, `pg_net`, `pg_graphql`. The helper functions
`extensions.grant_pg_cron_access`, `grant_pg_net_access` and `grant_pg_graphql_access` exist, so they
are available to enable — but enabling an extension is a production change and was **not** performed.

Consequence for TASK-007: **in-database scheduling is unavailable**, so session/attempt pruning must
run from the application or an Edge Function cron, not from `pg_cron`.

## 8. Plan and quota — what could and could not be verified

The Management API (`/v1/projects`) requires a personal access token; with only the project keys it
returns 404/401. **The plan therefore could not be read from a billing endpoint**, and is not asserted
as verified. Evidence consistent with the Free tier:

| Signal | Observed | Free-tier limit |
|---|---|---|
| Database size | 12 MB | 500 MB |
| Egress | not measurable from here | 5 GB |
| Storage | 1 bucket, 0 objects | 1 GB |
| Monthly active users | 4 | 50,000 |
| `pg_cron` / `pg_net` | not installed | available on Free |
| Edge Function invocations | not measurable from here | 500,000 |

Design assumption adopted: **treat this as Free tier** — 500 MB database, 5 GB egress, 1 GB storage,
and project pausing after a week of inactivity. Every feature in this PR is designed to stay inside
that: aggregate reads with explicit `limit`, no polling loops, no large payload storage, and pruning
of short-lived throttle rows.

## 9. Remaining issues / blocked items

| Item | Status | Required action |
|---|---|---|
| Deploy `ctl_*` into this project | **NOT DONE — needs approval** | Production migration. Review `supabase/migrations/0001_control_plane.sql`, then apply by hand over the pooler. |
| Enable Google OAuth | **NOT DONE — needs approval** | Production auth configuration change. |
| Set `disable_signup` | **NOT DONE — needs approval** | Would break the app's anonymous sign-in; must be decided with the owner. |
| Enable `pg_cron` / `pg_net` | **NOT DONE — needs approval** | Production extension install. |
| Enumerate Edge Functions | **BLOCKED** | Needs a Supabase personal access token (Management API). |
| Confirm plan from billing | **BLOCKED** | Same — Management API access. |
| Read egress / quota counters | **BLOCKED** | Not exposed via project keys or SQL. |
