import { createHmac } from "node:crypto";
import { and, count, countDistinct, eq, gte, lt, ne } from "drizzle-orm";
import { db } from "@/db";
import { ctlLoginAttempt } from "@/db/schema";

/**
 * Source-level login throttling.
 *
 * `ctl_admin.failed_login_count` protects ONE account. This protects the
 * service: it caps how many failures a single network source may produce in a
 * window, and how many *distinct* accounts it may probe — which is what turns
 * password guessing into account enumeration.
 *
 * Backed by the database rather than process memory, so it survives restarts and
 * stays coherent across instances. The cost is one indexed count per attempt,
 * which is cheap next to the scrypt work already being done.
 */

export const LOGIN_THROTTLE = {
  /** Rolling observation window. */
  windowMinutes: 15,
  /** Failures from one source before it is refused. */
  maxFailuresPerSource: 20,
  /** Distinct accounts one source may fail against before it is refused. */
  maxDistinctTargets: 8,
  /** How long a tripped source stays refused. */
  cooldownMinutes: 30,
  /** Attempts older than this are prunable. */
  retentionDays: 7,
} as const;

export type ThrottleLimits = {
  windowMinutes: number;
  maxFailuresPerSource: number;
  maxDistinctTargets: number;
  cooldownMinutes: number;
};

export type ThrottleDecision =
  | { limited: false; failures: number; distinctTargets: number; retryAfterSeconds: 0; reason: null }
  | { limited: true; failures: number; distinctTargets: number; retryAfterSeconds: number; reason: string };

const SOURCE_PEPPER = "rmctl-throttle-source";
const EMAIL_PEPPER = "rmctl-throttle-email";

/**
 * A stable, non-reversible digest of the request source.
 *
 * Deliberately NOT the raw IP: the throttle needs to *group* attempts, not build
 * a location history. The user-agent prefix is mixed in, which means a shared NAT
 * is throttled as one source — an accepted trade-off, recorded in
 * docs/SECURITY.md rather than left implicit.
 */
export function sourceDigest(ip: string | null, userAgent: string | null): string {
  const normalizedIp = (ip ?? "unknown").trim().toLowerCase();
  const agentClass = (userAgent ?? "unknown").slice(0, 40);
  return createHmac("sha256", SOURCE_PEPPER).update(`${normalizedIp}|${agentClass}`).digest("hex");
}

/** Digest of the attempted address, so distinct targets can be counted without storing them. */
export function emailDigest(email: string): string {
  return createHmac("sha256", EMAIL_PEPPER).update(email.trim().toLowerCase()).digest("hex");
}

/**
 * Pure evaluation of a throttle decision from observed counts.
 *
 * Split out from the database read so the policy is unit-testable without a
 * connection, and so the arithmetic cannot drift from the documented limits.
 */
export function evaluateThrottle(
  failures: number,
  distinctTargets: number,
  limits: ThrottleLimits = LOGIN_THROTTLE,
): ThrottleDecision {
  const overTargets = distinctTargets >= limits.maxDistinctTargets;
  const overFailures = failures >= limits.maxFailuresPerSource;

  if (!overFailures && !overTargets) {
    return { limited: false, failures, distinctTargets, retryAfterSeconds: 0, reason: null };
  }

  return {
    limited: true,
    failures,
    distinctTargets,
    retryAfterSeconds: limits.cooldownMinutes * 60,
    reason: overTargets
      ? `Too many distinct accounts attempted from this source (${distinctTargets} in ${limits.windowMinutes} minutes).`
      : `Too many failed sign-ins from this source (${failures} in ${limits.windowMinutes} minutes).`,
  };
}

export async function checkLoginThrottle(ip: string | null, userAgent: string | null): Promise<ThrottleDecision> {
  const digest = sourceDigest(ip, userAgent);
  const since = new Date(Date.now() - LOGIN_THROTTLE.windowMinutes * 60_000);

  const [row] = await db
    .select({
      failures: count(),
      distinctTargets: countDistinct(ctlLoginAttempt.emailDigest),
    })
    .from(ctlLoginAttempt)
    .where(
      and(
        eq(ctlLoginAttempt.sourceDigest, digest),
        gte(ctlLoginAttempt.ts, since),
        // Only failures count against a source; a success resets it.
        ne(ctlLoginAttempt.outcome, "success"),
      ),
    );

  return evaluateThrottle(row?.failures ?? 0, row?.distinctTargets ?? 0);
}

export async function recordLoginAttempt(input: {
  ip: string | null;
  userAgent: string | null;
  email: string;
  outcome: "success" | "failure" | "locked";
  reason?: string;
}): Promise<void> {
  try {
    await db.insert(ctlLoginAttempt).values({
      sourceDigest: sourceDigest(input.ip, input.userAgent),
      emailDigest: emailDigest(input.email),
      outcome: input.outcome,
      reason: input.reason?.slice(0, 120) ?? null,
    });
  } catch {
    // Throttle bookkeeping must never be the reason a sign-in fails.
  }
}

/** Removes throttle rows past the retention window. Returns rows deleted. */
export async function pruneLoginAttempts(): Promise<number> {
  const cutoff = new Date(Date.now() - LOGIN_THROTTLE.retentionDays * 86_400_000);
  const deleted = await db
    .delete(ctlLoginAttempt)
    .where(lt(ctlLoginAttempt.ts, cutoff))
    .returning({ id: ctlLoginAttempt.id });
  return deleted.length;
}

/** Current throttle posture for the Security page. Counts only — no digests. */
export async function throttlePosture() {
  const since = new Date(Date.now() - LOGIN_THROTTLE.windowMinutes * 60_000);
  const [row] = await db
    .select({ failures: count(), sources: countDistinct(ctlLoginAttempt.sourceDigest) })
    .from(ctlLoginAttempt)
    .where(and(gte(ctlLoginAttempt.ts, since), ne(ctlLoginAttempt.outcome, "success")));
  return {
    windowMinutes: LOGIN_THROTTLE.windowMinutes,
    failuresInWindow: row?.failures ?? 0,
    sourcesInWindow: row?.sources ?? 0,
    maxFailuresPerSource: LOGIN_THROTTLE.maxFailuresPerSource,
    maxDistinctTargets: LOGIN_THROTTLE.maxDistinctTargets,
    cooldownMinutes: LOGIN_THROTTLE.cooldownMinutes,
  };
}
