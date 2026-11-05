import { auditActions } from "@/lib/audit/logger";
import { apiRequire } from "@/lib/authz/guard";
import { clientIp, jsonOk, userAgent } from "@/lib/http";
import { runMaintenance, totalPruned } from "@/lib/maintenance/runner";

export const dynamic = "force-dynamic";

/**
 * Triggers one maintenance pass.
 *
 * Exists so an EXTERNAL scheduler (system cron, a GitHub Actions schedule, a
 * platform job) can drive pruning reliably, because an in-process interval
 * cannot be relied on: it dies with the process and never fires at all in a
 * serverless deployment. See `src/instrumentation.ts` for the honest statement
 * of what the in-process interval does and does not guarantee.
 *
 * Authorization: `maintenance:run`. CSRF-checked first, like every other
 * state-changing endpoint. Every run is audited with its trigger.
 */
export async function POST(request: Request) {
  void auditActions;
  void userAgent(request);
  void clientIp(request);

  const auth = await apiRequire(request, "maintenance:run");
  if (!auth.ok) return auth.response;

  const report = await runMaintenance("api", {
    adminId: auth.session.admin.id,
    email: auth.session.admin.email,
    role: auth.session.admin.role,
    requestId: auth.requestId,
  });

  return jsonOk({ ...report, totalPruned: totalPruned(report) }, 200, auth.requestId);
}
