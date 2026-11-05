import { and, eq, gt, isNull } from "drizzle-orm";
import { db } from "@/db";
import { ctlDevice, ctlDeviceToken } from "@/db/schema";
import { digestToken } from "@/lib/auth/crypto";

/**
 * Device authentication for telemetry ingestion.
 *
 * Deliberately NOT the admin session. A device credential is scoped to one
 * device, expires, is revocable independently, and grants exactly one ability:
 * appending allow-listed events. It cannot read anything, and it cannot reach
 * any control-plane surface.
 *
 * The bearer key is stored only as a keyed digest, so a database leak yields no
 * usable device credentials.
 */

export type DeviceAuth =
  | {
      ok: true;
      deviceId: string;
      deviceLabel: string | null;
      tokenId: string;
      consentRecordedAt: Date;
    }
  | { ok: false; status: number; code: string; reason: string };

export const MAX_INGEST_PER_MINUTE = 30;

export async function authenticateDevice(request: Request): Promise<DeviceAuth> {
  const header = request.headers.get("authorization");
  if (!header?.toLowerCase().startsWith("bearer ")) {
    return { ok: false, status: 401, code: "missing_credential", reason: "A bearer ingest key is required." };
  }

  const token = header.slice(7).trim();
  if (token.length < 20 || token.length > 200) {
    return { ok: false, status: 401, code: "malformed_credential", reason: "Malformed ingest key." };
  }

  const rows = await db
    .select({ device: ctlDevice, token: ctlDeviceToken })
    .from(ctlDeviceToken)
    .innerJoin(ctlDevice, eq(ctlDevice.id, ctlDeviceToken.deviceId))
    .where(
      and(
        eq(ctlDeviceToken.tokenDigest, digestToken(token)),
        isNull(ctlDeviceToken.revokedAt),
        gt(ctlDeviceToken.expiresAt, new Date()),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) {
    // One message for unknown, revoked and expired keys: no oracle about which
    // device registrations exist.
    return { ok: false, status: 401, code: "invalid_credential", reason: "Ingest key is not valid." };
  }

  if (row.device.status !== "active" || row.device.consentRevokedAt !== null) {
    return {
      ok: false,
      status: 403,
      code: "consent_withdrawn",
      reason:
        "Telemetry consent for this device has been withdrawn or the registration was revoked. Ingestion is refused.",
    };
  }

  // Touch last-used without failing the request if the write errors.
  db.update(ctlDeviceToken)
    .set({ lastUsedAt: new Date() })
    .where(eq(ctlDeviceToken.id, row.token.id))
    .catch(() => undefined);

  return {
    ok: true,
    deviceId: row.device.id,
    deviceLabel: row.device.label,
    tokenId: row.token.id,
    consentRecordedAt: row.device.consentRecordedAt,
  };
}

/**
 * Per-device ingestion throttle.
 *
 * Counted from the events table rather than a separate counter, so it cannot
 * drift from what was actually stored.
 */
export async function deviceWithinRateLimit(deviceId: string): Promise<{
  allowed: boolean;
  count: number;
  limit: number;
}> {
  const since = new Date(Date.now() - 60_000);
  const rows = await db
    .select({ id: ctlDevice.id })
    .from(ctlDevice)
    .where(eq(ctlDevice.id, deviceId))
    .limit(1);
  if (rows.length === 0) return { allowed: false, count: 0, limit: MAX_INGEST_PER_MINUTE };

  const { countEventsSince } = await import("@/lib/queries/devices");
  const count = await countEventsSince(deviceId, since);
  return { allowed: count < MAX_INGEST_PER_MINUTE, count, limit: MAX_INGEST_PER_MINUTE };
}
