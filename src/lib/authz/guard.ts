import { redirect } from "next/navigation";
import type { NextRequest } from "next/server";
import { getSession, type ActiveSession } from "@/lib/auth/session";
import { can } from "@/lib/authz/permissions";
import type { Capability } from "@/config/nav";
import { auditActions, recordAudit } from "@/lib/audit/logger";
import { clientIp, jsonError, newRequestId, userAgent } from "@/lib/http";
import { isPrivacyViolation } from "@/lib/privacy/guard";

/**
 * Every privileged surface goes through one of these three guards. There is no
 * page or route handler in this app that reads the session by hand.
 */

export async function requireSession(): Promise<ActiveSession> {
  const session = await getSession({ requireMfa: true });
  if (!session) redirect("/login");
  return session;
}

export async function requireCapability(capability: Capability): Promise<ActiveSession> {
  const session = await requireSession();
  if (!can(session.admin.role, capability)) {
    await recordAudit({
      action: auditActions.accessDenied,
      actorAdminId: session.admin.id,
      actorEmail: session.admin.email,
      actorRole: session.admin.role,
      entity: "capability",
      entityId: capability,
      outcome: "denied",
      detail: { surface: "page" },
    });
    redirect(`/dashboard?denied=${encodeURIComponent(capability)}`);
  }
  return session;
}

export type ApiAuth =
  | { ok: true; session: ActiveSession; requestId: string }
  | { ok: false; response: Response };

/**
 * Guard for route handlers. Denials are audited and return 403 with a request
 * id so an operator can find the exact audit row.
 */
export async function apiRequire(
  request: NextRequest | Request,
  capability: Capability,
): Promise<ApiAuth> {
  const requestId = newRequestId();
  const session = await getSession({ requireMfa: true });

  if (!session) {
    return { ok: false, response: jsonError("Authentication required.", 401, "unauthenticated", requestId) };
  }

  if (!can(session.admin.role, capability)) {
    await recordAudit({
      action: auditActions.accessDenied,
      actorAdminId: session.admin.id,
      actorEmail: session.admin.email,
      actorRole: session.admin.role,
      entity: "capability",
      entityId: capability,
      outcome: "denied",
      requestId,
      ip: clientIp(request),
      userAgent: userAgent(request),
      detail: { surface: "api", path: new URL(request.url).pathname, method: request.method },
    });
    return {
      ok: false,
      response: jsonError(
        `Your role (${session.admin.role}) does not hold "${capability}".`,
        403,
        "forbidden",
        requestId,
      ),
    };
  }

  return { ok: true, session, requestId };
}

/** Wraps a handler so privacy violations become 451 rather than a 500 leak. */
export async function withPrivacyGuard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (isPrivacyViolation(error)) {
      await recordAudit({
        action: auditActions.privacyViolation,
        outcome: "denied",
        detail: { reason: error.message },
      });
      throw error;
    }
    throw error;
  }
}
