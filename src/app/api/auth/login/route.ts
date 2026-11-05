import { z } from "zod";
import { auditActions, recordAudit } from "@/lib/audit/logger";
import {
  clearFailedLogin,
  createSession,
  lockoutState,
  registerFailedLogin,
} from "@/lib/auth/session";
import { identityProvider } from "@/lib/auth/identity";
import { checkLoginThrottle, recordLoginAttempt } from "@/lib/auth/rate-limit";
import { verifyCsrf } from "@/lib/auth/csrf";
import { clientIp, jsonError, jsonOk, newRequestId, userAgent } from "@/lib/http";
import { getAdminByEmail } from "@/lib/queries/admins";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(512),
});

/**
 * Sign-in.
 *
 * Four checks, in this order, each failing closed:
 *   1. CSRF     — a cross-site request never reaches credential verification.
 *   2. Throttle — source-level limits, so one client cannot probe many accounts.
 *   3. Identity — local scrypt hash OR Supabase Auth, per AUTH_PROVIDER. Never a
 *                 silent fallback from one to the other.
 *   4. Lockout  — per-account, with an expired lock treated as a reset counter.
 *
 * Failures 2–4 return the SAME body for unknown-account and wrong-password, so
 * there is no account-existence oracle. Throttle and provider-unavailable
 * responses are distinct on purpose: they describe the service, not the account.
 */
export async function POST(request: Request) {
  const requestId = newRequestId();
  const ip = clientIp(request);
  const agent = userAgent(request);

  const csrf = verifyCsrf(request.method, request.headers, new URL(request.url).host);
  if (!csrf.ok) {
    await recordAudit({
      action: auditActions.authLoginFailed,
      entity: "csrf",
      outcome: "denied",
      requestId,
      ip,
      userAgent: agent,
      detail: { reason: "csrf_rejected" },
    });
    return jsonError(csrf.reason, 403, "csrf_rejected", requestId);
  }

  const throttle = await checkLoginThrottle(ip, agent);
  if (throttle.limited) {
    await recordAudit({
      action: auditActions.authThrottled,
      entity: "login_throttle",
      outcome: "denied",
      requestId,
      ip,
      userAgent: agent,
      detail: { failures: throttle.failures, distinctTargets: throttle.distinctTargets },
    });
    return Response.json(
      { error: throttle.reason, code: "rate_limited", requestId },
      { status: 429, headers: { "retry-after": String(throttle.retryAfterSeconds), "cache-control": "no-store" } },
    );
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return jsonError("Email and password are required.", 400, "invalid_input", requestId);
  }

  const email = parsed.data.email.toLowerCase();
  const provider = identityProvider();
  const providerState = provider.isConfigured();

  if (provider.name === "supabase" && !providerState.configured) {
    await recordAudit({
      action: auditActions.authLoginFailed,
      actorEmail: email,
      entity: "identity_provider",
      outcome: "error",
      requestId,
      ip,
      userAgent: agent,
      detail: { reason: "provider_unavailable", provider: provider.name },
    });
    return jsonError(
      "AUTH_PROVIDER=supabase but Supabase Auth is not configured. Sign-in is refused rather than silently falling back to local password hashes.",
      503,
      "provider_unavailable",
      requestId,
    );
  }

  const admin = await getAdminByEmail(email);

  const deny = async (reason: string, code: string) => {
    await recordLoginAttempt({ ip, userAgent: agent, email, outcome: "failure", reason });
    await recordAudit({
      action: auditActions.authLoginFailed,
      actorAdminId: admin?.id ?? null,
      actorEmail: email,
      actorRole: admin?.role ?? null,
      entity: "admin",
      entityId: admin?.id ?? null,
      outcome: "error",
      requestId,
      ip,
      userAgent: agent,
      detail: { reason, provider: provider.name },
    });
    return jsonError("Email or password is incorrect.", 401, code, requestId);
  };

  if (!admin) return deny("unknown_account", "invalid_credentials");

  // A suspended account is always refused. An `invited` account is refused in
  // local mode (it must redeem its link first, which sets the password) but is
  // allowed through in supabase mode, because there the password is set via
  // Supabase's own email link and the first *verified* sign-in is what activates
  // the row.
  if (admin.status === "suspended") return deny("account_suspended", "account_not_active");
  if (admin.status === "invited" && provider.name !== "supabase") {
    return deny("invitation_not_redeemed", "account_not_active");
  }

  const lock = lockoutState(admin);
  if (lock.locked) {
    await recordLoginAttempt({ ip, userAgent: agent, email, outcome: "locked", reason: "account_locked" });
    await recordAudit({
      action: auditActions.authAccountLocked,
      actorAdminId: admin.id,
      actorEmail: admin.email,
      actorRole: admin.role,
      entity: "admin",
      entityId: admin.id,
      outcome: "denied",
      requestId,
      ip,
      userAgent: agent,
      detail: { lockedUntil: lock.lockedUntil?.toISOString() ?? null },
    });
    return jsonError(
      `Account locked until ${lock.lockedUntil?.toISOString() ?? "a later time"}.`,
      423,
      "account_locked",
      requestId,
    );
  }

  // 3. Identity verification -------------------------------------------------
  let passwordValid = false;
  let externalUserId: string | null = null;

  if (provider.name === "supabase") {
    const result = await provider.verify(email, parsed.data.password);
    if (!result.ok) {
      if (result.code === "upstream_error") {
        await recordLoginAttempt({ ip, userAgent: agent, email, outcome: "failure", reason: "upstream_error" });
        await recordAudit({
          action: auditActions.authLoginFailed,
          actorAdminId: admin.id,
          actorEmail: admin.email,
          actorRole: admin.role,
          entity: "admin",
          entityId: admin.id,
          outcome: "error",
          requestId,
          ip,
          userAgent: agent,
          detail: { reason: "supabase_unreachable", provider: provider.name },
        });
        return jsonError(
          "Supabase Auth could not be reached. Sign-in is unavailable rather than downgraded.",
          503,
          "provider_unavailable",
          requestId,
        );
      }
      return deny(result.code, "invalid_credentials");
    }
    passwordValid = true;
    externalUserId = result.externalUserId;
  } else {
    // Local strategy: verify against the stored scrypt hash. A row with no hash
    // is an unredeemed invitation, not a password-less account.
    if (!admin.passwordHash) return deny("no_password_set", "invitation_incomplete");
    const { verifyLocal } = await import("@/lib/auth/identity");
    passwordValid = await verifyLocal(parsed.data.password, admin.passwordHash);
  }

  if (!passwordValid) {
    // An expired lock resets the counter so the account gets a fresh set of
    // attempts instead of re-locking on the very next failure.
    const result = await registerFailedLogin(admin.id, lock.effectiveCount);
    await recordLoginAttempt({
      ip,
      userAgent: agent,
      email,
      outcome: result.locked ? "locked" : "failure",
      reason: result.locked ? "account_locked" : "bad_password",
    });
    await recordAudit({
      action: result.locked ? auditActions.authAccountLocked : auditActions.authLoginFailed,
      actorAdminId: admin.id,
      actorEmail: admin.email,
      actorRole: admin.role,
      entity: "admin",
      entityId: admin.id,
      outcome: result.locked ? "denied" : "error",
      requestId,
      ip,
      userAgent: agent,
      detail: { attempts: result.attempts, locked: result.locked, provider: provider.name },
    });
    return result.locked
      ? jsonError("Too many failed attempts. Account locked for 15 minutes.", 423, "account_locked", requestId)
      : jsonError("Email or password is incorrect.", 401, "invalid_credentials", requestId);
  }

  await clearFailedLogin(admin.id);
  await recordLoginAttempt({ ip, userAgent: agent, email, outcome: "success" });
  // Records which key live credentials are being minted under, so a later
  // rotation is detectable instead of silently orphaning them.
  const { observeKeyState } = await import("@/lib/auth/key-state");
  await observeKeyState("sign-in");

  // First verified Supabase sign-in activates the provisioned role holder.
  if (admin.status === "invited" && provider.name === "supabase") {
    const { activateInvitedAdmin } = await import("@/lib/queries/admins");
    await activateInvitedAdmin(admin.id);
    await recordAudit({
      action: auditActions.inviteAccepted,
      actorAdminId: admin.id,
      actorEmail: admin.email,
      actorRole: admin.role,
      entity: "admin",
      entityId: admin.id,
      outcome: "success",
      requestId,
      ip,
      userAgent: agent,
      detail: { provider: provider.name, activation: "first_verified_supabase_signin" },
    });
  }

  // In supabase mode the identity provider is the source of truth for the
  // external user id; keep the link current so role lookups stay stable.
  if (externalUserId && externalUserId !== admin.supabaseUserId) {
    const { linkSupabaseUser } = await import("@/lib/queries/admins");
    await linkSupabaseUser(admin.id, externalUserId);
  }

  const needsMfa = Boolean(admin.mfaEnrolledAt) || admin.mfaRequired;
  await createSession(admin.id, { ip, userAgent: agent, mfaVerified: !needsMfa });

  await recordAudit({
    action: auditActions.authLoginSuccess,
    actorAdminId: admin.id,
    actorEmail: admin.email,
    actorRole: admin.role,
    entity: "admin",
    entityId: admin.id,
    outcome: "success",
    requestId,
    ip,
    userAgent: agent,
    detail: { provider: provider.name, mfaPending: needsMfa },
  });

  return jsonOk({ next: needsMfa ? "/login/mfa" : "/dashboard", mfaPending: needsMfa }, 200, requestId);
}
