import { and, lt } from "drizzle-orm";
import { db } from "@/db";
import { ctlAiopsSession, ctlInvite, ctlSession } from "@/db/schema";
import { LOGIN_THROTTLE, pruneLoginAttempts } from "@/lib/auth/rate-limit";
import { auditActions, recordAudit } from "@/lib/audit/logger";

/**
 * Maintenance runner.
 *
 * WHY THIS IS APPLICATION-SIDE: the live audit (TASK-002) found that `pg_cron`
 * is NOT installed on the production Supabase project, and installing an
 * extension there is a production change requiring owner approval. So pruning
 * runs from the application — on an in-process interval and/or via an
 * authenticated HTTP call from an external scheduler.
 *
 * HONESTY REQUIREMENT: an interval inside a Next.js process is NOT a durable
 * scheduler. It stops when the process stops, does not survive a redeploy, and
 * in a serverless deployment may never fire at all. That is why every run is
 * recorded in the audit log with its trigger, and why the UI reports the last
 * ACTUAL run instead of claiming a schedule exists.
 */

export type MaintenanceTrigger = "manual" | "interval" | "startup" | "api";

export type MaintenanceReport = {
  trigger: MaintenanceTrigger;
  ranAt: string;
  durationMs: number;
  pruned: {
    expiredSessions: number;
    staleLoginAttempts: number;
    expiredInvites: number;
    idleAssistantSessions: number;
  };
  errors: string[];
};

/** Days after which an assistant session with no activity is removed. */
export const AIOPS_RETENTION_DAYS = 30;

export async function runMaintenance(
  trigger: MaintenanceTrigger,
  actor?: { adminId: string; email: string; role: string; requestId?: string },
): Promise<MaintenanceReport> {
  const started = Date.now();
  const errors: string[] = [];
  const pruned = {
    expiredSessions: 0,
    staleLoginAttempts: 0,
    expiredInvites: 0,
    idleAssistantSessions: 0,
  };

  // Each step is isolated: one failure must not stop the others, and the failure
  // is reported rather than swallowed.

  try {
    const deleted = await db
      .delete(ctlSession)
      .where(lt(ctlSession.expiresAt, new Date()))
      .returning({ id: ctlSession.id });
    pruned.expiredSessions = deleted.length;
  } catch (error) {
    errors.push(`sessions: ${error instanceof Error ? error.name : "unknown"}`);
  }

  try {
    pruned.staleLoginAttempts = await pruneLoginAttempts();
  } catch (error) {
    errors.push(`loginAttempts: ${error instanceof Error ? error.name : "unknown"}`);
  }

  // Expired, un-redeemed invitations. Their token digest is useless after
  // expiry; keeping the rows accumulates addresses that no longer mean anything.
  try {
    const deleted = await db
      .delete(ctlInvite)
      .where(
        and(
          lt(ctlInvite.expiresAt, new Date()),
          lt(ctlInvite.createdAt, new Date(Date.now() - 86_400_000)),
        ),
      )
      .returning({ id: ctlInvite.id });
    pruned.expiredInvites = deleted.length;
  } catch (error) {
    errors.push(`invites: ${error instanceof Error ? error.name : "unknown"}`);
  }

  try {
    const cutoff = new Date(Date.now() - AIOPS_RETENTION_DAYS * 86_400_000);
    const deleted = await db
      .delete(ctlAiopsSession)
      .where(and(lt(ctlAiopsSession.updatedAt, cutoff), lt(ctlAiopsSession.createdAt, cutoff)))
      .returning({ id: ctlAiopsSession.id });
    pruned.idleAssistantSessions = deleted.length;
  } catch (error) {
    errors.push(`aiops: ${error instanceof Error ? error.name : "unknown"}`);
  }

  const report: MaintenanceReport = {
    trigger,
    ranAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    pruned,
    errors,
  };

  // The audit row is the PROOF the run happened. Without it an operator cannot
  // distinguish "the scheduler ran and found nothing to do" from "it never ran".
  await recordAudit({
    action: auditActions.maintenanceRun,
    actorAdminId: actor?.adminId ?? null,
    actorEmail: actor?.email ?? "system",
    actorRole: actor?.role ?? null,
    entity: "maintenance",
    outcome: errors.length > 0 ? "error" : "success",
    requestId: actor?.requestId ?? null,
    detail: {
      trigger,
      pruned,
      errors,
      retentionDays: { loginAttempts: LOGIN_THROTTLE.retentionDays, aiops: AIOPS_RETENTION_DAYS },
    },
  });

  return report;
}

export function totalPruned(report: MaintenanceReport): number {
  return Object.values(report.pruned).reduce((sum, value) => sum + value, 0);
}
