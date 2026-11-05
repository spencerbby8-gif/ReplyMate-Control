import { cookies } from "next/headers";
import { and, eq, gt, isNull, lt, or } from "drizzle-orm";
import { db } from "@/db";
import { ctlAdmin, ctlSession, type CtlAdmin } from "@/db/schema";
import { env } from "@/config/env";
import { generateToken, digestToken } from "./crypto";

/**
 * Opaque-cookie sessions.
 *
 * The cookie carries 256 bits of CSPRNG output; only its SHA-256 digest is
 * stored. A database leak therefore yields no usable sessions. Sessions carry
 * an `mfaVerified` flag — an unverified session is a *partial* session that can
 * only reach the MFA challenge endpoint.
 */

export const SESSION_COOKIE = env.SESSION_COOKIE_NAME;
const TTL_MS = env.SESSION_TTL_HOURS * 60 * 60 * 1000;
/**
 * Absolute ceiling on a session's life, independent of activity.
 *
 * Without this, a sliding session that is used at least once per TTL never dies
 * — so a stolen cookie stays valid indefinitely as long as the thief keeps using
 * it. Idle expiry alone does not cover that case.
 */
const ABSOLUTE_TTL_MS = env.SESSION_ABSOLUTE_TTL_HOURS * 60 * 60 * 1000;

export const LOCKOUT = {
  maxFailedAttempts: 5,
  lockMinutes: 15,
} as const;

export type ActiveSession = {
  admin: CtlAdmin;
  session: typeof ctlSession.$inferSelect;
};

function cookieOptions(expiresAt: Date) {
  return {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    expires: expiresAt,
  };
}

export async function createSession(
  adminId: string,
  context: { ip?: string | null; userAgent?: string | null; mfaVerified?: boolean },
) {
  const token = generateToken();
  const createdAt = Date.now();
  // Idle expiry can never be configured past the absolute ceiling.
  const expiresAt = new Date(Math.min(createdAt + TTL_MS, createdAt + ABSOLUTE_TTL_MS));

  await db.insert(ctlSession).values({
    adminId,
    tokenHash: digestToken(token),
    ip: context.ip ?? null,
    userAgent: context.userAgent ? context.userAgent.slice(0, 400) : null,
    mfaVerified: context.mfaVerified ?? false,
    expiresAt,
  });

  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, cookieOptions(expiresAt));
  return { expiresAt };
}

/** Reads the current session. Returns null for anonymous or expired sessions. */
export async function getSession(options?: {
  requireMfa?: boolean;
}): Promise<ActiveSession | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const now = Date.now();
  const rows = await db
    .select({ admin: ctlAdmin, session: ctlSession })
    .from(ctlSession)
    .innerJoin(ctlAdmin, eq(ctlAdmin.id, ctlSession.adminId))
    .where(
      and(
        eq(ctlSession.tokenHash, digestToken(token)),
        isNull(ctlSession.revokedAt),
        gt(ctlSession.expiresAt, new Date(now)),
        // Absolute ceiling: a continuously-used session still dies.
        gt(ctlSession.createdAt, new Date(now - ABSOLUTE_TTL_MS)),
        eq(ctlAdmin.status, "active"),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  // A session is only fully privileged once MFA is verified, whenever the
  // account has an enrolled factor OR the org policy requires one.
  const needsMfa = Boolean(row.admin.mfaEnrolledAt) || row.admin.mfaRequired;
  if (options?.requireMfa && needsMfa && !row.session.mfaVerified) return null;

  // Sliding refresh (fire-and-forget is intentional; failure must not log out).
  db.update(ctlSession)
    .set({ lastSeenAt: new Date() })
    .where(eq(ctlSession.id, row.session.id))
    .catch(() => undefined);

  return row;
}

export async function markSessionMfaVerified(sessionId: string) {
  const [session] = await db
    .select({ createdAt: ctlSession.createdAt })
    .from(ctlSession)
    .where(eq(ctlSession.id, sessionId));
  const now = Date.now();
  // MFA verification extends the idle window but must not extend the session
  // past its absolute ceiling.
  const absoluteDeadline = session ? session.createdAt.getTime() + ABSOLUTE_TTL_MS : now + ABSOLUTE_TTL_MS;
  const expiresAt = new Date(Math.min(now + TTL_MS, absoluteDeadline));
  await db
    .update(ctlSession)
    .set({ mfaVerified: true, expiresAt })
    .where(eq(ctlSession.id, sessionId));
  const jar = await cookies();
  const existing = jar.get(SESSION_COOKIE)?.value;
  if (existing) jar.set(SESSION_COOKIE, existing, cookieOptions(expiresAt));
}

export async function destroySession() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) {
    await db
      .update(ctlSession)
      .set({ revokedAt: new Date() })
      .where(eq(ctlSession.tokenHash, digestToken(token)));
  }
  jar.delete(SESSION_COOKIE);
}

export async function revokeSessionById(sessionId: string) {
  await db.update(ctlSession).set({ revokedAt: new Date() }).where(eq(ctlSession.id, sessionId));
}

export async function revokeAllSessionsForAdmin(adminId: string) {
  await db
    .update(ctlSession)
    .set({ revokedAt: new Date() })
    .where(and(eq(ctlSession.adminId, adminId), isNull(ctlSession.revokedAt)));
}

export async function listActiveSessions(adminId?: string) {
  const conditions = [isNull(ctlSession.revokedAt), gt(ctlSession.expiresAt, new Date())];
  if (adminId) conditions.push(eq(ctlSession.adminId, adminId));
  return db
    .select({
      id: ctlSession.id,
      adminId: ctlSession.adminId,
      email: ctlAdmin.email,
      ip: ctlSession.ip,
      userAgent: ctlSession.userAgent,
      mfaVerified: ctlSession.mfaVerified,
      createdAt: ctlSession.createdAt,
      lastSeenAt: ctlSession.lastSeenAt,
      expiresAt: ctlSession.expiresAt,
    })
    .from(ctlSession)
    .innerJoin(ctlAdmin, eq(ctlAdmin.id, ctlSession.adminId))
    .where(and(...conditions))
    .orderBy(ctlSession.lastSeenAt);
}

export async function purgeExpiredSessions() {
  const result = await db
    .delete(ctlSession)
    .where(
      or(lt(ctlSession.expiresAt, new Date()), lt(ctlSession.createdAt, new Date(Date.now() - 30 * 864e5))),
    )
    .returning({ id: ctlSession.id });
  return result.length;
}

/**
 * Login throttle state for an account.
 *
 * A lock that has already expired is reported separately: the failure counter
 * must be treated as reset, otherwise the very next failure re-locks the account
 * instantly and the user never gets a fresh set of attempts.
 */
export function lockoutState(admin: Pick<CtlAdmin, "failedLoginCount" | "lockedUntil">) {
  const now = Date.now();
  const locked = Boolean(admin.lockedUntil && admin.lockedUntil.getTime() > now);
  const expiredLock = Boolean(admin.lockedUntil && admin.lockedUntil.getTime() <= now);
  const effectiveCount = expiredLock ? 0 : admin.failedLoginCount;
  return {
    locked,
    expiredLock,
    effectiveCount,
    remainingAttempts: locked ? 0 : Math.max(0, LOCKOUT.maxFailedAttempts - effectiveCount),
    lockedUntil: locked ? admin.lockedUntil : null,
  };
}

export async function registerFailedLogin(adminId: string, currentCount: number) {
  const next = currentCount + 1;
  const shouldLock = next >= LOCKOUT.maxFailedAttempts;
  await db
    .update(ctlAdmin)
    .set({
      failedLoginCount: next,
      lockedUntil: shouldLock ? new Date(Date.now() + LOCKOUT.lockMinutes * 60_000) : null,
      updatedAt: new Date(),
    })
    .where(eq(ctlAdmin.id, adminId));
  return { locked: shouldLock, attempts: next };
}

export async function clearFailedLogin(adminId: string) {
  await db
    .update(ctlAdmin)
    .set({
      failedLoginCount: 0,
      lockedUntil: null,
      lastLoginAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(ctlAdmin.id, adminId));
}
