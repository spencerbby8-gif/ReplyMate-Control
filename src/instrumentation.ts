import { env } from "@/config/env";

/**
 * Server startup hook.
 *
 * WHAT THIS DOES: optionally starts an in-process interval that runs maintenance
 * (pruning expired sessions, stale login-throttle rows, expired invitations and
 * idle assistant sessions).
 *
 * WHAT THIS DOES NOT DO — stated plainly because the difference matters:
 *
 *   This is NOT a durable scheduler. An interval inside a Node process:
 *     - stops when the process stops,
 *     - does not survive a redeploy or a container restart,
 *     - never fires at all in a serverless deployment, where no long-lived
 *       process exists between requests,
 *     - runs once per instance, so a multi-instance deployment prunes N times.
 *
 *   Pruning is idempotent, so N times is wasteful rather than wrong — but nobody
 *   should read "the scheduler is running" from this file alone. The evidence is
 *   the `maintenance.run` rows in `ctl_audit_log`, and the Security page shows
 *   the last ACTUAL run rather than a claimed schedule.
 *
 *   For a guarantee, drive `POST /api/maintenance/run` from an external cron
 *   (system crontab, GitHub Actions schedule, or a platform job) and check the
 *   audit log. `npx tsx scripts/run-maintenance.ts` is the same code path from a
 *   shell.
 *
 * Opt-in: set `MAINTENANCE_INTERVAL_MINUTES` to a positive number. The default is
 * 0 — off — because silently starting a background timer is exactly the kind of
 * claim this codebase refuses to make implicitly.
 */
export async function register() {
  // Only in the Node runtime; the edge runtime has no timers to rely on.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const minutes = Number(env.MAINTENANCE_INTERVAL_MINUTES ?? 0);
  if (!Number.isFinite(minutes) || minutes <= 0) return;

  const intervalMs = Math.max(60_000, minutes * 60_000);

  const { runMaintenance } = await import("@/lib/maintenance/runner");

  // A run is attempted once at startup so a short-lived process still prunes,
  // then on the interval. Failures are logged by class only, never with detail.
  const tick = async (trigger: "startup" | "interval") => {
    try {
      const report = await runMaintenance(trigger);
      if (report.errors.length > 0) {
        console.warn(`[maintenance] ${trigger} pass reported errors: ${report.errors.length}`);
      }
    } catch (error) {
      console.error(`[maintenance] ${trigger} pass failed: ${error instanceof Error ? error.name : "unknown"}`);
    }
  };

  void tick("startup");
  const timer = setInterval(() => void tick("interval"), intervalMs);
  // Never hold the process open for a background timer.
  timer.unref?.();

  console.log(
    `[maintenance] in-process interval started every ${minutes} minute(s). This is NOT a durable scheduler — verify with maintenance.run rows in ctl_audit_log.`,
  );
}
