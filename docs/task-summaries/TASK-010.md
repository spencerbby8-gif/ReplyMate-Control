# TASK-010 — Build-time secret-exposure guard and branch integration

**Status:** complete
**Evidence class:** local (unit tests) + repository history

## Objective

Close a secret-exposure gap that no other layer catches, and integrate two
parallel lines of work on `feat/admin-foundation` without destroying either.

## Part 1 — the gap

Next.js inlines every `NEXT_PUBLIC_*` variable into the browser bundle at **build
time**. So a secret behind that prefix is published to every visitor, every
Android WebView and the public internet — and the application still builds and
runs normally. Nothing fails.

The mistake is trivial to make and invisible in review: someone "just trying to
get the client working" renames `SUPABASE_SECRET_KEY` to
`NEXT_PUBLIC_SUPABASE_SECRET_KEY`. Existing protections do not catch it:

- `.gitignore` does not help — the value is in the platform's environment, not a
  file.
- `scripts/check-secrets.mjs` scans committed files, not the runtime environment.
- The privacy guard governs database reads, not bundle contents.

Given that this project holds a `service_role`-equivalent secret key which
**bypasses RLS** (verified in TASK-002), a leak is full write access to the
production database.

### Fix

`assertNoSecretInPublicVars()` in `src/config/env.ts`, called at **module
import**, so both the build and the server refuse to start.

Refusal rules:

| Value behind `NEXT_PUBLIC_*` | Result |
|---|---|
| `sb_secret_…`, `sk-…`, `sbp_…`, `ghp_…`, `xoxb-…` | **refused** |
| JWT with `role: "service_role"` | **refused** |
| JWT with `role: "anon"` | allowed |
| publishable key, project URL, site name | allowed |
| any secret in a non-prefixed variable | allowed |

Two details that matter:

1. **The legacy anon JWT is allowed.** It is public by design — the ReplyMate
   Android app embeds it, and `docs/supabase/README.md` states the database is
   guarded by RLS rather than by key secrecy. Rejecting it would break a correct
   configuration, so the guard would get disabled and protect nothing.
2. **JWTs are classified by decoding the `role` claim**, not by pattern-matching
   the `eyJ` shape. Shape-matching either blocks the anon key (false positive) or
   misses a service_role key that does not match the pattern (false negative).

The error names every offending variable, de-duplicates, says what to do instead,
and **never prints a secret value**.

### Tests

`tests/env-secret-exposure.test.ts` — 19 cases: correct configurations accepted
(publishable URL/key, anon JWT, non-prefixed secrets, empty env); each secret
shape refused; service_role refused while anon is allowed; malformed JWTs survive
without raising the wrong error; every offender named; no secret in the message;
de-duplication; actionable remediation text; and `envReport()` asserted free of
any secret shape.

## Part 2 — branch integration

Two parallel work streams had committed to `feat/admin-foundation` from the same
merge base (`b303d76`). The remote held five commits (~5,500 insertions)
including the AI gateway Edge Function, role mapping, the ingest contract, the
maintenance runner, proxy-aware client IP and TASK-009. A local commit covered
overlapping ground.

`git push` was **rejected** as non-fast-forward. Force-pushing would have
destroyed the remote work, so it was not done. Instead:

1. Fetched and diffed both sides against the merge base to map the overlap — 18
   files touched by both.
2. Compared implementations rather than assuming. The remote was a superset:
   same fail-closed Supabase identity design, same current/legacy key handling
   (plus `SUPABASE_SESSION_POOLER`), plus the gateway and TASK-009 that the local
   commit did not have.
3. Adopted the remote branch as the base, preserving all five commits intact.
4. Re-applied only what was genuinely unique and non-duplicative: the leak guard,
   its tests, and this index. Locally-duplicated modules (a second audit module,
   a second maintenance-jobs file, a second reconciliation API, a second verify
   script) were **dropped** rather than merged in as dead code.

### Correction recorded

A PR comment was posted describing TASK-001…006 as complete **before** the push
succeeded — the push had in fact been rejected. That violates the rule that a
task is not complete until its evidence is pushed. A correcting comment was
posted, and this file records it so the history is not misleading.

## Result

| Check | Result |
|---|---|
| `npm run lint` | clean |
| `npm exec tsc -- --noEmit` | clean, 0 errors |
| `npx next typegen` | ✓ |
| `npx vitest run` | **590 / 590** (571 from the integrated branch + 19 new) |
| `node scripts/check-secrets.mjs --all` | clean |
| Remote commits preserved | all 5 intact, no force-push, no history rewrite |

## Remaining issues

- The guard runs at import time in the Node runtime. A build that never imports
  `src/config/env.ts` would not trip it; in this app every server surface does.
- It covers `NEXT_PUBLIC_*` only. Other bundler escape hatches (a key copied into
  a client component's source) are out of scope and belong to `check-secrets.mjs`
  and review.
