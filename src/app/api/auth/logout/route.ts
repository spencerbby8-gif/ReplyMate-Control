import { auditActions, recordAudit } from "@/lib/audit/logger";
import { destroySession, getSession } from "@/lib/auth/session";
import { clientIp, jsonOk, newRequestId, userAgent } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const requestId = newRequestId();
  const session = await getSession();

  if (session) {
    await recordAudit({
      action: auditActions.authLogout,
      actorAdminId: session.admin.id,
      actorEmail: session.admin.email,
      actorRole: session.admin.role,
      entity: "admin",
      entityId: session.admin.id,
      outcome: "success",
      requestId,
      ip: clientIp(request),
      userAgent: userAgent(request),
    });
  }

  await destroySession();
  return jsonOk({ signedOut: true }, 200, requestId);
}
