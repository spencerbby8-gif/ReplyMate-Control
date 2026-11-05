# TASK-007 — Maintenance scheduling, demonstrated

**Status:** COMPLETE — an actual execution is demonstrated below, not assumed
**Branch:** `feat/admin-foundation` · **PR:** #1

## Objective

Implement and verify scheduled pruning of expired login attempts and sessions. Do not claim a
scheduler works until an actual scheduled execution is demonstrated.

## The constraint that shaped the design

TASK-002 established from the live database that **`pg_cron` is not installed** on the Supabase
project. The helper function `extensions.grant_pg_cron_access` exists, so it could be enabled — but
installing an extension in the production project is a production change requiring owner approval, so
it was **not** done. Pruning therefore runs from the application.

## What was built

| File | Purpose |
|---|---|
| `src/lib/maintenance/runner.ts` | `runMaintenance(trigger, actor?)` — four isolated pruning steps, each with its own try/catch so one failure cannot stop the others, and every run recorded in the audit log with its trigger. |
| `scripts/run-maintenance.ts` | The same code path from a shell, for an external cron. `npx tsx scripts/run-maintenance.ts [trigger]`. |
| `src/app/api/maintenance/run/route.ts` | `POST` gated on the new `maintenance:run` capability, CSRF-checked first. Lets an external scheduler drive it over HTTP. |
| `src/instrumentation.ts` | Opt-in in-process interval via `MAINTENANCE_INTERVAL_MINUTES` (default **0 = off**). |
| `src/lib/queries/admins.ts` | `lastMaintenanceRun()` and `maintenanceRunCount()`, read from the audit log. |
| `src/app/(admin)/security/page.tsx` | Maintenance panel: last actual run, trigger, per-category counts, errors, total run count, and a "Run maintenance now" control. |

Pruned: expired sessions · login-throttle rows past retention (7 days) · expired un-redeemed
invitations older than a day · assistant sessions idle over 30 days. **The audit log is never pruned** —
it is append-only by database trigger.

## The honesty requirement, taken seriously

An interval inside a Node process is **not** a durable scheduler. It stops when the process stops, does
not survive a redeploy, never fires at all in a serverless deployment, and runs once per instance in a
multi-instance deployment. Pruning is idempotent, so N runs is wasteful rather than wrong — but nobody
should infer "the scheduler is running" from the existence of a `setInterval` call.

Three consequences in the design:

1. The interval is **off by default**. Silently starting a background timer is exactly the kind of
   implicit claim this codebase refuses to make.
2. `src/instrumentation.ts` logs its own limitation at startup, and the module docstring states it.
3. **The UI reports recorded executions, not configuration.** `lastMaintenanceRun()` reads
   `ctl_audit_log`; when no run has ever been recorded the panel says "Maintenance has never run"
   instead of showing a schedule.

## Demonstrated execution

Rows that should be pruned were inserted first, then the runner was executed and the counts compared.

```
before: sessions=3  attempts=5  invites=2

$ npx tsx scripts/run-maintenance.ts manual
trigger      : manual
ran at       : 2026-11-05T03:39:32.335Z
duration     : 32ms
pruned total : 10
  expiredSessions          3
  staleLoginAttempts       5
  expiredInvites           2
  idleAssistantSessions    0
errors       : none

after:  sessions=0  attempts=0  invites=2→0
```

Audit proof — the row that makes the run verifiable after the fact:

```
     action      | outcome |                                                   pruned
-----------------+---------+------------------------------------------------------------------------------------------------
 maintenance.run | success | {"expiredInvites": 0, "expiredSessions": 0, "staleLoginAttempts": 4, "idleAssistantSessions": 0}
```

## A real bug this demonstration exposed

The first run's audit row read:

```
{"expiredInvites": 2, "expiredSessions": "[redacted]", "staleLoginAttempts": 5,
 "idleAssistantSessions": "[redacted]"}
```

`expiredSessions` and `idleAssistantSessions` were blanked because the redactor's secret-key pattern
matches the substring `session`. The most useful facts in the row were destroyed by over-redaction —
and an audit log that blanks its own counts gets switched off.

**Fix, in `src/lib/audit/redact.ts`:** a `number` or `boolean` cannot be a credential, so scalar
non-secret values now survive even under a secret-shaped key. Secrets are strings; only strings are
screened. Applied to both `redactValue` and `diffForAudit`. The distinction is the *type*, not the key
— `sessionToken: "abc123"` is still redacted while `expiredSessions: 3` is preserved.

8 regression tests added, including one that asserts a complete maintenance report survives redaction
byte-for-byte.

```
$ npx vitest run
  Test Files  16 passed (16)
       Tests  443 passed (443)
```

## Capability matrix

`maintenance:run` — owner ✅ admin ✅ operator ✅ support ❌ viewer ❌ (verified by executing the matrix,
not by reading it).

## Remaining issues

- **No external cron is configured.** The endpoint and the script exist and are demonstrated, but
  nothing calls them on a schedule in this environment. To make pruning automatic, point a system
  crontab, a GitHub Actions schedule or a platform job at `POST /api/maintenance/run`, or run
  `npx tsx scripts/run-maintenance.ts interval`.
- **`MAINTENANCE_INTERVAL_MINUTES` is 0 (off)** in the deployed preview, deliberately.
- Enabling `pg_cron` on the Supabase project would allow in-database scheduling and is **not done** —
  it needs owner approval.
