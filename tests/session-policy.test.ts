import { describe, expect, it } from "vitest";
import { LOCKOUT, lockoutState } from "@/lib/auth/session";
import { createHash } from "node:crypto";
import { digestKeyStrength, digestToken, generateToken } from "@/lib/auth/crypto";

/**
 * Session and lockout policy.
 *
 * Two defects these tests exist to keep fixed:
 *  1. An expired lock left the failure counter at its maximum, so the next
 *     single failure re-locked the account instantly and the user never got a
 *     fresh set of attempts.
 *  2. The token digest was an HMAC keyed with a pepper hardcoded in source,
 *     which added nothing. It is now keyed from CONTROL_ENC_KEY.
 */

function admin(failedLoginCount: number, lockedUntil: Date | null) {
  return { failedLoginCount, lockedUntil };
}

describe("lockout constants", () => {
  it("allows five attempts before locking", () => {
    expect(LOCKOUT.maxFailedAttempts).toBe(5);
  });

  it("locks for fifteen minutes", () => {
    expect(LOCKOUT.lockMinutes).toBe(15);
  });
});

describe("lockoutState", () => {
  it("reports no lock for a clean account", () => {
    const state = lockoutState(admin(0, null));
    expect(state.locked).toBe(false);
    expect(state.expiredLock).toBe(false);
    expect(state.effectiveCount).toBe(0);
    expect(state.remainingAttempts).toBe(5);
    expect(state.lockedUntil).toBeNull();
  });

  it("counts down remaining attempts", () => {
    expect(lockoutState(admin(1, null)).remainingAttempts).toBe(4);
    expect(lockoutState(admin(4, null)).remainingAttempts).toBe(1);
  });

  it("never reports negative remaining attempts", () => {
    expect(lockoutState(admin(99, null)).remainingAttempts).toBe(0);
  });

  it("reports an active lock with zero remaining attempts", () => {
    const until = new Date(Date.now() + 60_000);
    const state = lockoutState(admin(5, until));
    expect(state.locked).toBe(true);
    expect(state.expiredLock).toBe(false);
    expect(state.remainingAttempts).toBe(0);
    expect(state.lockedUntil).toEqual(until);
  });

  // --- the regression this suite exists for -------------------------------
  it("treats an EXPIRED lock as a reset counter", () => {
    const until = new Date(Date.now() - 1000);
    const state = lockoutState(admin(5, until));
    expect(state.locked).toBe(false);
    expect(state.expiredLock).toBe(true);
    expect(state.effectiveCount).toBe(0);
    expect(state.remainingAttempts).toBe(5);
    expect(state.lockedUntil).toBeNull();
  });

  it("gives a full set of fresh attempts after an expired lock", () => {
    const until = new Date(Date.now() - 1000);
    const state = lockoutState(admin(5, until));
    // The caller passes effectiveCount to registerFailedLogin, so the next
    // failure records 1 attempt, not 6 — the account is not instantly re-locked.
    expect(state.effectiveCount + 1).toBeLessThan(LOCKOUT.maxFailedAttempts);
  });

  it("does not treat a lock expiring in the future as expired", () => {
    const until = new Date(Date.now() + 60_000);
    const state = lockoutState(admin(5, until));
    expect(state.expiredLock).toBe(false);
    expect(state.effectiveCount).toBe(5);
  });

  it("handles a boundary lock exactly at now", () => {
    const state = lockoutState(admin(5, new Date(Date.now())));
    // getTime() <= now counts as expired, which is the safe direction: the user
    // gets attempts back rather than staying locked a millisecond too long.
    expect(state.locked).toBe(false);
    expect(state.expiredLock).toBe(true);
  });
});

describe("token digest is keyed, not hardcoded", () => {
  it("reports the digest key strength truthfully", () => {
    // CONTROL_ENC_KEY is set in vitest.config.ts, so this must be "keyed".
    expect(digestKeyStrength()).toBe("keyed");
  });

  it("produces a stable 64-hex digest", () => {
    const token = generateToken();
    expect(digestToken(token)).toMatch(/^[a-f0-9]{64}$/);
    expect(digestToken(token)).toBe(digestToken(token));
  });

  it("does not leak the token through its digest", () => {
    const token = generateToken();
    expect(digestToken(token)).not.toContain(token);
  });

  it("digests distinct tokens to distinct values", () => {
    const digests = new Set(Array.from({ length: 200 }, () => digestToken(generateToken())));
    expect(digests.size).toBe(200);
  });

  it("is not plain SHA-256 of the token", () => {
    // If this ever equals an unkeyed SHA-256, the pepper has been lost and a
    // database leak becomes a rainbow-table exercise again.
    const token = generateToken();
    const plainSha256 = createHash("sha256").update(token).digest("hex");
    expect(digestToken(token)).not.toBe(plainSha256);
  });
});
