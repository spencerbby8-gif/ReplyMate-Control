import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { ctlAdmin, ctlInvite, type AdminRole } from "@/db/schema";
import { auditActions, recordAudit } from "@/lib/audit/logger";
import { hashPassword, digestToken } from "@/lib/auth/crypto";
import { isRole } from "@/lib/authz/permissions";
import { identityProvider } from "@/lib/auth/identity";
import { clientIp, jsonError, jsonOk, newRequestId, userAgent } from "@/lib/http";
import { csrfFailureResponse } from "@/lib/auth/csrf";
import { findPendingInviteByHash, getAdminByEmail } from "@/lib/queries/admins";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  token: z.string().min(20).max(200),
  password: z.string().min(12).max(512),
  displayName: z.string().min(1).max(80).nullish(),
});

/**
 * Redeems a single-use invitation.
 *
 * Rate-limited by construction: the token is a 256-bit secret and only its
 * SHA-256 digest is stored, so this endpoint cannot be brute-forced and cannot
 * be used to enumerate invited addresses.
 */
export async function POST(request: Request) {
  const requestId = newRequestId();
  const csrfFailure = csrfFailureResponse(request, requestId);
  if (csrfFailure) return csrfFailure;
  const ip = clientIp(request);
  const agent = userAgent(request);

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return jsonError(
      parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      400,
      "invalid_input",
      requestId,
    );
  }

  // In supabase mode the password is set through Supabase Auth's own email
  // link, so this local redemption path must not run: it would create a local
  // credential that nothing authenticates against.
  if (identityProvider().name === "supabase") {
    return jsonError(
      "AUTH_PROVIDER=supabase: invitations are redeemed through the Supabase Auth email link, not this endpoint.",
      409,
      "provider_mismatch",
      requestId,
    );
  }

  const tokenHash = digestToken(parsed.data.token);
  const invite = await findPendingInviteByHash(tokenHash);
  if (!invite) {
    await recordAudit({
      action: auditActions.inviteAccepted,
      entity: "invite",
      outcome: "denied",
      requestId,
      ip,
      userAgent: agent,
      detail: { reason: "invalid_expired_or_already_redeemed" },
    });
    return jsonError("This invitation is no longer valid.", 404, "invite_not_found", requestId);
  }

  if (!isRole(invite.role)) {
    return jsonError("The invitation carries an unrecognised role.", 500, "bad_invite_role", requestId);
  }
  const role = invite.role as AdminRole;

  // Consume the invite FIRST so a concurrent double-submit cannot create two
  // administrators from one invitation.
  const consumed = await db
    .update(ctlInvite)
    .set({ acceptedAt: new Date() })
    .where(eq(ctlInvite.id, invite.id))
    .returning({ id: ctlInvite.id });
  if (consumed.length === 0) {
    return jsonError("This invitation has already been redeemed.", 409, "invite_consumed", requestId);
  }

  const existing = await getAdminByEmail(invite.email);
  const passwordHash = await hashPassword(parsed.data.password);

  let adminId: string;
  if (existing) {
    const [updated] = await db
      .update(ctlAdmin)
      .set({
        passwordHash,
        role,
        status: "active",
        displayName: parsed.data.displayName ?? existing.displayName,
        mfaRequired: invite.mfaRequired,
        failedLoginCount: 0,
        lockedUntil: null,
        updatedAt: new Date(),
      })
      .where(eq(ctlAdmin.id, existing.id))
      .returning({ id: ctlAdmin.id });
    adminId = updated.id;
  } else {
    const [inserted] = await db
      .insert(ctlAdmin)
      .values({
        email: invite.email,
        displayName: parsed.data.displayName ?? null,
        role,
        status: "active",
        passwordHash,
        mfaRequired: invite.mfaRequired,
      })
      .returning({ id: ctlAdmin.id });
    adminId = inserted.id;
  }

  await recordAudit({
    action: auditActions.inviteAccepted,
    actorAdminId: adminId,
    actorEmail: invite.email,
    actorRole: role,
    entity: "invite",
    entityId: invite.id,
    outcome: "success",
    requestId,
    ip,
    userAgent: agent,
    detail: { role, mfaRequired: invite.mfaRequired, invitedBy: invite.invitedBy, reactivated: Boolean(existing) },
  });

  return jsonOk({ activated: true, mfaRequired: invite.mfaRequired }, 200, requestId);
}
