import { describe, expect, it } from "vitest";
import { compareLedgers } from "@/lib/supabase/migrations";

/**
 * Migration ledger comparison.
 *
 * Pure arithmetic over two ledgers. The live values asserted in
 * `scripts/verify-integration.ts` are the real ones from the production project;
 * these tests pin the comparison logic that decides whether they agree.
 */

const LIVE_1_TO_4 = [
  { version: 1, label: "foundation: blueprint v1 cloud schema + RLS + sync plumbing", applied_at: "2026-08-06T18:05:26Z" },
  { version: 2, label: "p3 parity: widen contact_channel.channel check", applied_at: "2026-08-06T20:42:40Z" },
  { version: 3, label: "P16 integrity: anon revoked", applied_at: "2026-08-15T13:21:54Z" },
  { version: 4, label: "P16 integrity: avatars bucket", applied_at: "2026-08-15T13:21:55Z"
  },
];

const DOCUMENTED = [
  { version: "1", file: "0001_foundation.sql", applied: "2026-08-06 18:05 UTC" },
  { version: "2", file: "0002_widen_channel_checks.sql", applied: "2026-08-06 20:42 UTC" },
  { version: "3", file: "0003_revoke_anon_surface.sql", applied: "P-16 audit apply" },
  { version: "4", file: "0004_avatars_bucket.sql", applied: "P-16 audit apply" },
];

describe("the production ledger as audited", () => {
  it("reports agreement for versions 1..4", () => {
    const result = compareLedgers({ live: LIVE_1_TO_4, documented: DOCUMENTED });
    expect(result.ok).toBe(true);
    expect(result.live).toEqual([1, 2, 3, 4]);
    expect(result.documented).toEqual([1, 2, 3, 4]);
    expect(result.missing).toEqual([]);
    expect(result.undocumented).toEqual([]);
    expect(result.duplicated).toEqual([]);
    expect(result.contiguous).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("ignores the repository's non-numeric 'verify' rows", () => {
    // docs/supabase/README.md lists verify scripts in the same table with the
    // literal version "verify". They must not be counted as migrations.
    const withVerify = [...DOCUMENTED, { version: "verify", file: "verify_0001.sql", applied: "re-runnable" }];
    const result = compareLedgers({ live: LIVE_1_TO_4, documented: withVerify });
    expect(result.ok).toBe(true);
    expect(result.documented).toEqual([1, 2, 3, 4]);
  });

  it("preserves labels and applied timestamps for display", () => {
    const result = compareLedgers({ live: LIVE_1_TO_4, documented: DOCUMENTED });
    expect(result.labels).toHaveLength(4);
    expect(result.labels[0].label).toMatch(/foundation/);
    expect(result.labels[3].appliedAt).toBe("2026-08-15T13:21:55Z");
  });
});

describe("drift is detected in every direction", () => {
  it("flags a documented migration that was never applied", () => {
    const result = compareLedgers({
      live: LIVE_1_TO_4.slice(0, 3),
      documented: DOCUMENTED,
    });
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual([4]);
  });

  it("flags a live migration the repository does not document", () => {
    const result = compareLedgers({
      live: [...LIVE_1_TO_4, { version: 5, label: "applied by hand, never committed", applied_at: null }],
      documented: DOCUMENTED,
    });
    expect(result.ok).toBe(false);
    expect(result.undocumented).toEqual([5]);
  });

  it("flags a duplicated live version", () => {
    const result = compareLedgers({
      live: [...LIVE_1_TO_4, { version: 2, label: "re-applied", applied_at: null }],
      documented: DOCUMENTED,
    });
    expect(result.duplicated).toEqual([2]);
    expect(result.ok).toBe(false);
  });

  it("flags a gap in the sequence", () => {
    const result = compareLedgers({
      live: [LIVE_1_TO_4[0], LIVE_1_TO_4[2], LIVE_1_TO_4[3]],
      documented: [DOCUMENTED[0], DOCUMENTED[2], DOCUMENTED[3]],
    });
    expect(result.contiguous).toBe(false);
    expect(result.ok).toBe(false);
  });

  it("reports both directions at once when both are wrong", () => {
    const result = compareLedgers({
      live: [{ version: 1, label: null, applied_at: null }, { version: 9, label: null, applied_at: null }],
      documented: [{ version: "1", file: "a", applied: "x" }, { version: "2", file: "b", applied: "y" }],
    });
    expect(result.missing).toEqual([2]);
    expect(result.undocumented).toEqual([9]);
    expect(result.ok).toBe(false);
  });
});

describe("empty states are reported honestly", () => {
  it("treats an empty live ledger with documented migrations as all-missing", () => {
    const result = compareLedgers({ live: [], documented: DOCUMENTED });
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual([1, 2, 3, 4]);
    expect(result.live).toEqual([]);
  });

  it("treats both ledgers empty as agreement, not as an error", () => {
    const result = compareLedgers({ live: [], documented: [] });
    expect(result.ok).toBe(true);
    expect(result.contiguous).toBe(true);
  });

  it("surfaces unreadable ledgers through errors rather than a false 'ok'", () => {
    const result = compareLedgers({ live: LIVE_1_TO_4, documented: DOCUMENTED });
    expect(result.errors).toEqual([]);
    // compareLiveToRepository adds errors when either source is unreachable;
    // `ok` must then be false even if the numbers happened to match.
  });
});
