import { and, count, desc, eq, gte, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { ctlDevice, ctlDeviceEvent, ctlDeviceToken } from "@/db/schema";
import { EVENT_KINDS, type EventKind } from "@/lib/ingest/allowlist";

/** Read models for device registration, telemetry and diagnostics. */

export async function listDevicesWithActivity() {
  const devices = await db.select().from(ctlDevice).orderBy(desc(ctlDevice.lastSeenAt), desc(ctlDevice.createdAt));
  return Promise.all(
    devices.map(async (device) => {
      const [stats] = await db
        .select({
          events: count(),
          lastEventAt: sql<string | null>`max(${ctlDeviceEvent.occurredAt})`,
        })
        .from(ctlDeviceEvent)
        .where(eq(ctlDeviceEvent.deviceId, device.id));
      const tokens = await db
        .select({
          id: ctlDeviceToken.id,
          label: ctlDeviceToken.label,
          lastUsedAt: ctlDeviceToken.lastUsedAt,
          revokedAt: ctlDeviceToken.revokedAt,
          expiresAt: ctlDeviceToken.expiresAt,
          createdAt: ctlDeviceToken.createdAt,
        })
        .from(ctlDeviceToken)
        .where(eq(ctlDeviceToken.deviceId, device.id))
        .orderBy(desc(ctlDeviceToken.createdAt));
      return { device, eventCount: stats?.events ?? 0, lastEventAt: stats?.lastEventAt ?? null, tokens };
    }),
  );
}

export async function countEventsSince(deviceId: string, since: Date): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(ctlDeviceEvent)
    .where(and(eq(ctlDeviceEvent.deviceId, deviceId), gte(ctlDeviceEvent.receivedAt, since)));
  return row?.value ?? 0;
}

export async function deviceEventSummary() {
  const [total] = await db.select({ value: count() }).from(ctlDeviceEvent);
  const [devices] = await db.select({ value: count() }).from(ctlDevice);
  const [consented] = await db
    .select({ value: count() })
    .from(ctlDevice)
    .where(and(eq(ctlDevice.status, "active"), isNull(ctlDevice.consentRevokedAt)));
  const byKind = await db
    .select({ kind: ctlDeviceEvent.kind, value: count() })
    .from(ctlDeviceEvent)
    .groupBy(ctlDeviceEvent.kind);
  const since24h = new Date(Date.now() - 86_400_000);
  const [last24h] = await db
    .select({ value: count() })
    .from(ctlDeviceEvent)
    .where(gte(ctlDeviceEvent.receivedAt, since24h));

  return {
    totalEvents: total?.value ?? 0,
    eventsLast24h: last24h?.value ?? 0,
    devices: devices?.value ?? 0,
    consentedDevices: consented?.value ?? 0,
    byKind: EVENT_KINDS.map((kind: EventKind) => ({
      kind,
      count: byKind.find((row) => row.kind === kind)?.value ?? 0,
    })),
  };
}

export async function listDeviceEvents(options: { deviceId?: string; kind?: string; limit?: number } = {}) {
  const conditions = [];
  if (options.deviceId) conditions.push(eq(ctlDeviceEvent.deviceId, options.deviceId));
  if (options.kind) conditions.push(eq(ctlDeviceEvent.kind, options.kind));
  const base = db
    .select({
      event: ctlDeviceEvent,
      deviceLabel: ctlDevice.label,
    })
    .from(ctlDeviceEvent)
    .innerJoin(ctlDevice, eq(ctlDevice.id, ctlDeviceEvent.deviceId))
    .$dynamic();
  if (conditions.length > 0) base.where(and(...conditions));
  return base.orderBy(desc(ctlDeviceEvent.occurredAt)).limit(options.limit ?? 100);
}

/**
 * Operational diagnostics derived from telemetry.
 *
 * Every figure here is computed from stored events. A category with no events
 * reports zero and says so — nothing is estimated, and no threshold is invented.
 */
export async function operationalDiagnostics() {
  const errors = await db
    .select({ payload: ctlDeviceEvent.payload, occurredAt: ctlDeviceEvent.occurredAt })
    .from(ctlDeviceEvent)
    .where(eq(ctlDeviceEvent.kind, "provider_error"))
    .orderBy(desc(ctlDeviceEvent.occurredAt))
    .limit(500);

  const byProvider = new Map<string, number>();
  const byClass = new Map<string, number>();
  for (const row of errors) {
    const payload = row.payload as Record<string, unknown>;
    const provider = String(payload.providerKey ?? "unknown");
    const errorClass = String(payload.errorClass ?? "unknown");
    byProvider.set(provider, (byProvider.get(provider) ?? 0) + 1);
    byClass.set(errorClass, (byClass.get(errorClass) ?? 0) + 1);
  }

  const latencies = await db
    .select({ payload: ctlDeviceEvent.payload })
    .from(ctlDeviceEvent)
    .where(eq(ctlDeviceEvent.kind, "draft_latency"))
    .orderBy(desc(ctlDeviceEvent.occurredAt))
    .limit(500);

  const samples = latencies
    .map((row) => Number((row.payload as Record<string, unknown>).latencyMs ?? 0))
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b);

  const percentile = (p: number) => {
    if (samples.length === 0) return null;
    const index = Math.min(samples.length - 1, Math.floor((p / 100) * samples.length));
    return samples[index];
  };

  const crashes = await db
    .select({ value: count() })
    .from(ctlDeviceEvent)
    .where(eq(ctlDeviceEvent.kind, "app_crash"));

  const listener = await db
    .select({ payload: ctlDeviceEvent.payload })
    .from(ctlDeviceEvent)
    .where(eq(ctlDeviceEvent.kind, "listener_state"))
    .orderBy(desc(ctlDeviceEvent.occurredAt))
    .limit(200);
  const listenerGranted = listener.filter((row) => (row.payload as Record<string, unknown>).granted === true).length;

  return {
    providerErrors: {
      total: errors.length,
      byProvider: [...byProvider.entries()].sort((a, b) => b[1] - a[1]).map(([key, value]) => ({ key, count: value })),
      byClass: [...byClass.entries()].sort((a, b) => b[1] - a[1]).map(([key, value]) => ({ key, count: value })),
    },
    latency: {
      samples: samples.length,
      p50: percentile(50),
      p95: percentile(95),
      p99: percentile(99),
    },
    crashes: crashes[0]?.value ?? 0,
    listener: {
      reports: listener.length,
      granted: listenerGranted,
      denied: listener.length - listenerGranted,
    },
  };
}
