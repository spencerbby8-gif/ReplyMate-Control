import { z } from "zod";
import { env } from "@/config/env";
import { auditActions, recordAudit } from "@/lib/audit/logger";
import {
  clearFailedLogin,
  createSession,
  lockoutState,
  registerFailedLogin,
} from "@/lib/auth/session";
import { verifyPassword } from "@/lib/auth/crypto";
import { clientIp, jsonError, jsonOk, newRequestId, userAgent } from "@/lib/http";
import { getAdminByEmail } from "@/lib/queries/admins";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(512),
});

export async function POST(request: Request) {
  const requestId = newRequestId();
  const ip = clientIp(request);
  const agent = userAgent(request);

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return jsonError("Email and password are required.", 400, "invalid_input", requestId);
  }

  const email = parsed.data.email.toLowerCase();
  const admin = await getAdminByEmail(email);

  // Uniform failure surface: no account-existence oracle.
  const deny = async (reason: string, code: string) => {
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
      detail: { reason },
    });
    return jsonError("Email or password is incorrect.", 401, code, requestId);
  };

  if (!admin) return deny("unknown_account", "invalid_credentials");
  if (admin.status !== "active") return deny(`account_${admin.status}`, "account_not_active");
  if (!admin.passwordHash) return deny("no_password_set", "invitation_incomplete");

  const lock = lockoutState(admin);
  if (lock.locked) {
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

  const passwordValid = await verifyPassword(parsed.data.password, admin.passwordHash);
  if (!passwordValid) {
    const result = await registerFailedLogin(admin.id, admin.failedLoginCount);
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
      detail: { attempts: result.attempts, locked: result.locked },
    });
    return result.locked
      ? jsonError("Too many failed attempts. Account locked for 15 minutes.", 423, "account_locked", requestId)
      : jsonError("Email or password is incorrect.", 401, "invalid_credentials", requestId);
  }

  await clearFailedLogin(admin.id);

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
    detail: { authProvider: env.AUTH_PROVIDER, mfaPending: needsMfa },
  });

  return jsonOk(
    { next: needsMfa ? "/login/mfa" : "/dashboard", mfaPending: needsMfa },
    200,
    requestId,
  );
}
