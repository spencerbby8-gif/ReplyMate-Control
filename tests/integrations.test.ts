import { describe, expect, it } from "vitest";
import { parseReleaseLedger } from "@/lib/integrations/github";

/**
 * The release ledger parser is fed the real format of releases/RELEASES.md,
 * including its awkward cases: a ❌ BROKEN marker inside the version cell and
 * backticked sha256 values.
 */

const LEDGER = `# ReplyMate release log

> 2026-08-07 prune (owner-ordered workspace cleanup): pre-1.2.0 APK binaries were
> removed from the working tree.

| date (UTC) | versionName | versionCode | sha256 | size | notes |
|---|---|---|---|---|---|
| 2026-07-17 | 0.0.1 | 1 | \`cb3d20136da1005badceeafbd8a9033e426bc47cf8064528d4fd9f79f950300d\` | 33313 | P0 foundations: layers, DI, DB+migrations |
| 2026-07-18 | 0.2.1 ❌ BROKEN — app-layer classes missing from dex, crashes on launch; do NOT install — superseded by 0.2.2 | 5 | \`8d8d7605a58a9e0a1976a32c4b88a89eba806a41ae3fc85f2d92e5f9fadde2d0\` | 58578 | P2 repair: hardened MessagingStyle parsing |
| 2026-08-06 | 0.3.0 | 7 | \`803a5c19fa4669ee907fd74c9e0354a7cb6456c7d75a312c082293ff69568e44\` | 83154 | Supabase foundation: cloud schema 0001 applied LIVE |
`;

describe("parseReleaseLedger", () => {
  const parsed = parseReleaseLedger(LEDGER);

  it("parses only real release rows", () => {
    expect(parsed).toHaveLength(3);
    expect(parsed.map((r) => r.versionName)).toEqual(["0.0.1", "0.2.1", "0.3.0"]);
  });

  it("ignores the separator row and prose", () => {
    expect(parsed.some((r) => r.versionName.includes("---"))).toBe(false);
    expect(parsed.some((r) => r.notes.includes("prune"))).toBe(false);
  });

  it("extracts the version code as a number", () => {
    expect(parsed[0].versionCode).toBe(1);
    expect(parsed[2].versionCode).toBe(7);
  });

  it("strips backticks and validates sha256 as 64 lowercase hex", () => {
    expect(parsed[0].sha256).toBe("cb3d20136da1005badceeafbd8a9033e426bc47cf8064528d4fd9f79f950300d");
    expect(parsed[0].sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects a malformed sha256 rather than storing junk", () => {
    const bad = parseReleaseLedger("| 2026-01-01 | 9.9.9 | 99 | `notahash` | 100 | notes |");
    expect(bad[0].sha256).toBeNull();
  });

  it("parses the APK size in bytes", () => {
    expect(parsed[0].sizeBytes).toBe(33313);
    expect(parsed[2].sizeBytes).toBe(83154);
  });

  it("flags the BROKEN release so it is never treated as distributable", () => {
    expect(parsed[1].broken).toBe(true);
    expect(parsed[0].broken).toBe(false);
    expect(parsed[2].broken).toBe(false);
  });

  it("keeps the do-NOT-install warning in the notes for the broken row", () => {
    expect(parsed[1].notes).toMatch(/hardened MessagingStyle parsing/);
  });

  it("captures the release date", () => {
    expect(parsed[0].date).toBe("2026-07-17");
  });

  it("returns an empty array for a ledger with no rows", () => {
    expect(parseReleaseLedger("# Nothing here\n\nsome prose\n")).toEqual([]);
  });

  it("returns an empty array for empty input", () => {
    expect(parseReleaseLedger("")).toEqual([]);
  });

  it("survives a row with missing trailing cells", () => {
    expect(parseReleaseLedger("| 2026-01-01 | 9.9.9 | 99 |")).toEqual([]);
  });
});
