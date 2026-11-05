import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { ctlDevice, ctlDeviceEvent } from "@/db/schema";
import { MAX_BATCH_SIZE, validateIngestBatch } from "@/lib/ingest/allowlist";
import { clientVersionSupported } from "@/lib/ingest/contract";
import { authenticateDevice, deviceWithinRateLimit } from "@/lib/ingest/auth";
import { auditActions, recordAudit } from "@/lib/audit/logger";
import { csrfFailureResponse } from "@/lib/auth/csrf";
import { clientIp, jsonError, jsonOk, newRequestId, userAgent } from "@/lib/http";

export const dynamic = "force-dynamic";

/**
 * Telemetry ingestion — the only write path a device has.
 *
 * Order: CSRF → device auth → rate limit → allow-list validation → insert.
 * Validation happens before any database write, and rejected events are refused
 * individually so one bad event cannot hide the rest of a batch.
 *
 * This endpoint cannot read anything. It has no GET handler on purpose.
 */
export async function POST(request: Request) {
  const requestId = newRequestId();
  const ip = clientIp(request);
  const agent = userAgent(request);

  const csrfFailure = csrfFailureResponse(request, requestId);
  if (csrfFailure) return csrfFailure;

  const auth = await authenticateDevice(request);
  if (!auth.ok) {
    await recordAudit({
      action: auditActions.ingestRejected,
      entity: "device",
      outcome: "denied",
      requestId,
      ip,
      userAgent: agent,
      detail: { code: auth.code },
    });
    return jsonError(auth.reason, auth.status, auth.code, requestId);
  }

  // Version gate: an older build cannot know the allow-list and would send fields
  // that no longer exist. Refusing explicitly beats silently mis-parsing.
  const appVersion = request.headers.get("x-replymate-app-version");
  const versionCheck = clientVersionSupported(appVersion);
  if (!versionCheck.supported) {
    await recordAudit({
      action: auditActions.ingestRejected,
      actorEmail: auth.deviceLabel,
      entity: "device",
      entityId: auth.deviceId,
      outcome: "denied",
      requestId,
      ip,
      userAgent: agent,
      detail: { code: "unsupported_version", appVersion, reason: versionCheck.reason },
    });
    return jsonError(
      `${versionCheck.reason}. Send the X-ReplyMate-App-Version header.`,
      426,
      "unsupported_version",
      requestId,
    );
  }

  const limit = await deviceWithinRateLimit(auth.deviceId);
  if (!limit.allowed) {
    await recordAudit({
      action: auditActions.ingestRejected,
      actorEmail: auth.deviceLabel,
      entity: "device",
      entityId: auth.deviceId,
      outcome: "denied",
      requestId,
      ip,
      userAgent: agent,
      detail: { code: "rate_limited", count: limit.count, limit: limit.limit },
    });
    return Response.json(
      { error: `Ingest rate limit exceeded (${limit.count}/${limit.limit} per minute).`, code: "rate_limited", requestId },
      { status: 429, headers: { "retry-after": "60", "cache-control": "no-store" } },
    );
  }

  const body = (await request.json().catch(() => null)) as { events?: unknown } | null;
  const result = validateIngestBatch(body?.events ?? body);
  if (result.error) {
    return jsonError(result.error, 400, "invalid_batch", requestId);
  }

  if (result.accepted.length === 0) {
    await recordAudit({
      action: auditActions.ingestRejected,
      actorEmail: auth.deviceLabel,
      entity: "device",
      entityId: auth.deviceId,
      outcome: "denied",
      requestId,
      ip,
      userAgent: agent,
      detail: { rejected: result.rejected.length, codes: [...new Set(result.rejected.map((r) => r.code))] },
    });
    return jsonError(
      `Every event in the batch was refused. First reason: ${result.rejected[0]?.message ?? "unknown"}`,
      422,
      "all_rejected",
      requestId,
      { rejected: result.rejected },
    );
  }

  const inserted = await db
    .insert(ctlDeviceEvent)
    .values(
      result.accepted.map((event) => ({
        deviceId: auth.deviceId,
        kind: event.kind,
        appVersion: typeof event.payload.appVersion === "string" ? event.payload.appVersion : null,
        androidApiLevel:
          typeof event.payload.androidApi === "number" ? event.payload.androidApi : null,
        payload: event.payload,
        occurredAt: event.occurredAt,
      })),
    )
    .returning({ id: ctlDeviceEvent.id });

  await db
    .update(ctlDevice)
    .set({
      lastSeenAt: new Date(),
      eventCount: sql`${ctlDevice.eventCount} + ${inserted.length}`,
    })
    .where(eq(ctlDevice.id, auth.deviceId));

  await recordAudit({
    action: auditActions.ingestAccepted,
    actorEmail: auth.deviceLabel,
    entity: "device",
    entityId: auth.deviceId,
    outcome: "success",
    requestId,
    ip,
    userAgent: agent,
    // Only counts and kinds are audited — never the payload, so a rejection
    // reason cannot become a smuggling channel for content into the log.
    detail: {
      accepted: inserted.length,
      rejected: result.rejected.length,
      kinds: [...new Set(result.accepted.map((event) => event.kind))],
      rejectionCodes: [...new Set(result.rejected.map((r) => r.code))],
    },
  });

  return jsonOk(
    {
      accepted: inserted.length,
      rejected: result.rejected,
      batchLimit: MAX_BATCH_SIZE,
      rateLimit: { count: limit.count + inserted.length, limit: limit.limit, windowSeconds: 60 },
    },
    result.rejected.length > 0 ? 207 : 200,
    requestId,
  );
}
