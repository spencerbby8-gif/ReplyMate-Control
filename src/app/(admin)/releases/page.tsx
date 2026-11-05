import type { Metadata } from "next";
import { Download, GitCommitHorizontal, Package, TriangleAlert } from "lucide-react";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { StatCard } from "@/components/shared/stat-card";
import { StatusBadge } from "@/components/shared/status-badge";
import { AsyncAction } from "@/components/shared/async-action";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requireCapability } from "@/lib/authz/guard";
import { can } from "@/lib/authz/permissions";
import { envReport } from "@/config/env";
import { SOURCE_FILES } from "@/config/catalog";
import { formatBytes, formatDateTime } from "@/lib/utils";
import { listReleases, releaseStats } from "@/lib/queries/ops";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Releases" };

export default async function ReleasesPage() {
  const { admin } = await requireCapability("releases:view");
  const manageable = can(admin.role, "releases:manage");
  const [releases, stats] = await Promise.all([listReleases(), releaseStats()]);
  const report = envReport();

  const broken = releases.filter((r) => r.status === "broken");

  return (
    <>
      <PageHeader
        title="Releases"
        description="APK release ledger for the Android client. Syncing reads releases/RELEASES.md from the source repository — this platform never builds, signs, pushes to, or deploys the Android app."
        actions={
          manageable ? (
            <AsyncAction
              endpoint="/api/control"
              payload={{ resource: "release", operation: "syncFromSource", values: {} }}
              icon={<Download className="size-4" aria-hidden />}
              label="Sync from source"
              confirm={`Fetch and parse releases/RELEASES.md from ${report.replymate.repo}? Existing versions are updated in place; nothing is written back to the repository.`}
            />
          ) : undefined
        }
        meta={
          <>
            <Badge variant="outline" className="font-mono text-[11px]">{stats.total} tracked</Badge>
            <Badge variant="success" className="font-mono text-[11px]">{stats.published} published</Badge>
            {stats.broken > 0 ? <Badge variant="destructive" className="font-mono text-[11px]">{stats.broken} broken</Badge> : null}
            <Badge variant="outline" className="font-mono text-[11px]">repo: {report.replymate.repo}</Badge>
          </>
        }
      />

      <Alert variant={broken.length > 0 ? "warning" : "default"}>
        <TriangleAlert aria-hidden />
        <AlertTitle>Read-only integration</AlertTitle>
        <AlertDescription>
          <p>
            The GitHub token (when configured) is used for <span className="font-mono">GET</span>{" "}
            requests only, is read from <span className="font-mono">process.env</span>, and is never
            rendered, logged, committed or returned by an API route. The source repository is not
            modified by anything in this codebase.
          </p>
          {broken.length > 0 ? (
            <p className="font-medium">
              {broken.length} release(s) are marked BROKEN in the source ledger:{" "}
              {broken.map((b) => b.versionName).join(", ")}. Do not distribute them.
            </p>
          ) : null}
        </AlertDescription>
      </Alert>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Releases tracked" value={stats.total} hint={`Parsed from ${SOURCE_FILES.releases}`} icon={Package} tone={stats.total === 0 ? "warning" : "neutral"} />
        <StatCard label="Published" value={stats.published} hint="Available to users" icon={Package} tone="positive" />
        <StatCard label="Marked broken" value={stats.broken} hint="Flagged do-not-install in the ledger" icon={TriangleAlert} tone={stats.broken > 0 ? "critical" : "positive"} />
        <StatCard
          label="Latest"
          value={stats.latest ? stats.latest.versionName : "—"}
          hint={stats.latest ? `versionCode ${stats.latest.versionCode}` : "Ledger not imported yet"}
          icon={GitCommitHorizontal}
          tone={stats.latest ? "neutral" : "muted"}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Package className="size-4 text-primary" aria-hidden />
            Release ledger
          </CardTitle>
          <CardDescription>
            sha256 and size come straight from the source ledger so a distributed APK can be verified
            against what was recorded at build time.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {releases.length === 0 ? (
            <EmptyState
              icon={Package}
              title="The release ledger has not been imported"
              reason={`Nothing has been read from ${SOURCE_FILES.releases} in this environment yet. The table is genuinely empty — no placeholder versions are shown.`}
              nextStep={
                manageable
                  ? "Use “Sync from source”. It requires network egress to raw.githubusercontent.com; if this host has no route out, the action fails with an explicit upstream error rather than inventing rows."
                  : "An operator or owner can trigger the sync."
              }
              tone="waiting"
              action={
                manageable ? (
                  <AsyncAction
                    endpoint="/api/control"
                    payload={{ resource: "release", operation: "syncFromSource", values: {} }}
                    icon={<Download className="size-4" aria-hidden />}
                    label="Sync from source"
                  />
                ) : undefined
              }
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Version</TableHead>
                  <TableHead>Code</TableHead>
                  <TableHead>Channel</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Size</TableHead>
                  <TableHead>sha256</TableHead>
                  <TableHead>Published</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {releases.map((release) => (
                  <TableRow key={release.id} className={release.status === "broken" ? "bg-destructive/[0.04]" : undefined}>
                    <TableCell>
                      <p className="font-mono text-xs font-medium">{release.versionName}</p>
                      {release.notes ? (
                        <p className="mt-1 max-w-[420px] text-[11px] leading-relaxed text-muted-foreground">{release.notes}</p>
                      ) : null}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{release.versionCode}</TableCell>
                    <TableCell><StatusBadge value={release.channel === "production" ? "active" : release.channel} /></TableCell>
                    <TableCell><StatusBadge value={release.status} /></TableCell>
                    <TableCell className="font-mono text-[11px]">{formatBytes(release.apkSizeBytes)}</TableCell>
                    <TableCell className="max-w-[160px] truncate font-mono text-[10px] text-muted-foreground" title={release.apkSha256 ?? undefined}>
                      {release.apkSha256 ? `${release.apkSha256.slice(0, 16)}…` : "—"}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-[11px] text-muted-foreground">
                      {release.publishedAt ? formatDateTime(release.publishedAt) : "—"}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap items-center justify-end gap-2">
                        {release.status !== "paused" ? (
                          <AsyncAction
                            endpoint="/api/control"
                            payload={{ resource: "release", operation: "update", values: { id: release.id, status: "paused" } }}
                            label="Pause"
                            variant="ghost"
                            disabled={!manageable || release.status === "broken"}
                            disabledReason={release.status === "broken" ? "Already flagged broken in the source ledger." : undefined}
                            confirm={`Pause ${release.versionName}?`}
                          />
                        ) : (
                          <AsyncAction
                            endpoint="/api/control"
                            payload={{ resource: "release", operation: "update", values: { id: release.id, status: "published" } }}
                            label="Resume"
                            variant="ghost"
                            disabled={!manageable}
                            confirm={`Resume ${release.versionName}?`}
                          />
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </>
  );
}
