import { eq } from "drizzle-orm";
import { db } from "@/db";
import { ctlAdmin } from "@/db/schema";
import { auditActions, recordAudit } from "@/lib/audit/logger";
import { decryptSecret, encryptSecret, encryptionAvailable } from "@/lib/auth/crypto";
import { getSession } from "@/lib/auth/session";
import { generateTotpSecret, otpauthUri, totpConfig, verifyTotp } from "@/lib/auth/totp";
import { clientIp, jsonError, jsonOk, newRequestId, userAgent } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * MFA enrolment, step 1 of 2.
 *
 * Generates a TOTP secret, stores it ENCRYPTED, and returns the otpauth URI so
 * the client can render a QR code. The secret is returned once, over an
 * authenticated request, and is never written to the audit log (redaction
 * catches both `secret` and `otp`-shaped keys).
 */
export async function POST(request: Request) {
  const requestId = newRequestId();
  const session = await getSession({ requireMfa: false });
  if (!session) return jsonError("Authentication required.", 401, "unauthenticated", requestId);

  if (!encryptionAvailable()) {
    return jsonError(
      "CONTROL_ENC_KEY is not configured, so a TOTP secret cannot be stored safely. Enrolment is refused rather than downgraded.",
      503,
      "encryption_unavailable",
      requestId,
    );
  }

  const secret = generateTotpSecret();
  await db
    .update(ctlAdmin)
    .set({ mfaSecretEnc: encryptSecret(secret), mfaEnrolledAt: null, updatedAt: new Date() })
    .where(eq(ctlAdmin.id, session.admin.id));

  await recordAudit({
    action: auditActions.authMfaEnrolled,
    actorAdminId: session.admin.id,
    actorEmail: session.admin.email,
    actorRole: session.admin.role,
    entity: "admin",
    entityId: session.admin.id,
    outcome: "success",
    requestId,
    ip: clientIp(request),
    userAgent: userAgent(request),
    detail: { stage: "setup_started", method: "totp", secret },
  });

  return jsonOk(
    {
      otpauthUri: otpauthUri({ secretBase32: secret, account: session.admin.email }),
      manualEntryKey: secret,
      config: totpConfig,
      pendingConfirmation: true,
    },
    200,
    requestId,
  );
}

/** MFA enrolment, step 2 of 2 — proves possession before the factor goes live. */
export async function PUT(request: Request) {
  const requestId = newRequestId();
  const session = await getSession({ requireMfa: false });
  if (!session) return jsonError("Authentication required.", 401, "unauthenticated", requestId);
  if (!session.admin.mfaSecretEnc) {
    return jsonError("No enrolment is in progress. Start setup first.", 409, "no_pending_enrolment", requestId);
  }

  const payload = (await request.json().catch(() => null)) as { code?: unknown } | null;
  const code = typeof payload?.code === "string" ? payload.code : "";
  if (!/^\d{6}$/.test(code)) {
    return jsonError("Enter the 6-digit code from your authenticator.", 400, "invalid_input", requestId);
  }

  let secret: string;
  try {
    secret = decryptSecret(session.admin.mfaSecretEnc);
  } catch {
    return jsonError("The pending secret could not be decrypted.", 500, "mfa_secret_unavailable", requestId);
  }

  const result = verifyTotp(secret, code);
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
      detail: { stage: "confirm", reason: "code_mismatch" },
    });
    return jsonError("That code did not match. Try the next one.", 401, "invalid_code", requestId);
  }

  await db
    .update(ctlAdmin)
    .set({ mfaEnrolledAt: new Date(), mfaLastStep: result.step, mfaRequired: true, updatedAt: new Date() })
    .where(eq(ctlAdmin.id, session.admin.id));

  await recordAudit({
    action: auditActions.authMfaEnrolled,
    actorAdminId: session.admin.id,
    actorEmail: session.admin.email,
    actorRole: session.admin.role,
    entity: "admin",
    entityId: session.admin.id,
    outcome: "success",
    requestId,
    ip: clientIp(request),
    userAgent: userAgent(request),
    detail: { stage: "confirmed", method: "totp" },
  });

  return jsonOk({ enrolled: true, mfaRequired: true }, 200, requestId);
}
