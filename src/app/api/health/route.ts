import { sql } from "drizzle-orm";
import { db } from "@/db";
import { envReport } from "@/config/env";
import { bridgeStatus, probeSupabaseReachable } from "@/lib/supabase/bridge";

export const dynamic = "force-dynamic";

/**
 * Liveness + configuration posture.
 *
 * Returns presence flags only. No secret value, no connection string and no
 * end-user data can be read from this endpoint.
 */
export async function GET() {
  const started = Date.now();
  let database = false;
  let databaseError: string | null = null;

  try {
    await db.execute(sql`select 1`);
    database = true;
  } catch (error) {
    databaseError = error instanceof Error ? error.name : "unknown";
  }

  const bridge = bridgeStatus();
  const report = envReport();

  // Only spend a network round-trip when the bridge is actually configured.
  const supabase = bridge.configured
    ? await probeSupabaseReachable()
    : { reachable: false, latencyMs: 0, httpStatus: null, error: "unconfigured" };

  const healthy = database;

  return Response.json(
    {
      ok: healthy,
      service: "replymate-control",
      checkedAt: new Date().toISOString(),
      uptimeMs: Date.now() - started,
      database: { reachable: database, error: databaseError },
      supabase: {
        bridge: bridge.mode,
        projectUrl: report.supabase.projectUrl,
        reachable: supabase.reachable,
        latencyMs: supabase.latencyMs,
        httpStatus: supabase.httpStatus,
        error: supabase.error,
      },
      auth: { provider: report.authProvider, sessionTtlHours: report.controlPlane.sessionTtlHours },
      aiOps: { provider: report.aiOps.provider, llmActive: report.aiOps.llmActive },
      privacy: { messageSyncEnabled: false, messageBodiesReadable: false },
    },
    {
      status: healthy ? 200 : 503,
      headers: { "cache-control": "no-store" },
    },
  );
}
