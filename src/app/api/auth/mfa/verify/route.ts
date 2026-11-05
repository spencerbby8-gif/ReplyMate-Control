import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { ctlAdmin } from "@/db/schema";
import { auditActions, recordAudit } from "@/lib/audit/logger";
import { decryptSecret } from "@/lib/auth/crypto";
import { getSession, markSessionMfaVerified } from "@/lib/auth/session";
import { verifyTotp } from "@/lib/auth/totp";
import { clientIp, jsonError, jsonOk, newRequestId, userAgent } from "@/lib/http";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ code: z.string().regex(/^\d{6}$/, "Enter the 6-digit code.") });

/** Completes sign-in for a session whose account has an enrolled TOTP factor. */
export async function POST(request: Request) {
  const requestId = newRequestId();
  const ip = clientIp(request);
  const agent = userAgent(request);

  // requireMfa is intentionally FALSE here: this endpoint is the MFA step.
  const session = await getSession({ requireMfa: false });
  if (!session) return jsonError("Authentication required.", 401, "unauthenticated", requestId);
  if (session.session.mfaVerified) return jsonOk({ next: "/dashboard" }, 200, requestId);

  const secretEnc = session.admin.mfaSecretEnc;
  if (!secretEnc) {
    return jsonError("No MFA factor is enrolled for this account.", 409, "mfa_not_enrolled", requestId);
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return jsonError(parsed.error.issues[0]?.message ?? "Invalid code.", 400, "invalid_input", requestId);
  }

  let secret: string;
  try {
    secret = decryptSecret(secretEnc);
  } catch {
    await recordAudit({
      action: auditActions.authMfaFailed,
      actorAdminId: session.admin.id,
      actorEmail: session.admin.email,
      actorRole: session.admin.role,
      entity: "admin",
      entityId: session.admin.id,
      outcome: "error",
      requestId,
      ip,
      userAgent: agent,
      detail: { reason: "CONTROL_ENC_KEY unavailable or secret undecryptable" },
    });
    return jsonError(
      "The MFA secret could not be decrypted. CONTROL_ENC_KEY must match the value used at enrolment.",
      500,
      "mfa_secret_unavailable",
      requestId,
    );
  }

  const result = verifyTotp(secret, parsed.data.code);
  if (!result.valid || result.step === null) {
    await recordAudit({
      action: auditActions.authMfaFailed,
      actorAdminId: session.admin.id,
      actorEmail: session.admin.email,
      actorRole: session.admin.role,
      entity: "admin",
      entityId: session.admin.id,
      outcome: "denied",
      requestId,
      ip,
      userAgent: agent,
      detail: { reason: "code_mismatch" },
    });
    return jsonError("That code is not valid. Check your authenticator clock.", 401, "invalid_code", requestId);
  }

  // Replay protection: a TOTP step may only be consumed once per account.
  if (session.admin.mfaLastStep !== null && result.step <= session.admin.mfaLastStep) {
    await recordAudit({
      action: auditActions.authMfaFailed,
      actorAdminId: session.admin.id,
      actorEmail: session.admin.email,
      actorRole: session.admin.role,
      entity: "admin",
      entityId: session.admin.id,
      outcome: "denied",
      requestId,
      ip,
      userAgent: agent,
      detail: { reason: "code_replayed" },
    });
    return jsonError("That code has already been used. Wait for the next one.", 401, "code_reused", requestId);
  }

  await db
    .update(ctlAdmin)
    .set({ mfaLastStep: result.step, updatedAt: new Date() })
    .where(eq(ctlAdmin.id, session.admin.id));
  await markSessionMfaVerified(session.session.id);

  await recordAudit({
    action: auditActions.authMfaSuccess,
    actorAdminId: session.admin.id,
    actorEmail: session.admin.email,
    actorRole: session.admin.role,
    entity: "admin",
    entityId: session.admin.id,
    outcome: "success",
    requestId,
    ip,
    userAgent: agent,
    detail: { method: "totp" },
  });

  return jsonOk({ next: "/dashboard" }, 200, requestId);
}
