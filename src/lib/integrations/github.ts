import { env } from "@/config/env";
import { db } from "@/db";
import { ctlRelease } from "@/db/schema";

/**
 * Read-only integration with the ReplyMate source repository.
 *
 * Purpose: keep `ctl_release` in sync with the authoritative ledger in
 * `releases/RELEASES.md`. This platform NEVER pushes to, mutates or deploys the
 * Android repository — the token (when present) is used for GET requests only,
 * is read from process.env, and is never rendered, logged or committed.
 */

const RAW_BASE = "https://raw.githubusercontent.com";

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { accept: "application/vnd.github+json" };
  if (env.GITHUB_READ_TOKEN) headers.authorization = `Bearer ${env.GITHUB_READ_TOKEN}`;
  return headers;
}

export type ParsedRelease = {
  versionName: string;
  versionCode: number | null;
  date: string | null;
  sha256: string | null;
  sizeBytes: number | null;
  notes: string;
  broken: boolean;
};

/**
 * Parses the markdown release ledger. Tolerates the repo's own conventions:
 * a `❌ BROKEN` marker in the version cell, backticked sha256, and prose notes.
 */
export function parseReleaseLedger(markdown: string): ParsedRelease[] {
  const rows: ParsedRelease[] = [];
  for (const line of markdown.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) continue;
    const cells = trimmed.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length < 6) continue;
    if (!/^20\d{2}-\d{2}-\d{2}$/.test(cells[0])) continue;

    const versionCell = cells[1];
    const versionMatch = versionCell.match(/(\d+\.\d+\.\d+)/);
    if (!versionMatch) continue;

    const versionCode = Number.parseInt(cells[2], 10);
    const sha = cells[3].replace(/`/g, "").trim();

    rows.push({
      versionName: versionMatch[1],
      versionCode: Number.isFinite(versionCode) ? versionCode : null,
      date: cells[0],
      sha256: /^[a-f0-9]{64}$/i.test(sha) ? sha.toLowerCase() : null,
      sizeBytes: /^\d+$/.test(cells[4]) ? Number.parseInt(cells[4], 10) : null,
      notes: cells.slice(5).join(" | "),
      broken: /broken|do not install/i.test(versionCell),
    });
  }
  return rows;
}

export async function fetchReleaseLedger(): Promise<
  | { ok: true; releases: ParsedRelease[]; fetchedAt: string; source: string }
  | { ok: false; error: string; code: "unreachable" | "parse_failed" }
> {
  const source = `${env.REPLYMATE_REPO}/releases/RELEASES.md`;
  const url = `${RAW_BASE}/${env.REPLYMATE_REPO}/HEAD/releases/RELEASES.md`;

  try {
    const response = await fetch(url, {
      headers: authHeaders(),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      return { ok: false, error: `GitHub returned HTTP ${response.status}`, code: "unreachable" };
    }
    const markdown = await response.text();
    const releases = parseReleaseLedger(markdown);
    if (releases.length === 0) {
      return { ok: false, error: "No release rows could be parsed from the ledger.", code: "parse_failed" };
    }
    return { ok: true, releases, fetchedAt: new Date().toISOString(), source };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? `${error.name}: network unreachable from this host` : "unknown",
      code: "unreachable",
    };
  }
}

/** Upserts parsed releases into the control plane. Idempotent. */
export async function syncReleases(releases: ParsedRelease[]) {
  let inserted = 0;
  let updated = 0;
  for (const release of releases) {
    const result = await db
      .insert(ctlRelease)
      .values({
        versionName: release.versionName,
        versionCode: release.versionCode ?? 0,
        channel: "production",
        status: release.broken ? "broken" : "published",
        apkSha256: release.sha256,
        apkSizeBytes: release.sizeBytes,
        notes: release.notes,
        publishedAt: release.date ? new Date(`${release.date}T00:00:00Z`) : null,
      })
      .onConflictDoUpdate({
        target: ctlRelease.versionName,
        set: {
          versionCode: release.versionCode ?? 0,
          status: release.broken ? "broken" : "published",
          apkSha256: release.sha256,
          apkSizeBytes: release.sizeBytes,
          notes: release.notes,
          publishedAt: release.date ? new Date(`${release.date}T00:00:00Z`) : null,
          updatedAt: new Date(),
        },
      })
      .returning({ id: ctlRelease.id, createdAt: ctlRelease.createdAt });
    // A row created in this call has createdAt == now within a second.
    if (result[0] && Date.now() - result[0].createdAt.getTime() < 2000) inserted += 1;
    else updated += 1;
  }
  return { inserted, updated };
}

/** Reads the applied-migration ledger straight from the repo docs. */
export async function fetchSupabaseMigrationLedger(): Promise<
  | { ok: true; rows: Array<{ version: string; file: string; applied: string }>; source: string }
  | { ok: false; error: string; code: "unreachable" | "parse_failed" }
> {
  const url = `${RAW_BASE}/${env.REPLYMATE_REPO}/HEAD/docs/supabase/README.md`;
  try {
    const response = await fetch(url, { headers: authHeaders(), cache: "no-store", signal: AbortSignal.timeout(15_000) });
    if (!response.ok) return { ok: false, error: `GitHub returned HTTP ${response.status}`, code: "unreachable" };
    const markdown = await response.text();
    const rows: Array<{ version: string; file: string; applied: string }> = [];
    for (const line of markdown.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("|")) continue;
      const cells = trimmed.split("|").slice(1, -1).map((c) => c.trim());
      if (cells.length < 3) continue;
      if (!/^(0\d{3}|verify)$/.test(cells[0])) continue;
      rows.push({ version: cells[0], file: cells[1].replace(/`/g, ""), applied: cells[2] });
    }
    if (rows.length === 0) return { ok: false, error: "No migration rows parsed.", code: "parse_failed" };
    return { ok: true, rows, source: `${env.REPLYMATE_REPO}/docs/supabase/README.md` };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? `${error.name}: network unreachable from this host` : "unknown",
      code: "unreachable",
    };
  }
}
