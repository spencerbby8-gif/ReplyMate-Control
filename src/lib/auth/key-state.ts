import { count, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { ctlDeviceToken, ctlInvite, ctlKeyState, ctlSession } from "@/db/schema";
import { digestKeyStrength, encryptionKeyStatus } from "./crypto";
import { resolveEncryptionKey } from "./keys";

/**
 * Key-rotation detection.
 *
 * A digest-keyed credential (session, invitation, device ingest key) can only be
 * matched while the key that produced it is still the active key. If the key
 * changes, those rows become permanently unreachable — and because a failed
 * lookup looks exactly like an invalid credential, the failure is silent.
 *
 * This module compares the active key fingerprint against the one recorded when
 * credentials were last minted, and counts what would now be orphaned. That
 * converts a silent outage into a dashboard warning with a remediation path.
 */

export type KeyStateReport = {
  strength: "keyed" | "unkeyed";
  source: "environment" | "keyfile" | "none";
  fingerprint: string | null;
  detail: string;
  /** Fingerprint recorded at the last observation, if any. */
  previousFingerprint: string | null;
  rotated: boolean;
  orphaned: { sessions: number; invites: number; deviceTokens: number };
  /** True when stored credentials exist but no key is available at all. */
  credentialsUnreachable: boolean;
};

async function countLive(
  table: typeof ctlSession | typeof ctlInvite | typeof ctlDeviceToken,
): Promise<number> {
  const column =
    table === ctlSession ? ctlSession.revokedAt : table === ctlInvite ? ctlInvite.revokedAt : ctlDeviceToken.revokedAt;
  const [row] = await db
    .select({ value: count() })
    .from(table)
    // A row that is not revoked is still expected to authenticate. Expired rows
    // are counted too: they would fail on expiry rather than on key mismatch,
    // but distinguishing that requires per-row digests we deliberately cannot
    // recompute. Over-reporting is the safe direction.
    .where(isNull(column as never));
  return row?.value ?? 0;
}

export async function keyStateReport(): Promise<KeyStateReport> {
  const status = encryptionKeyStatus();
  const strength = digestKeyStrength();
  const active = resolveEncryptionKey();

  const [recorded] = await db.select().from(ctlKeyState).where(eq(ctlKeyState.id, 1));
  const previousFingerprint = recorded?.digestFingerprint ?? null;
  const rotated = previousFingerprint !== null && previousFingerprint !== active.fingerprint;

  const orphaned = rotated
    ? {
        sessions: await countLive(ctlSession),
        invites: await countLive(ctlInvite),
        deviceTokens: await countLive(ctlDeviceToken),
      }
    : { sessions: 0, invites: 0, deviceTokens: 0 };

  const credentialsUnreachable =
    active.fingerprint === null && (await countLive(ctlDeviceToken)) + (await countLive(ctlInvite)) > 0;

  return {
    strength,
    source: status.source,
    fingerprint: active.fingerprint,
    detail: status.detail,
    previousFingerprint,
    rotated,
    orphaned,
    credentialsUnreachable,
  };
}

/**
 * Records the active fingerprint. Called after a successful sign-in and after a
 * device key is issued, so `previousFingerprint` always describes the key that
 * live credentials were minted under.
 */
export async function observeKeyState(note?: string): Promise<void> {
  const active = resolveEncryptionKey();
  const status = encryptionKeyStatus();
  await db
    .insert(ctlKeyState)
    .values({
      id: 1,
      digestFingerprint: active.fingerprint,
      aeadFingerprint: status.available ? active.fingerprint : null,
      keySource: active.source,
      observedAt: new Date(),
      note: note ?? null,
    })
    .onConflictDoUpdate({
      target: ctlKeyState.id,
      set: {
        digestFingerprint: active.fingerprint,
        aeadFingerprint: status.available ? active.fingerprint : null,
        keySource: active.source,
        observedAt: new Date(),
        note: note ?? null,
      },
    });
}
