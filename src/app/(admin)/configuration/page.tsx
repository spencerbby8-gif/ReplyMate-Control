import type { Metadata } from "next";
import { Tag, History as HistoryIcon, Lock, SlidersHorizontal } from "lucide-react";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { StatCard } from "@/components/shared/stat-card";
import { StatusBadge } from "@/components/shared/status-badge";
import { AsyncAction } from "@/components/shared/async-action";
import { ConfigDialog } from "@/components/forms/forms";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requireCapability } from "@/lib/authz/guard";
import { can } from "@/lib/authz/permissions";
import { formatDateTime, formatRelative } from "@/lib/utils";
import { configStats, listConfig } from "@/lib/queries/ops";
import { currentRelease, draftDrift, listReleases } from "@/lib/config/versioning";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Configuration" };

function renderValue(valueType: string, value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (valueType === "json") return JSON.stringify(value);
  return String(value);
}

export default async function ConfigurationPage() {
  const { admin } = await requireCapability("config:view");
  const manageable = can(admin.role, "config:manage");
  const [items, stats, release, releases, drift] = await Promise.all([
    listConfig(),
    configStats(),
    currentRelease(),
    listReleases(10),
    draftDrift(),
  ]);

  const categories = [...new Set(items.map((item) => item.category))].sort();

  return (
    <>
      <PageHeader
        title="Configuration"
        description="Remote configuration served to the Android client. Values transcribed from docs/BLUEPRINT.md, docs/SPEC.md and docs/provider-capability-map.md — the documented contract of the shipped app, not invented defaults."
        meta={
          <>
            <Badge variant="outline" className="font-mono text-[11px]">{stats.total} keys</Badge>
            <Badge variant="warning" className="font-mono text-[11px]">{stats.locked} locked</Badge>
            <Badge variant="outline" className="font-mono text-[11px]">{categories.length} categories</Badge>
          </>
        }
      />

      <Alert variant="destructive">
        <Lock aria-hidden />
        <AlertTitle>Locked keys and privacy invariants are not editable at runtime</AlertTitle>
        <AlertDescription>
          <p>
            Keys under <span className="font-mono">privacy.*</span> and anything marked{" "}
            <span className="font-mono">locked</span> are pinned by the app contract. The server
            rejects an edit with 403 (or 451 for a privacy invariant) and records the attempt.
            Changing one of those means changing code, passing tests and shipping a release.
          </p>
          <p>
            This table also refuses to store secrets: a key marked{" "}
            <span className="font-mono">sensitive</span> cannot be written through the API at all.
          </p>
        </AlertDescription>
      </Alert>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Keys" value={stats.total} hint="Remote configuration entries" icon={SlidersHorizontal} tone={stats.total === 0 ? "warning" : "neutral"} />
        <StatCard label="Locked" value={stats.locked} hint="Pinned by the app contract" icon={Lock} tone="warning" />
        <StatCard
          label="Published release"
          value={release ? `v${release.version}` : "none"}
          hint={release ? `Published ${formatRelative(release.publishedAt ?? release.createdAt)}` : "Clients are using their built-in defaults"}
          icon={Tag}
          tone={release ? "positive" : "warning"}
        />
        <StatCard
          label="Draft drift"
          value={drift.draftAhead.length}
          hint={drift.draftAhead.length > 0 ? `Edited but not published: ${drift.draftAhead.slice(0, 3).join(", ")}${drift.draftAhead.length > 3 ? "…" : ""}` : "Draft matches the published release"}
          icon={HistoryIcon}
          tone={drift.draftAhead.length > 0 ? "warning" : "positive"}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Tag className="size-4 text-primary" aria-hidden />
            Versioned delivery
          </CardTitle>
          <CardDescription>
            The table below is the DRAFT. A client never reads it: it receives the published release
            from <span className="font-mono">GET /api/client/config?appVersion=1.5.9</span>, which pins
            an immutable snapshot. That makes &ldquo;what did 1.5.9 receive yesterday?&rdquo; answerable,
            and makes a bad edit recoverable by republishing rather than retyping.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {release ? (
            <div className="rounded-lg border bg-muted/20 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="success" className="font-mono text-[11px]">v{release.version} published</Badge>
                <span className="font-mono text-[11px] text-muted-foreground">
                  {formatDateTime(release.publishedAt ?? release.createdAt)}
                </span>
                {release.minAppVersion ? (
                  <Badge variant="outline" className="font-mono text-[11px]">min app {release.minAppVersion}</Badge>
                ) : (
                  <Badge variant="outline" className="font-mono text-[11px]">all app versions</Badge>
                )}
                <span className="ml-auto font-mono text-[11px] text-muted-foreground">
                  {Object.keys(release.snapshot as Record<string, unknown>).length} keys in snapshot
                </span>
              </div>
              {release.changeNote ? (
                <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">{release.changeNote}</p>
              ) : null}
            </div>
          ) : (
            <EmptyState
              icon={Tag}
              title="No configuration release has been published"
              reason="Draft values exist but nothing is being served. GET /api/client/config returns release: null with an explicit instruction to use built-in defaults, so a client can tell 'nothing published' apart from 'published an empty set'."
              nextStep={manageable ? "Publish a release once the draft values are the ones you want clients to receive." : "An operator, admin or owner can publish."}
              tone="waiting"
            />
          )}

          {drift.draftAhead.length > 0 ? (
            <p className="rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-[11px] leading-relaxed text-warning">
              {drift.draftAhead.length} key(s) have been edited since the last publish:{" "}
              <span className="font-mono">{drift.draftAhead.join(", ")}</span>. Clients are still
              receiving the older values.
            </p>
          ) : null}

          {drift.neverRevised.length > 0 ? (
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {drift.neverRevised.length} key(s) have no revision history yet — they were seeded
              directly and will gain a revision on their first edit.
            </p>
          ) : null}

          {manageable ? (
            <AsyncAction
              endpoint="/api/control"
              payload={{ resource: "config", operation: "publish", values: { changeNote: null, minAppVersion: null } }}
              icon={<Tag className="size-4" aria-hidden />}
              label={release ? `Publish v${release.version + 1} from current draft` : "Publish first release"}
              variant="default"
              confirm="Publish the current draft as a new immutable release? The previously published release becomes superseded and clients start receiving this snapshot."
            />
          ) : null}

          {releases.length > 1 ? (
            <div>
              <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                <HistoryIcon className="size-3.5" aria-hidden />
                Release history
              </p>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Version</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Keys</TableHead>
                    <TableHead>Min app</TableHead>
                    <TableHead>Published</TableHead>
                    <TableHead>Note</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {releases.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell className="font-mono text-xs">v{row.version}</TableCell>
                      <TableCell><StatusBadge value={row.status === "published" ? "active" : row.status === "superseded" ? "disabled" : "invited"} /></TableCell>
                      <TableCell className="font-mono text-[11px]">{Object.keys(row.snapshot as Record<string, unknown>).length}</TableCell>
                      <TableCell className="font-mono text-[11px]">{row.minAppVersion ?? "any"}</TableCell>
                      <TableCell className="whitespace-nowrap text-[11px] text-muted-foreground">
                        {formatDateTime(row.publishedAt ?? row.createdAt)}
                      </TableCell>
                      <TableCell className="max-w-[280px] text-[11px] text-muted-foreground">{row.changeNote ?? "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <SlidersHorizontal className="size-4 text-primary" aria-hidden />
            Configuration keys
          </CardTitle>
          <CardDescription>Grouped by category. Each row shows the value the client would receive.</CardDescription>
        </CardHeader>
        <CardContent>
          {items.length === 0 ? (
            <EmptyState
              icon={SlidersHorizontal}
              title="No configuration keys exist"
              reason="Keys are seeded from the ReplyMate documentation by the bootstrap script, or would be created here. Nothing is pre-populated with invented defaults."
              nextStep="Run `npx tsx scripts/bootstrap.ts` to load the reference configuration set."
              tone="waiting"
            />
          ) : (
            <div className="space-y-6">
              {categories.map((category) => (
                <section key={category}>
                  <h3 className="mb-2 font-mono text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    {category}
                  </h3>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Key</TableHead>
                        <TableHead>Type</TableHead>
                        <TableHead>Value</TableHead>
                        <TableHead>State</TableHead>
                        <TableHead>Updated</TableHead>
                        <TableHead className="text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {items
                        .filter((item) => item.category === category)
                        .map((item) => (
                          <TableRow key={item.id}>
                            <TableCell className="max-w-[320px]">
                              <p className="flex items-center gap-1.5 font-mono text-[11px] font-medium">
                                {item.key}
                                {item.locked ? <Lock className="size-3 shrink-0 text-warning" aria-hidden /> : null}
                              </p>
                              {item.description ? (
                                <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{item.description}</p>
                              ) : null}
                            </TableCell>
                            <TableCell><StatusBadge value={item.valueType} /></TableCell>
                            <TableCell className="max-w-[260px] break-all font-mono text-[11px]">
                              {renderValue(item.valueType, item.value)}
                            </TableCell>
                            <TableCell>
                              <StatusBadge value={item.locked ? "disabled" : "active"} />
                              {item.sensitive ? <p className="mt-1 font-mono text-[10px] text-destructive">sensitive · write-refused</p> : null}
                            </TableCell>
                            <TableCell className="whitespace-nowrap text-[11px] text-muted-foreground">{formatRelative(item.updatedAt)}</TableCell>
                            <TableCell className="text-right">
                              <ConfigDialog
                                canManage={manageable}
                                item={{ id: item.id, key: item.key, valueType: item.valueType, value: item.value, locked: item.locked, description: item.description }}
                              />
                            </TableCell>
                          </TableRow>
                        ))}
                    </TableBody>
                  </Table>
                </section>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}
