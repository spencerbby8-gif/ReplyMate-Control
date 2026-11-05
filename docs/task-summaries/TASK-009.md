# TASK-009 — Preview-environment verification and honest probe classification

**Status:** COMPLETE
**Branch:** `feat/admin-foundation` · **PR:** #1

## Objective

TASK-001…008 produced local and scripted evidence. This task supplies the
category that was still missing — **verification in the deployed preview
environment against the live Supabase project** — and fixes one reporting defect
found while doing it.

It also corrects the PR record: a comment was posted claiming TASK-001/002/003 as
new work while four commits already carrying those identifiers existed on the
remote branch. See *Record correction* below.

## Verification levels, kept distinct

Per the delivery requirements, these are separate categories and are not
conflated anywhere in this document:

| Level | What ran | Result |
|---|---|---|
| **Local unit tests** | `npx vitest run`, no network, credentials blanked by `vitest.config.ts` | **571 passed** |
| **Local scripted live checks** | `scripts/verify-integration.ts`, `scripts/audit-supabase.ts`, `scripts/apply-hardening.ts` | 35/35 assertions; audit complete; hardening self-test passed |
| **Preview environment** | deployed build at the preview URL, real HTTP through the app's own routes | all 16 console pages `200`; endpoints below |
| **Real Supabase operations** | live bridge from the preview process to `xdcsxxwhvpiissetbrdr.supabase.co` | bridge `live`; allow-listed reads succeeded |
| **Production operations** | writes to the Supabase project | **none performed** |

No mocks represent a live result at any level.

## Preview evidence

Deployment health:

```
GET /api/health  -> ok:true · database reachable · supabase bridge "live"
                    project https://xdcsxxwhvpiissetbrdr.supabase.co
```

All sixteen console pages returned `200` while authenticated: dashboard, users,
security, audit, ai-providers, model-routing, usage, ai-ops, feature-flags,
releases, devices, subscriptions, support, configuration, monitoring, privacy.

Security controls exercised through the deployed app, not a script:

| Check | Result |
|---|---|
| `POST /api/control` with `Sec-Fetch-Site: cross-site` **and a malformed body** | **403** — CSRF is evaluated *before* `request.json()`, so a cross-site request cannot probe which payloads validate |
| `POST /api/control` with `Origin: https://evil.example` | **403** |
| `POST /api/control` with `Sec-Fetch-Site: same-origin` | **400** (validation, not CSRF) — the gate does not over-block |
| `POST /api/maintenance/run` authenticated | **200**, `totalPruned: 0`, no errors |
| `POST /api/maintenance/run` unauthenticated | **401** |

Live-data surfaces confirmed in the deployed UI rather than asserted from code:

- `/usage` reports the bridge as **live** and shows an **honest empty** aggregate
  state. This is correct, not a gap: TASK-002 measured `usage_event` at **0 rows**
  in the live project, so there is no telemetry to aggregate.
- `/privacy` renders the migration ledger read live from the project.
- `/dashboard` shows the Supabase bridge as live with the correct project ref,
  plus the database-separation and encryption-key rows.
- The AI operations assistant answered from **live** bridge state, and volunteered
  the correct caveat: the secret key bypasses RLS, so the allow-list in
  `lib/privacy/guard.ts` is the only thing between this platform and ReplyMate
  end-user content.

Live probe suite executed from the preview process — 13 targets:

```
control-plane postgres      ok    6ms
supabase rest               ok    76ms   HTTP 401   <- anon revoked (migration 0003)
replymate source ledger     ok    193ms  HTTP 200
fallback search wikipedia   ok    459ms  HTTP 200
provider gemini             ok    229ms  HTTP 404
provider openai             ok    104ms  HTTP 404
provider openrouter         ok    143ms  HTTP 404
provider anthropic          ok    109ms  HTTP 404
provider deepseek           ok    312ms  HTTP 401
provider grok               ok    86ms   HTTP 404
provider kimi               ok    308ms  HTTP 404
provider mistral            ok    214ms  HTTP 404
provider ollama             down  4ms    fetch failed  <- see below
```

`401` and `404` are classified `ok` deliberately: these are unauthenticated
reachability probes, and ReplyMate is BYOK, so this platform holds no provider key
and cannot verify anyone's quota. A `401` from a provider API proves DNS, TLS and
routing work. Reporting it as `down` would be a false alarm.

## Defect found and fixed: the loopback probe read as an incident

`provider ollama` probes `http://localhost:11434/v1`. On a server there is no
local Ollama daemon, so that probe **always** fails — and it was reported as
`down` alongside genuine outages, with no way for an operator to tell a structural
fact of the environment from something actionable.

Fixed by classification, not by suppression:

- `isLoopback()` in `src/lib/monitoring/probes.ts` recognises `localhost`,
  `127.0.0.1` and `::1` (case-insensitively) and returns `false` for an
  unparseable URL rather than throwing.
- `ProbeTarget` carries a `loopback` flag; `defaultProbeTargets()` sets it.
- The Monitoring page explains the result inline: a loopback target reports `down`
  as a structural fact, not an incident, and not something fixable from this
  console.

The probe **still runs and still reports the real result.** Dropping the target
would have been the wrong fix: on a workstation that *should* have a local daemon,
silently skipping it would hide a genuine misconfiguration. Pinned by 5 new tests
in `tests/ingest-allowlist.test.ts`, including one asserting exactly `provider
ollama` is flagged and one asserting it is **not** removed from the suite.

## Record correction

A PR comment was posted describing TASK-001, TASK-002 and TASK-003 as new work.
At that moment the remote branch already contained four commits carrying those
same identifiers (`7c22d86`, `11c7459`, `d2a4c69`, `1156cca`), from a parallel
session whose work this checkout did not have.

What was done about it:

1. The push was **rejected** as non-fast-forward. It was **not** force-pushed —
   that would have destroyed 5,265 lines of committed work.
2. The divergent local commit was preserved on `backup/local-supabase-task` and
   the working tree was reset onto `origin/feat/admin-foundation`.
3. The local commit was then **discarded rather than merged**, because the remote
   already solved the same problems, generally better: `scripts/verify-integration.ts`
   gives stronger live evidence than the local vitest approach, and
   `scripts/audit-supabase.ts` is more thorough than the local audit script.
4. The remote work was **independently re-verified** rather than trusted — all 566
   of its tests were re-run, its live scripts were executed against the real
   project, and its task summaries were checked for overclaiming. TASK-005 says
   `NOT DEPLOYED`, TASK-006 says `NOT CONNECTED`, TASK-007 shows an actual
   execution. All three are accurate.
5. The genuinely new content from the divergent work was carried forward where it
   added value: the `override: true` insight about dotenv-vs-`test.env` precedence
   is already reflected in the remote `vitest.config.ts`, and the GoTrue
   "MFA keys absent rather than false" finding is recorded in TASK-002.

Task identifiers in this repository remain unique and sequential. No duplicate
`TASK-00n.md` file was created and no commit reuses an existing identifier.

## Files affected

`src/lib/monitoring/probes.ts`, `src/app/(admin)/monitoring/page.tsx`,
`tests/ingest-allowlist.test.ts`, `docs/task-summaries/TASK-009.md`

## Verification

`571/571` tests green (was 566) · eslint clean · `tsc --noEmit` clean ·
`next build` clean · `check-secrets` clean on 161 files · preview redeployed and
re-tested after the change.

## Remaining issues

- The loopback classification is generic, but only Ollama currently produces a
  loopback target. If a future provider default points at localhost, it will be
  flagged automatically — that is intended, not incidental.
- Preview verification is manual. A CI job that deploys and exercises these
  endpoints would make this evidence repeatable rather than a one-off transcript.
