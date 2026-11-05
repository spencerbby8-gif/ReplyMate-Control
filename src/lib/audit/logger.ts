import { db } from "@/db";
import { ctlAuditLog, type AuditOutcome } from "@/db/schema";
import { redactValue } from "./redact";

/**
 * Append-only audit trail.
 *
 * There is intentionally no update or delete function in this module and no API
 * route that can mutate `ctl_audit_log`. Failures to write are surfaced to the
 * caller (a privileged action that cannot be recorded must not silently pass).
 */

export const auditActions = {
  // auth
  authLoginSuccess: "auth.login.success",
  authLoginFailed: "auth.login.failed",
  authAccountLocked: "auth.account.locked",
  authMfaSuccess: "auth.mfa.success",
  authMfaFailed: "auth.mfa.failed",
  authMfaEnrolled: "auth.mfa.enrolled",
  authLogout: "auth.logout",
  authSessionRevoked: "auth.session.revoked",
  authBootstrapOwner: "auth.bootstrap.owner",
  // invites
  inviteCreated: "invite.created",
  inviteRevoked: "invite.revoked",
  inviteAccepted: "invite.accepted",
  // users
  userRoleChanged: "user.role.changed",
  userStatusChanged: "user.status.changed",
  userDeleted: "user.deleted",
  // config surface
  flagCreated: "flag.created",
  flagUpdated: "flag.updated",
  flagDeleted: "flag.deleted",
  providerUpdated: "provider.updated",
  routeCreated: "route.created",
  routeUpdated: "route.updated",
  routeDeleted: "route.deleted",
  configUpdated: "config.updated",
  releaseCreated: "release.created",
  releaseUpdated: "release.updated",
  ticketCreated: "ticket.created",
  ticketUpdated: "ticket.updated",
  planUpdated: "plan.updated",
  // ops
  monitorProbeRun: "monitor.probe.run",
  aiopsInvoked: "aiops.tool.invoked",
  // guardrails
  accessDenied: "authz.denied",
  privacyViolation: "privacy.violation",
  supabaseRead: "supabase.read",
} as const;

export type AuditAction = (typeof auditActions)[keyof typeof auditActions];

export type AuditContext = {
  actorAdminId?: string | null;
  actorEmail?: string | null;
  actorRole?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
};

export type AuditEntry = AuditContext & {
  action: AuditAction | string;
  entity?: string | null;
  entityId?: string | null;
  outcome?: AuditOutcome;
  detail?: Record<string, unknown> | null;
};

export async function recordAudit(entry: AuditEntry): Promise<{ id: number } | { error: string }> {
  try {
    const inserted = await db
      .insert(ctlAuditLog)
      .values({
        actorAdminId: entry.actorAdminId ?? null,
        actorEmail: entry.actorEmail ?? null,
        actorRole: entry.actorRole ?? null,
        action: entry.action,
        entity: entry.entity ?? null,
        entityId: entry.entityId ?? null,
        outcome: entry.outcome ?? "success",
        detail: entry.detail ? (redactValue(entry.detail) as Record<string, unknown>) : null,
        ip: entry.ip ?? null,
        userAgent: entry.userAgent ? entry.userAgent.slice(0, 400) : null,
        requestId: entry.requestId ?? null,
      })
      .returning({ id: ctlAuditLog.id });
    return { id: inserted[0]?.id ?? 0 };
  } catch (error) {
    // Log the failure class only — never the detail payload.
    console.error("[audit] write failed", { reason: error instanceof Error ? error.name : "unknown" });
    return { error: error instanceof Error ? error.name : "unknown" };
  }
}
