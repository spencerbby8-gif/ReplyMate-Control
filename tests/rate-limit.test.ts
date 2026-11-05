import { describe, expect, it } from "vitest";
import { LOGIN_THROTTLE, emailDigest, evaluateThrottle, sourceDigest } from "@/lib/auth/rate-limit";

/**
 * Source-level login throttle policy.
 *
 * The per-account lockout stops one account being brute forced. This stops one
 * client from trying five passwords against ten thousand accounts — the
 * enumeration attack the per-account counter is blind to.
 */

describe("throttle limits are coherent", () => {
  it("trips on distinct targets before it trips on raw volume", () => {
    // Eight different accounts is a stronger enumeration signal than eight
    // failures against one account, so its limit must be the tighter one.
    expect(LOGIN_THROTTLE.maxDistinctTargets).toBeLessThan(LOGIN_THROTTLE.maxFailuresPerSource);
  });

  it("uses a cooldown longer than the observation window", () => {
    expect(LOGIN_THROTTLE.cooldownMinutes).toBeGreaterThan(LOGIN_THROTTLE.windowMinutes);
  });

  it("retains attempts long enough to be auditable but not forever", () => {
    expect(LOGIN_THROTTLE.retentionDays).toBeGreaterThan(0);
    expect(LOGIN_THROTTLE.retentionDays).toBeLessThanOrEqual(30);
  });
});

describe("evaluateThrottle", () => {
  it("allows a source with no failures", () => {
    const decision = evaluateThrottle(0, 0);
    expect(decision.limited).toBe(false);
    expect(decision.retryAfterSeconds).toBe(0);
    expect(decision.reason).toBeNull();
  });

  it("allows failures below the volume limit against one account", () => {
    const decision = evaluateThrottle(LOGIN_THROTTLE.maxFailuresPerSource - 1, 1);
    expect(decision.limited).toBe(false);
  });

  it("trips exactly at the volume limit, not after it", () => {
    const decision = evaluateThrottle(LOGIN_THROTTLE.maxFailuresPerSource, 1);
    expect(decision.limited).toBe(true);
    if (decision.limited) {
      expect(decision.reason).toMatch(/too many failed sign-ins/i);
      expect(decision.retryAfterSeconds).toBe(LOGIN_THROTTLE.cooldownMinutes * 60);
    }
  });

  it("trips exactly at the distinct-target limit", () => {
    const decision = evaluateThrottle(LOGIN_THROTTLE.maxDistinctTargets, LOGIN_THROTTLE.maxDistinctTargets);
    expect(decision.limited).toBe(true);
    if (decision.limited) expect(decision.reason).toMatch(/distinct accounts/i);
  });

  it("prefers the enumeration explanation when both limits are exceeded", () => {
    const decision = evaluateThrottle(500, 500);
    expect(decision.limited).toBe(true);
    if (decision.limited) expect(decision.reason).toMatch(/distinct accounts/i);
  });

  it("reports the observed counts so the caller can audit them", () => {
    const decision = evaluateThrottle(3, 2);
    expect(decision.failures).toBe(3);
    expect(decision.distinctTargets).toBe(2);
  });

  it("honours a custom limit set", () => {
    const strict = { maxFailuresPerSource: 2, maxDistinctTargets: 1, cooldownMinutes: 1, windowMinutes: 1 };
    expect(evaluateThrottle(1, 0, strict).limited).toBe(false);
    expect(evaluateThrottle(2, 0, strict).limited).toBe(true);
    expect(evaluateThrottle(0, 1, strict).limited).toBe(true);
  });
});

describe("source digests do not become a tracking database", () => {
  it("is stable for the same source", () => {
    expect(sourceDigest("203.0.113.7", "Mozilla/5.0")).toBe(sourceDigest("203.0.113.7", "Mozilla/5.0"));
  });

  it("differs per IP", () => {
    expect(sourceDigest("203.0.113.7", "agent")).not.toBe(sourceDigest("203.0.113.8", "agent"));
  });

  it("differs per user-agent class", () => {
    expect(sourceDigest("203.0.113.7", "agent-a")).not.toBe(sourceDigest("203.0.113.7", "agent-b"));
  });

  it("is case- and whitespace-insensitive about the IP", () => {
    expect(sourceDigest("  203.0.113.7 ", "agent")).toBe(sourceDigest("203.0.113.7", "agent"));
  });

  it("handles a missing IP or agent without throwing", () => {
    expect(sourceDigest(null, null)).toMatch(/^[a-f0-9]{64}$/);
    expect(sourceDigest(null, "agent")).not.toBe(sourceDigest("1.2.3.4", "agent"));
  });

  it("never contains the raw IP", () => {
    expect(sourceDigest("203.0.113.7", "Mozilla/5.0")).not.toContain("203.0.113.7");
  });

  it("truncates a long user agent so it cannot be used as an identifier", () => {
    const long = "x".repeat(500);
    expect(sourceDigest("1.2.3.4", long)).toBe(sourceDigest("1.2.3.4", "x".repeat(40)));
  });
});

describe("email digests", () => {
  it("is stable and normalised", () => {
    expect(emailDigest("Admin@Example.COM")).toBe(emailDigest("  admin@example.com "));
  });

  it("differs per address", () => {
    expect(emailDigest("a@example.com")).not.toBe(emailDigest("b@example.com"));
  });

  it("never contains the address", () => {
    expect(emailDigest("admin@example.com")).not.toContain("admin@example.com");
    expect(emailDigest("admin@example.com")).toMatch(/^[a-f0-9]{64}$/);
  });

  it("is not the same digest as a source, so the two cannot be cross-matched", () => {
    expect(emailDigest("1.2.3.4")).not.toBe(sourceDigest("1.2.3.4", "1.2.3.4"));
  });
});
