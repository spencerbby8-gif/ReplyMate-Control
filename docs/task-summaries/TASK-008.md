# TASK-008 — Pages on live data, proxy-aware throttling, edge CSRF

**Status:** COMPLETE for what is verifiable · two items remain blocked on approval
**Branch:** `feat/admin-foundation` · **PR:** #1

## Objective

Connect the Overview, Usage, Activity, Devices, Configuration, Security and AI Operations pages to
real authorized backend data. Complete edge CSRF hardening and review proxy-aware rate limiting.

## What is now live rather than described

The Supabase credentials added to the environment made the bridge real. Verified against the deployed
preview:

```
GET /api/health →
  supabase.bridge   : "live"
  supabase.projectUrl: https://xdcsxxwhvpiissetbrdr.supabase.co
  supabase.reachable : true  (57 ms, HTTP 401 on the unauthenticated root, which is
                              reachability not failure)
  auth.provider      : "local"
```

| Page | Live data source | Observed |
|---|---|---|
| **Overview** | 9-row system health panel; `ctl_*` table count; app-table absence assertion; `pg_trigger` check; throttle posture; config release; telemetry counts; probe results | all rendered from real queries |
| **Usage** | `readUsageAggregates()`, `readProviderDistribution()` against production | bridge live; `usage_event` 0 groups and `provider_def` 0 groups reported as an **honest empty state**, not zeros dressed as data |
| **Privacy** | `compareLiveToRepository()` | badge reads **in agreement**, versions 1–4 both sides |
| **Devices** | registrations, per-kind event counts, latency percentiles, error distribution | real rows from the demonstrated ingest |
| **Configuration** | `currentRelease()`, `draftDrift()`, release history | published release and drift shown |
| **Security** | key state, throttle posture, `lastMaintenanceRun()` from the audit log | recorded executions, not configuration |
| **Activity** | `listAudit()` with keyset pagination | cursor is the oldest row id on the page |
| **AI Operations** | new `supabase_audit` tool | see below |

The assistant was asked *"Compare the migration ledger between the repository and the live database.
Any drift?"* and invoked two real tools:

```
tools invoked: ["supabase_bridge", "supabase_audit"]
answer:
  Bridge mode: live. Auth provider: local.
  Secret key present. Allow-listed, read-only queries are permitted. The secret key
  bypasses RLS, so the allow-list in lib/privacy/guard.ts is the only thing standing
  between this platform and ReplyMate end-user content.
  ...
  Live and documented ledgers AGREE: versions [1, 2, 3, 4]. No missing, duplicated or
  unapplied migration.
  This is a read-only comparison. Nothing here applies or repairs a migration.
```

Read-only, as required. The assistant still has no mutation tool; any future one needs an explicit
administrator confirmation step before it may be added.

## Proxy-aware rate limiting — the finding, and the real fix

TASK-007's throttle test produced evidence worth acting on: 24 probe logins spread across **three
spoofed `X-Forwarded-For` values** all collapsed onto **one** source digest and tripped the
distinct-target limit at 8. That proved this platform's edge **overwrites** the header rather than
appending to it.

But that is a property of *this* proxy, not a guarantee, and the code previously assumed the leftmost
entry unconditionally — which is client-controlled wherever a proxy appends. `lib/http.ts` now resolves
the IP according to an explicit `TRUST_PROXY` setting:

| Mode | Entry used | When |
|---|---|---|
| `overwrite` (**default**) | leftmost | The platform rewrites the header, as observed here. Cannot be widened by a client, only narrowed. |
| `append` | **rightmost** | A proxy chain that appends. The rightmost entry was written by our own proxy and a client cannot forge it. |
| `none` | header ignored | No proxy; only a platform-set `X-Real-IP` / `CF-Connecting-IP` is used. |

The default is the conservative one: a client can never make throttling *weaker* by changing a header.
`tests/client-ip.test.ts` (20 cases) pins all three modes, including the specific attack — varying the
leftmost value across three requests must yield **one** stable source in `append` mode — plus
malformed-input tolerance.

The IP remains audit and throttle context only. It is never an input to an authorization decision.

## Edge CSRF hardening

`Sec-Fetch-Site` takes precedence and **overrides a forged `Origin`**; `Origin`/`Referer` host matching
applies when that header is absent; non-browser clients with neither header are allowed because there
is no victim session to ride; a malformed `Origin` is refused rather than failed open. In
`/api/control` the check runs **before `request.json()`**, so a cross-site request cannot probe which
actions exist or which payloads validate. Verified live:

```
Sec-Fetch-Site: cross-site  + malformed body → 403 csrf_rejected   (not 400)
Origin: https://evil.example + malformed body → 403 csrf_rejected
```

`CONTROL_PUBLIC_URL` extends the accepted origin set for deployments behind a custom domain; a
malformed value is ignored rather than widening the allow-list.

## Verification

```
npx vitest run                     566 passed (20 files)      offline, hermetic
scripts/verify-integration.ts      35 passed, 0 failed        LIVE Supabase + local DB
npx next typegen / tsc --noEmit    clean                      (app and Edge Functions)
npm run lint                       clean
npm run build                      clean
scripts/check-secrets.mjs --all    clean on 159 files
all 16 console pages               200 with live data
```

**Test layers, kept distinct:** *local* = vitest, no network; *preview* = the deployed sandbox, real
HTTP; *live Supabase* = `verify-integration.ts` and the pages above, real queries against production
(read only); *production operations* = none performed, by design.

## Remaining blocked items

| Item | Blocker | Required action |
|---|---|---|
| AI Operations mutation tools | Policy, not code | Needs an explicit administrator-confirmation step designed and approved first. Read-only until then. |
| Durable scheduler | No `pg_cron` on the project; in-process intervals are not durable | Point an external cron at `POST /api/maintenance/run`, or approve installing `pg_cron`. |
| Deploy the AI gateway | No Supabase access token; production change | Owner approval, then `deno check` and `supabase functions deploy`. |
| Connect Android telemetry | No client build sends it | Six prerequisites listed in `docs/ANDROID-CONTRACT.md`, including a change-control entry in the Android repo. |
| Switch to `AUTH_PROVIDER=supabase` | Operational decision | The strategy is implemented and verified; enabling it changes where admin passwords are verified. |
