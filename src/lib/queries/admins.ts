import { and, count, desc, eq, gt, isNull } from "drizzle-orm";
import { db } from "@/db";
import {
  ctlAdmin,
  ctlAuditLog,
  ctlInvite,
  ctlSession,
  type AdminRole,
} from "@/db/schema";

/** Read models for identity, invitations and sessions. */

export async function countAdmins() {
  const [row] = await db.select({ value: count() }).from(ctlAdmin);
  const [activeRow] = await db
    .select({ value: count() })
    .from(ctlAdmin)
    .where(eq(ctlAdmin.status, "active"));
  return { count: row?.value ?? 0, active: activeRow?.value ?? 0 };
}

export async function listAdmins() {
  return db
    .select({
      id: ctlAdmin.id,
      email: ctlAdmin.email,
      displayName: ctlAdmin.displayName,
      role: ctlAdmin.role,
      status: ctlAdmin.status,
      mfaEnrolledAt: ctlAdmin.mfaEnrolledAt,
      mfaRequired: ctlAdmin.mfaRequired,
      supabaseUserId: ctlAdmin.supabaseUserId,
      lastLoginAt: ctlAdmin.lastLoginAt,
      lastLoginIp: ctlAdmin.lastLoginIp,
      createdAt: ctlAdmin.createdAt,
    })
    .from(ctlAdmin)
    .orderBy(desc(ctlAdmin.createdAt));
}

export async function getAdminByEmail(email: string) {
  const rows = await db.select().from(ctlAdmin).where(eq(ctlAdmin.email, email.toLowerCase())).limit(1);
  return rows[0] ?? null;
}

export async function getAdminById(id: string) {
  const rows = await db.select().from(ctlAdmin).where(eq(ctlAdmin.id, id)).limit(1);
  return rows[0] ?? null;
}

/**
 * Records the Supabase Auth user id behind a control-plane administrator.
 *
 * The id is an opaque UUID — not an email — and it is the only end-user-shaped
 * identifier this platform stores. It exists so role lookups stay stable when
 * Supabase Auth is the identity provider.
 */
export async function linkSupabaseUser(adminId: string, supabaseUserId: string): Promise<void> {
  await db
    .update(ctlAdmin)
    .set({ supabaseUserId, updatedAt: new Date() })
    .where(eq(ctlAdmin.id, adminId));
}

/**
 * Activates a provisioned-but-invited administrator after their identity has
 * been verified by the external provider.
 *
 * Only ever called from the login route, and only after `identityProvider()`
 * has confirmed the password against Supabase Auth. It deliberately does not
 * create a local password hash: in this mode the credential lives in Supabase.
 */
export async function activateInvitedAdmin(adminId: string): Promise<void> {
  await db
    .update(ctlAdmin)
    .set({ status: "active", lastLoginAt: new Date(), updatedAt: new Date() })
    .where(eq(ctlAdmin.id, adminId));
}

export async function listInvites() {
  return db
    .select({
      id: ctlInvite.id,
      email: ctlInvite.email,
      role: ctlInvite.role,
      mfaRequired: ctlInvite.mfaRequired,
      invitedBy: ctlInvite.invitedBy,
      inviterEmail: ctlAdmin.email,
      expiresAt: ctlInvite.expiresAt,
      acceptedAt: ctlInvite.acceptedAt,
      revokedAt: ctlInvite.revokedAt,
      createdAt: ctlInvite.createdAt,
    })
    .from(ctlInvite)
    .leftJoin(ctlAdmin, eq(ctlAdmin.id, ctlInvite.invitedBy))
    .orderBy(desc(ctlInvite.createdAt));
}

export async function findPendingInviteByHash(tokenHash: string) {
  const now = new Date();
  const rows = await db
    .select()
    .from(ctlInvite)
    .where(
      and(
        eq(ctlInvite.tokenHash, tokenHash),
        isNull(ctlInvite.acceptedAt),
        isNull(ctlInvite.revokedAt),
        gt(ctlInvite.expiresAt, now),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function countPendingInvites() {
  const [row] = await db
    .select({ value: count() })
    .from(ctlInvite)
    .where(and(isNull(ctlInvite.acceptedAt), isNull(ctlInvite.revokedAt), gt(ctlInvite.expiresAt, new Date())));
  return row?.value ?? 0;
}

export async function mfaPosture() {
  const admins = await db
    .select({ id: ctlAdmin.id, role: ctlAdmin.role, mfaEnrolledAt: ctlAdmin.mfaEnrolledAt })
    .from(ctlAdmin)
    .where(eq(ctlAdmin.status, "active"));
  const enrolled = admins.filter((a) => a.mfaEnrolledAt !== null);
  const privileged: AdminRole[] = ["owner", "admin", "operator"];
  const unenrolledPrivileged = admins.filter(
    (a) => privileged.includes(a.role) && a.mfaEnrolledAt === null,
  );
  return {
    totalActive: admins.length,
    enrolled: enrolled.length,
    coveragePercent: admins.length === 0 ? 0 : Math.round((enrolled.length / admins.length) * 100),
    unenrolledPrivileged: unenrolledPrivileged.length,
  };
}

export async function recentAudit(limit = 12) {
  return db
    .select()
    .from(ctlAuditLog)
    .orderBy(desc(ctlAuditLog.ts))
    .limit(limit);
}

export async function activeSessionCount() {
  const [row] = await db
    .select({ value: count() })
    .from(ctlSession)
    .where(and(isNull(ctlSession.revokedAt), gt(ctlSession.expiresAt, new Date())));
  return row?.value ?? 0;
}
