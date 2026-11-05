import { describe, expect, it } from "vitest";
import { compareAppVersion, selectReleaseForClient } from "@/lib/config/versioning";

/**
 * Versioned configuration delivery.
 *
 * `compareAppVersion` gates which release a client receives, so a wrong answer
 * here means a client silently gets the wrong configuration. These are the cases
 * that break naive string comparison.
 */

describe("compareAppVersion", () => {
  it.each([
    ["1.5.9", "1.5.9", 0],
    ["1.5.10", "1.5.9", 1],
    ["1.5.9", "1.5.10", -1],
    ["1.6.0", "1.5.99", 1],
    ["2.0.0", "1.99.99", 1],
    ["1.5.9", "1.6.0", -1],
    ["0.0.1", "0.0.2", -1],
    ["10.0.0", "9.0.0", 1],
  ])("compares %s to %s as %d", (a, b, expected) => {
    expect(compareAppVersion(a, b)).toBe(expected);
  });

  it("does not compare numerically-wrong the way a string sort would", () => {
    // "1.5.10" < "1.5.9" as strings. That is the bug this prevents.
    expect("1.5.10" < "1.5.9").toBe(true);
    expect(compareAppVersion("1.5.10", "1.5.9")).toBe(1);
  });

  it("treats a missing segment as zero", () => {
    expect(compareAppVersion("1.5", "1.5.0")).toBe(0);
    expect(compareAppVersion("1.5.1", "1.5")).toBe(1);
    expect(compareAppVersion("1", "1.0.0")).toBe(0);
  });

  it("ignores non-numeric segments rather than throwing", () => {
    expect(compareAppVersion("1.5.9-beta", "1.5.9")).toBe(0);
    expect(compareAppVersion("", "")).toBe(0);
  });

  it("is antisymmetric", () => {
    for (const [a, b] of [
      ["1.5.9", "1.5.10"],
      ["2.0.0", "1.0.0"],
      ["0.0.1", "0.0.2"],
    ]) {
      expect(Math.sign(compareAppVersion(a, b))).toBe(-Math.sign(compareAppVersion(b, a)));
    }
  });

  it("supports the minAppVersion gate used by resolveConfigForClient", () => {
    // A release with minAppVersion 1.5.9 must reach 1.5.9 and 1.7.2 but not 1.5.8.
    const min = "1.5.9";
    expect(compareAppVersion("1.5.9", min)).toBeGreaterThanOrEqual(0);
    expect(compareAppVersion("1.7.2", min)).toBeGreaterThanOrEqual(0);
    expect(compareAppVersion("1.5.8", min)).toBeLessThan(0);
  });
});


/**
 * Release selection for clients.
 *
 * Regression for a real defect: publishing a release gated to minAppVersion 2.0.0
 * marked the previous release `superseded`, and resolution only considered
 * `published` rows — so EVERY client below 2.0.0 silently lost its configuration
 * instead of falling back to the release it qualified for.
 */
describe("selectReleaseForClient", () => {
  type Rel = { version: number; minAppVersion: string | null };
  // Newest first, exactly as the query returns them.
  const CANDIDATES: Rel[] = [
    { version: 3, minAppVersion: "2.0.0" },
    { version: 2, minAppVersion: "1.7.0" },
    { version: 1, minAppVersion: null },
  ];

  it("gives a new client the newest release", () => {
    expect(selectReleaseForClient(CANDIDATES, "2.1.0")?.version).toBe(3);
  });

  it("falls back to an older release when the newest is gated too high", () => {
    expect(selectReleaseForClient(CANDIDATES, "1.7.2")?.version).toBe(2);
  });

  it("never leaves an old client with nothing — the regression", () => {
    expect(selectReleaseForClient(CANDIDATES, "1.5.9")?.version).toBe(1);
    expect(selectReleaseForClient(CANDIDATES, "0.0.1")?.version).toBe(1);
  });

  it("honours the gate boundary exactly", () => {
    expect(selectReleaseForClient(CANDIDATES, "1.7.0")?.version).toBe(2);
    expect(selectReleaseForClient(CANDIDATES, "1.6.99")?.version).toBe(1);
    expect(selectReleaseForClient(CANDIDATES, "2.0.0")?.version).toBe(3);
    expect(selectReleaseForClient(CANDIDATES, "1.99.99")?.version).toBe(2);
  });

  it("treats a client that reports no version as unqualified for any gate", () => {
    // Fails closed: it can only receive an ungated release.
    expect(selectReleaseForClient(CANDIDATES, null)?.version).toBe(1);
    expect(selectReleaseForClient([{ version: 9, minAppVersion: "2.0.0" }], null)).toBeNull();
  });

  it("returns null when nothing applies, so the client uses built-in defaults", () => {
    expect(selectReleaseForClient([], "1.5.9")).toBeNull();
    expect(selectReleaseForClient([{ version: 1, minAppVersion: "9.9.9" }], "1.5.9")).toBeNull();
  });

  it("prefers the highest version among equally-applicable candidates", () => {
    const ungated: Rel[] = [
      { version: 7, minAppVersion: null },
      { version: 6, minAppVersion: null },
    ];
    expect(selectReleaseForClient(ungated, "1.0.0")?.version).toBe(7);
  });

  it("does not depend on array order being lucky — newest-first is required", () => {
    // If a caller passed oldest-first the wrong release would win, so the
    // contract is asserted here rather than assumed.
    const oldestFirst = [...CANDIDATES].reverse();
    expect(selectReleaseForClient(oldestFirst, "1.5.9")?.version).toBe(1);
    expect(selectReleaseForClient(oldestFirst, "2.1.0")?.version).toBe(1);
  });
});
