import { and, count, desc, eq, gte, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  ctlAiProvider,
  ctlAiopsMessage,
  ctlAiopsSession,
  ctlAuditLog,
  ctlConfigItem,
  ctlDevice,
  ctlFeatureFlag,
  ctlModelRoute,
  ctlMonitorProbe,
  ctlPlan,
  ctlRelease,
  ctlSubscription,
  ctlSupportTicket,
} from "@/db/schema";

/** Read models for every operational page. Read-only; no mutation lives here. */

export async function listFeatureFlags() {
  return db.select().from(ctlFeatureFlag).orderBy(ctlFeatureFlag.key);
}

export async function listProviders() {
  return db.select().from(ctlAiProvider).orderBy(ctlAiProvider.key);
}

export async function listRoutes() {
  return db
    .select()
    .from(ctlModelRoute)
    .orderBy(ctlModelRoute.task, ctlModelRoute.priority);
}

export async function listReleases() {
  return db.select().from(ctlRelease).orderBy(desc(ctlRelease.versionCode));
}

export async function listDevices() {
  return db.select().from(ctlDevice).orderBy(desc(ctlDevice.lastSeenAt));
}

export async function listPlans() {
  return db.select().from(ctlPlan).orderBy(ctlPlan.priceMinor);
}

export async function listSubscriptions() {
  return db.select().from(ctlSubscription).orderBy(desc(ctlSubscription.createdAt)).limit(200);
}

export async function listConfig() {
  return db.select().from(ctlConfigItem).orderBy(ctlConfigItem.category, ctlConfigItem.key);
}

export async function listTickets() {
  return db.select().from(ctlSupportTicket).orderBy(desc(ctlSupportTicket.createdAt));
}

export async function listAudit(options?: { limit?: number; action?: string; actorId?: string }) {
  const conditions = [];
  if (options?.action) conditions.push(eq(ctlAuditLog.action, options.action));
  if (options?.actorId) conditions.push(eq(ctlAuditLog.actorAdminId, options.actorId));
  const query = db
    .select()
    .from(ctlAuditLog)
    .orderBy(desc(ctlAuditLog.ts))
    .limit(options?.limit ?? 100);
  return conditions.length > 0
    ? db.select().from(ctlAuditLog).where(and(...conditions)).orderBy(desc(ctlAuditLog.ts)).limit(options?.limit ?? 100)
    : query;
}

export async function distinctAuditActions() {
  const rows = await db
    .selectDistinct({ action: ctlAuditLog.action })
    .from(ctlAuditLog);
  return rows.map((r) => r.action).sort();
}

export async function listProbes(limitPerTarget = 20) {
  return db
    .select()
    .from(ctlMonitorProbe)
    .orderBy(desc(ctlMonitorProbe.checkedAt))
    .limit(limitPerTarget * 12);
}

export async function latestProbePerTarget() {
  const rows = await db
    .select({
      target: ctlMonitorProbe.target,
      kind: ctlMonitorProbe.kind,
      status: ctlMonitorProbe.status,
      latencyMs: ctlMonitorProbe.latencyMs,
      httpStatus: ctlMonitorProbe.httpStatus,
      message: ctlMonitorProbe.message,
      checkedAt: ctlMonitorProbe.checkedAt,
    })
    .from(ctlMonitorProbe)
    .orderBy(desc(ctlMonitorProbe.checkedAt))
    .limit(500);
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (seen.has(row.target)) return false;
    seen.add(row.target);
    return true;
  });
}

export async function listAiopsSessions(adminId: string) {
  return db
    .select()
    .from(ctlAiopsSession)
    .where(eq(ctlAiopsSession.adminId, adminId))
    .orderBy(desc(ctlAiopsSession.updatedAt))
    .limit(25);
}

export async function listAiopsMessages(sessionId: string) {
  return db
    .select()
    .from(ctlAiopsMessage)
    .where(eq(ctlAiopsMessage.sessionId, sessionId))
    .orderBy(ctlAiopsMessage.createdAt)
    .limit(200);
}

export async function auditStats() {
  const since = new Date(Date.now() - 7 * 864e5);
  const [total] = await db.select({ value: count() }).from(ctlAuditLog);
  const [week] = await db.select({ value: count() }).from(ctlAuditLog).where(gte(ctlAuditLog.ts, since));
  const [denied] = await db
    .select({ value: count() })
    .from(ctlAuditLog)
    .where(eq(ctlAuditLog.outcome, "denied"));
  const [privacy] = await db
    .select({ value: count() })
    .from(ctlAuditLog)
    .where(eq(ctlAuditLog.action, "privacy.violation"));
  return {
    total: total?.value ?? 0,
    last7Days: week?.value ?? 0,
    denied: denied?.value ?? 0,
    privacyViolations: privacy?.value ?? 0,
  };
}

export async function flagStats() {
  const rows = await db.select({ status: ctlFeatureFlag.status }).from(ctlFeatureFlag);
  return {
    total: rows.length,
    on: rows.filter((r) => r.status === "on").length,
    canary: rows.filter((r) => r.status === "canary").length,
    shadow: rows.filter((r) => r.status === "shadow").length,
    off: rows.filter((r) => r.status === "off").length,
  };
}

export async function releaseStats() {
  const rows = await db
    .select({ status: ctlRelease.status, versionCode: ctlRelease.versionCode, versionName: ctlRelease.versionName })
    .from(ctlRelease)
    .orderBy(desc(ctlRelease.versionCode));
  return {
    total: rows.length,
    published: rows.filter((r) => r.status === "published").length,
    broken: rows.filter((r) => r.status === "broken").length,
    latest: rows[0] ?? null,
  };
}

export async function routeStats() {
  const rows = await db.select({ task: ctlModelRoute.task, enabled: ctlModelRoute.enabled }).from(ctlModelRoute);
  return {
    total: rows.length,
    enabled: rows.filter((r) => r.enabled).length,
    tasksCovered: new Set(rows.map((r) => r.task)).size,
  };
}

export async function subscriptionStats() {
  const [rows] = await db.select({ value: count() }).from(ctlSubscription);
  const [active] = await db
    .select({ value: count() })
    .from(ctlSubscription)
    .where(eq(ctlSubscription.status, "active"));
  return { total: rows?.value ?? 0, active: active?.value ?? 0 };
}

export async function ticketStats() {
  const rows = await db.select({ status: ctlSupportTicket.status }).from(ctlSupportTicket);
  return {
    total: rows.length,
    open: rows.filter((r) => r.status === "open" || r.status === "triaged" || r.status === "waiting").length,
    resolved: rows.filter((r) => r.status === "resolved" || r.status === "closed").length,
  };
}

export async function deviceStats() {
  const [rows] = await db.select({ value: count() }).from(ctlDevice);
  return { total: rows?.value ?? 0 };
}

export async function configStats() {
  const rows = await db.select({ locked: ctlConfigItem.locked }).from(ctlConfigItem);
  return { total: rows.length, locked: rows.filter((r) => r.locked).length };
}

export async function providerStats() {
  const rows = await db.select({ status: ctlAiProvider.status }).from(ctlAiProvider);
  return {
    total: rows.length,
    available: rows.filter((r) => r.status === "available").length,
    degraded: rows.filter((r) => r.status === "degraded").length,
    unconfigured: rows.filter((r) => r.status === "unconfigured").length,
  };
}
