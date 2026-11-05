# TASK-001 — Supabase credential discovery and secure wiring

**Status:** COMPLETE
**Branch:** `feat/admin-foundation` · **PR:** #1

## Objective

Connect ReplyMate Control to the Supabase project using credentials already present in the secure
environment settings, without printing, logging, committing or exposing any secret value, and without
silently falling back to local authentication when Supabase mode is selected.

## What was found

Discovery was performed **by name and presence only**. No value was ever printed to a terminal, a log
or a file.

| Variable | Present | Length | Classification |
|---|---|---|---|
| `SUPABASE_PROJECT_URL` | yes | 40 | public by design |
| `SUPABASE_PUBLISHABLE_KEY` | yes | 46 | client-safe by design, kept server-only here |
| `SUPABASE_SECRET_KEY` | yes | 41 | **server-only** |
| `SUPABASE_TRANSACTION_POOLER` | yes | 109 | **server-only** |

Key type was classified by prefix, which is a type tag rather than a secret:

- `SUPABASE_PUBLISHABLE_KEY` → new-format `sb_publishable_…` (not a legacy JWT)
- `SUPABASE_SECRET_KEY` → new-format `sb_secret_…` (not a legacy `service_role` JWT)

**Project identity verified:** the URL resolves to host `xdcsxxwhvpiissetbrdr.supabase.co`, project
ref `xdcsxxwhvpiissetbrdr` — an exact match for the project documented in the Android repository's
`docs/supabase/README.md`. This is the ReplyMate **production app data plane**.

**Pooler:** `aws-0-us-east-1.pooler.supabase.com:6543`, user `postgres.xdcsxxwhvpiissetbrdr`,
database `postgres`. Port 6543 is Supavisor **transaction** mode. The password was redacted from all
output; only its length (16) was noted.

## Changes

| File | Change |
|---|---|
| `src/config/env.ts` | Accepts the new-format names as primary, legacy `NEXT_PUBLIC_*` / `SERVICE_ROLE` as fallback. Normalises both into one `supabase` object with a detected `keyFormat`. Adds `supabaseProjectRef()` and a `secretExposedViaNextPublic` check. |
| `src/config/env.ts` | Empty or whitespace-only variables are now treated as **absent** via `z.preprocess`. A blank `SUPABASE_SECRET_KEY` means "not configured" — the difference between the bridge failing closed and failing open. It also stops an orchestrator's empty placeholder from failing `z.string().url()` and killing the process at import. |
| `src/lib/supabase/bridge.ts` | Uses the resolved coordinates; `bridgeStatus()` now reports `projectRef` and `keyFormat`, and its reason text states plainly that the secret key bypasses RLS. |
| `src/lib/auth/identity.ts` | Reads credentials **at call time**, not import time, so a rotation cannot be outlived by a cached client and so both configured/unconfigured states are testable. Adds a `nonEmpty()` guard and reports `projectRef`. |
| `vitest.config.ts` | Explicitly blanks every `SUPABASE_*` variable. The hosting platform injects real credentials into the process environment, so without this the offline suite's "unconfigured" assertions depended on wherever it happened to run. |
| `tests/identity.test.ts` | Six new cases: blank-as-absent, configured state, publishable-only (invitations refused), legacy-name fallback, project-ref exposure, and a check that no key value appears in serialised status. |
| `scripts/verify-integration.ts` | New live verifier — 35 assertions against the real project. Read only. |
| `src/app/(admin)/usage/page.tsx` | Remediation text now names the actual variables. |

## Security properties enforced

1. **No secret reaches a browser.** `SUPABASE_PUBLISHABLE_KEY` is *not* declared with a
   `NEXT_PUBLIC_` prefix, so Next.js will not inline it into any client bundle. The publishable key is
   client-safe by design, but this console is server-rendered and has no reason to talk to Supabase
   from the browser; not giving it one keeps the surface smaller.
2. **`envReport()` is presence-only.** It exposes booleans, the project ref, the key *format* and a
   `secretExposedViaNextPublic` tripwire. No key value can be returned by any API route.
3. **No silent fallback.** `AUTH_PROVIDER=supabase` with missing credentials returns **HTTP 503
   `provider_unavailable`**. Verified in `tests/identity.test.ts` and asserted live.
4. **The secret key bypasses RLS.** Confirmed empirically (see TASK-002): `GET /rest/v1/message`
   with the secret key returns `200`. The allow-list in `src/lib/privacy/guard.ts` is therefore
   **load-bearing, not defence-in-depth** — it is the only thing between this platform and ReplyMate
   end-user content. It fires before a query is constructed.

## Evidence

```
$ npx tsx scripts/verify-integration.ts
Configuration
  PASS  project ref is the expected ReplyMate project — ref=xdcsxxwhvpiissetbrdr
  PASS  no secret key is declared with a NEXT_PUBLIC_ prefix
  PASS  key format detected — format=new-publishable
Reachability
  PASS  project REST root reachable — HTTP 401 in 109ms
Allow-listed reads (real queries)
  PASS  rm_schema_migrations readable — 4 rows
  PASS  end-user count readable as a scalar — count=4
  PASS  the count result exposes only count and truncated — no identities
Privacy guard (must fire BEFORE any query is built)
  PASS  message / memory_fact / contact / contact_summary / contact_channel /
        draft / style_profile / app_kv  → PrivacyViolation (8 checks)
  PASS  provider_def.key_ref is excluded
  PASS  an unlisted table is denied by default
Identity strategy
  PASS  supabase strategy completes a real round-trip and rejects bad credentials — invalid_credentials
Local control-plane database (must be separate from Supabase)
  PASS  DATABASE_URL is NOT the Supabase production project — separate database
  PASS  no ReplyMate app table exists in the control-plane database — clean separation
RESULT: 35 passed, 0 failed
```

```
$ npx vitest run
Test Files  15 passed (15)
     Tests  417 passed (417)
```

The identity round-trip is a **real** call to Supabase Auth with deliberately wrong credentials
against a `@invalid.example` address. It proves the wiring works without creating or modifying any
production auth user.

## Remaining issues

- `AUTH_PROVIDER` is still `local` in the deployed preview. Switching it to `supabase` changes where
  administrator passwords are verified and is an operational decision, not a code change — see
  TASK-004 for the go/no-go evidence and what still needs owner approval.
- No Supabase **Management API** access: that requires a personal access token, which is not present.
  Plan and quota facts were therefore established from the database and API surfaces directly rather
  than from a billing endpoint. Documented in TASK-002.
