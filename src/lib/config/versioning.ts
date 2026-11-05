import { desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { ctlConfigItem, ctlConfigRelease, ctlConfigRevision } from "@/db/schema";

/**
 * Versioned remote configuration.
 *
 * `ctl_config_item.value` is the DRAFT. A client never reads it. It reads a
 * published `ctl_config_release`, which pins an immutable snapshot of revisions.
 *
 * Why that matters operationally:
 *  - "What did app version 1.5.9 receive at 14:02 yesterday?" is answerable.
 *  - A bad edit is recovered by republishing the previous release, not by
 *    retyping nineteen values from memory.
 *  - Publishing is an explicit act, so an in-progress edit cannot leak to clients
 *    half-finished.
 *
 * Privacy: keys marked `sensitive` are excluded from every snapshot, and the
 * `privacy.*` invariants are included but flagged in the delivery payload so a
 * client can see they are pinned rather than merely current.
 */

export type SnapshotEntry = {
  version: number;
  valueType: "string" | "number" | "boolean" | "json";
  value: unknown;
  locked: boolean;
};

export type Snapshot = Record<string, SnapshotEntry>;

/** Appends an immutable revision for a config key. Called on every accepted edit. */
export async function recordRevision(input: {
  configItemId: string;
  key: string;
  valueType: "string" | "number" | "boolean" | "json";
  value: unknown;
  changeNote?: string | null;
  changedBy?: string | null;
}): Promise<{ version: number }> {
  const [current] = await db
    .select({ version: sql<number>`coalesce(max(${ctlConfigRevision.version}), 0)` })
    .from(ctlConfigRevision)
    .where(eq(ctlConfigRevision.key, input.key));

  const version = Number(current?.version ?? 0) + 1;
  await db.insert(ctlConfigRevision).values({
    configItemId: input.configItemId,
    key: input.key,
    version,
    valueType: input.valueType,
    value: input.value,
    changeNote: input.changeNote ?? null,
    changedBy: input.changedBy ?? null,
  });
  return { version };
}

/**
 * Publishes the current draft as a new immutable release.
 *
 * The previous `published` release becomes `superseded` in the same statement
 * flow, so there is never a moment with two live releases for the same client.
 */
export async function publishRelease(input: {
  publishedBy: string;
  changeNote?: string | null;
  minAppVersion?: string | null;
}): Promise<{ releaseId: string; version: number; keys: number; excluded: string[] }> {
  const items = await db.select().from(ctlConfigItem);

  const snapshot: Snapshot = {};
  const excluded: string[] = [];

  for (const item of items) {
    if (item.sensitive) {
      // A sensitive key is never delivered to a client through this channel.
      excluded.push(item.key);
      continue;
    }
    const [revision] = await db
      .select({ version: ctlConfigRevision.version })
      .from(ctlConfigRevision)
      .where(eq(ctlConfigRevision.key, item.key))
      .orderBy(desc(ctlConfigRevision.version))
      .limit(1);

    snapshot[item.key] = {
      version: revision?.version ?? 0,
      valueType: item.valueType as SnapshotEntry["valueType"],
      value: item.value,
      locked: item.locked,
    };
  }

  const [maxRow] = await db
    .select({ version: sql<number>`coalesce(max(${ctlConfigRelease.version}), 0)` })
    .from(ctlConfigRelease);
  const version = Number(maxRow?.version ?? 0) + 1;

  await db.update(ctlConfigRelease).set({ status: "superseded" }).where(eq(ctlConfigRelease.status, "published"));

  const [release] = await db
    .insert(ctlConfigRelease)
    .values({
      version,
      status: "published",
      snapshot,
      minAppVersion: input.minAppVersion ?? null,
      changeNote: input.changeNote ?? null,
      publishedBy: input.publishedBy,
      publishedAt: new Date(),
    })
    .returning({ id: ctlConfigRelease.id });

  return { releaseId: release.id, version, keys: Object.keys(snapshot).length, excluded };
}

/** Semver-ish comparison adequate for `minAppVersion` gating. */
export function compareAppVersion(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * Resolves what a client should receive.
 *
 * A `minAppVersion` gate narrows WHO a release applies to. It must never widen
 * the gap for everyone else: publishing a release gated to 2.0.0 supersedes the
 * previous one for 2.x clients, but a 1.5.9 client must keep receiving the newest
 * release whose gate it satisfies — not nothing.
 *
 * BUG FIXED HERE: this used to consider only `status = 'published'`, of which
 * there is exactly one at a time, so any gated release silently stripped
 * configuration from every older client. Superseded releases are now part of the
 * candidate set, newest first, and the first one the client qualifies for wins.
 *
 * A client that sends no appVersion can only prove it meets an UNGATED release,
 * so gated ones are skipped — failing closed, not open.
 *
 * Returns null when nothing applies: the client then falls back to its built-in
 * defaults, which is the honest answer. It must never be handed an empty object
 * that looks like "no configuration exists".
 */
export async function resolveConfigForClient(appVersion: string | null): Promise<{
  releaseVersion: number;
  publishedAt: string;
  minAppVersion: string | null;
  values: Snapshot;
} | null> {
  const candidates = await db
    .select()
    .from(ctlConfigRelease)
    .where(inArray(ctlConfigRelease.status, ["published", "superseded"]))
    .orderBy(desc(ctlConfigRelease.version))
    .limit(50);

  const applicable = candidates.find((release) => {
    if (!release.minAppVersion) return true;
    return appVersion !== null && compareAppVersion(appVersion, release.minAppVersion) >= 0;
  });
  if (!applicable) return null;

  return {
    releaseVersion: applicable.version,
    publishedAt: (applicable.publishedAt ?? applicable.createdAt).toISOString(),
    minAppVersion: applicable.minAppVersion,
    values: applicable.snapshot as Snapshot,
  };
}

/**
 * Pure form of the selection above, so the gating rules are testable without a
 * database. `candidates` must already be ordered newest-first.
 */
export function selectReleaseForClient<
  T extends { version: number; minAppVersion: string | null },
>(candidates: T[], appVersion: string | null): T | null {
  return (
    candidates.find((release) => {
      if (!release.minAppVersion) return true;
      return appVersion !== null && compareAppVersion(appVersion, release.minAppVersion) >= 0;
    }) ?? null
  );
}

export async function listReleases(limit = 20) {
  return db.select().from(ctlConfigRelease).orderBy(desc(ctlConfigRelease.version)).limit(limit);
}

export async function listRevisions(key?: string, limit = 50) {
  const where = key ? eq(ctlConfigRevision.key, key) : undefined;
  const base = db.select().from(ctlConfigRevision).$dynamic();
  if (where) base.where(where);
  return base.orderBy(desc(ctlConfigRevision.createdAt), desc(ctlConfigRevision.version)).limit(limit);
}

/** Current published release, for the Configuration page header. */
export async function currentRelease() {
  const [release] = await db
    .select()
    .from(ctlConfigRelease)
    .where(eq(ctlConfigRelease.status, "published"))
    .orderBy(desc(ctlConfigRelease.version))
    .limit(1);
  return release ?? null;
}

/** How far the draft has drifted from what is currently published. */
export async function draftDrift(): Promise<{
  publishedVersion: number | null;
  draftAhead: string[];
  neverRevised: string[];
}> {
  const release = await currentRelease();
  const items = await db.select().from(ctlConfigItem);
  const snapshot = (release?.snapshot ?? {}) as Snapshot;

  const draftAhead: string[] = [];
  const neverRevised: string[] = [];

  for (const item of items) {
    if (item.sensitive) continue;
    const published = snapshot[item.key];
    const [revision] = await db
      .select({ version: ctlConfigRevision.version })
      .from(ctlConfigRevision)
      .where(eq(ctlConfigRevision.key, item.key))
      .orderBy(desc(ctlConfigRevision.version))
      .limit(1);

    if (!revision) {
      neverRevised.push(item.key);
      continue;
    }
    if (!published || published.version !== revision.version) draftAhead.push(item.key);
  }

  return { publishedVersion: release?.version ?? null, draftAhead, neverRevised };
}
