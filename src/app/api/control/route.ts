import {
  auditActionFor,
  capabilityFor,
  controlActionSchema,
  executeControlAction,
  flattenZodError,
  httpStatusFor,
  isKnownAction,
  MFA_VERIFIED_REQUIRED,
  knownActions,
} from "@/lib/api/control-actions";
import { auditActions, recordAudit } from "@/lib/audit/logger";
import { csrfFailureResponse } from "@/lib/auth/csrf";
import { apiRequire } from "@/lib/authz/guard";
import { clientIp, jsonError, jsonOk, userAgent } from "@/lib/http";
import { isPrivacyViolation } from "@/lib/privacy/guard";

export const dynamic = "force-dynamic";

/**
 * Single authorized mutation endpoint for the whole console.
 *
 * Order of operations is fixed: parse → authenticate → authorize → execute →
 * audit. The audit write happens for successes, denials AND failures, so a
 * rejected attempt is as traceable as a completed one.
 */
export async function POST(request: Request) {
  const ip = clientIp(request);
  const agent = userAgent(request);

  // CSRF is the FIRST gate, before the body is even parsed. Checking it after
  // validation would let a cross-site request probe which actions exist and
  // which payloads are well-formed using the victim's cookie.
  const csrfFailure = csrfFailureResponse(request);
  if (csrfFailure) {
    await recordAudit({
      action: auditActions.csrfRejected,
      entity: "csrf",
      outcome: "denied",
      ip,
      userAgent: agent,
      detail: { path: "/api/control" },
    });
    return csrfFailure;
  }

  const raw = await request.json().catch(() => null);

  // Reject an unknown action pair with a precise message. Otherwise a union
  // validation failure would report whichever branch happened to be closest,
  // which names fields the caller never sent.
  const candidate = raw as { resource?: unknown; operation?: unknown } | null;
  if (!isKnownAction(candidate?.resource, candidate?.operation)) {
    return jsonError(
      `Unknown control action "${String(candidate?.resource ?? "")}:${String(candidate?.operation ?? "")}". Known actions: ${knownActions().join(", ")}.`,
      400,
      "unknown_action",
    );
  }

  const parsed = controlActionSchema.safeParse(raw);
  if (!parsed.success) {
    return jsonError(flattenZodError(parsed.error), 400, "invalid_input");
  }

  const action = parsed.data;
  const capability = capabilityFor(action.resource, action.operation);
  const auth = await apiRequire(request, capability);
  if (!auth.ok) return auth.response;

  const { session, requestId } = auth;
  const actor = {
    adminId: session.admin.id,
    email: session.admin.email,
    role: session.admin.role,
    ip,
    userAgent: agent,
    requestId,
    mfaVerified: session.session.mfaVerified,
  };

  // Some resources require a session that ACTUALLY completed a second-factor
  // challenge. Two conditions, and both matter:
  //
  //   session.mfaVerified  — a challenge was passed on this session
  //   admin.mfaEnrolledAt  — the account has a factor at all
  //
  // Checking only the first is not enough, and live testing proved it: a session
  // is created with mfaVerified=true when the account has no factor enrolled
  // (nothing to verify), so a vault write sailed straight through to the
  // Management API. Requiring an enrolled factor closes that, which is what
  // "owner authorization, MFA and confirmation for destructive actions" means.
  const needsVerifiedMfa = MFA_VERIFIED_REQUIRED.has(action.resource);
  const mfaSatisfied = session.session.mfaVerified && session.admin.mfaEnrolledAt !== null;
  if (needsVerifiedMfa && !mfaSatisfied) {
    const reason = session.admin.mfaEnrolledAt === null ? "mfa_not_enrolled" : "mfa_not_verified";
    await recordAudit({
      action: auditActions.accessDenied,
      actorAdminId: actor.adminId,
      actorEmail: actor.email,
      actorRole: actor.role,
      entity: action.resource,
      entityId: action.operation,
      outcome: "denied",
      requestId,
      ip,
      userAgent: agent,
      detail: { reason, resource: action.resource, operation: action.operation },
    });
    return jsonError(
      reason === "mfa_not_enrolled"
        ? "This action requires multi-factor authentication, and no TOTP factor is enrolled on this account. Enrol one from Security, then sign in again."
        : "This action requires a session that has completed a multi-factor challenge. Sign in again and pass the TOTP prompt.",
      403,
      "mfa_required",
      requestId,
    );
  }

  try {
    const result = await executeControlAction(action, actor);

    await recordAudit({
      action: auditActionFor(action.resource, action.operation),
      actorAdminId: actor.adminId,
      actorEmail: actor.email,
      actorRole: actor.role,
      entity: result.entity,
      entityId: result.entityId,
      outcome: "success",
      requestId,
      ip,
      userAgent: agent,
      detail: { resource: action.resource, operation: action.operation, ...result.detail },
    });

    return jsonOk({ summary: result.summary, assistant: result.assistant ?? null, ...(result.responseOnly ?? {}) }, 200, requestId);
  } catch (error) {
    const { status, code } = httpStatusFor(error);
    const message = error instanceof Error ? error.message : "Unexpected error.";

    await recordAudit({
      action: isPrivacyViolation(error) ? "privacy.violation" : auditActionFor(action.resource, action.operation),
      actorAdminId: actor.adminId,
      actorEmail: actor.email,
      actorRole: actor.role,
      entity: action.resource,
      entityId: null,
      outcome: status === 403 || status === 451 ? "denied" : "error",
      requestId,
      ip,
      userAgent: agent,
      detail: {
        resource: action.resource,
        operation: action.operation,
        code,
        reason: message.slice(0, 400),
      },
    });

    return jsonError(message, status, code, requestId);
  }
}
