import type { Metadata } from "next";
import { Flag, Lock } from "lucide-react";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { StatCard } from "@/components/shared/stat-card";
import { StatusBadge } from "@/components/shared/status-badge";
import { AsyncAction } from "@/components/shared/async-action";
import { FlagDialog } from "@/components/forms/forms";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requireCapability } from "@/lib/authz/guard";
import { can } from "@/lib/authz/permissions";
import { formatRelative } from "@/lib/utils";
import { flagStats, listFeatureFlags } from "@/lib/queries/ops";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Feature flags" };

export default async function FeatureFlagsPage() {
  const { admin } = await requireCapability("flags:view");
  const manageable = can(admin.role, "flags:manage");
  const [flags, stats] = await Promise.all([listFeatureFlags(), flagStats()]);

  return (
    <>
      <PageHeader
        title="Feature flags"
        description="Rollout state for gated client behaviour. A flag marked “client not wired” is recorded honestly — the Android app does not read it yet, so changing it has no runtime effect."
        actions={manageable ? <FlagDialog canManage={manageable} /> : undefined}
        meta={
          <>
            <Badge variant="outline" className="font-mono text-[11px]">{stats.total} flags</Badge>
            <Badge variant="success" className="font-mono text-[11px]">{stats.on} on</Badge>
            <Badge variant="warning" className="font-mono text-[11px]">{stats.canary} canary</Badge>
            <Badge variant="info" className="font-mono text-[11px]">{stats.shadow} shadow</Badge>
            <Badge variant="muted" className="font-mono text-[11px]">{stats.off} off</Badge>
          </>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Total flags" value={stats.total} hint="Defined in the control plane" icon={Flag} tone={stats.total === 0 ? "warning" : "neutral"} />
        <StatCard label="On" value={stats.on} hint="100% rollout" icon={Flag} tone="positive" />
        <StatCard label="Canary" value={stats.canary} hint="Partial rollout" icon={Flag} tone="warning" />
        <StatCard label="Off" value={stats.off} hint="Not served to any client" icon={Flag} tone="muted" />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Flag className="size-4 text-primary" aria-hidden />
            Flags
          </CardTitle>
          <CardDescription>
            Invariants: a flag that is <span className="font-mono">off</span> must have 0% rollout;{" "}
            <span className="font-mono">on</span> means exactly 100%. Use{" "}
            <span className="font-mono">canary</span> for anything in between.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {flags.length === 0 ? (
            <EmptyState
              icon={Flag}
              title="No feature flags defined"
              reason="Flags are seeded from the ReplyMate repository by the bootstrap script, or created here. Nothing is pre-populated with example rows, so an empty table means an empty table."
              nextStep={manageable ? "Create a flag, or run `npx tsx scripts/bootstrap.ts` to load the reference set." : "An operator or owner can define flags."}
              tone="waiting"
              action={manageable ? <FlagDialog canManage={manageable} /> : undefined}
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Flag</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Rollout</TableHead>
                  <TableHead>Client</TableHead>
                  <TableHead>Min version</TableHead>
                  <TableHead>Updated</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {flags.map((flag) => {
                  const pinned = flag.key === "message_sync";
                  return (
                    <TableRow key={flag.id} className={pinned ? "bg-destructive/[0.04]" : undefined}>
                      <TableCell className="max-w-[420px]">
                        <p className="flex items-center gap-1.5 font-mono text-xs font-medium">
                          {flag.key}
                          {pinned ? <Lock className="size-3 text-destructive" aria-hidden /> : null}
                        </p>
                        <p className="mt-0.5 text-xs">{flag.name}</p>
                        {flag.description ? (
                          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{flag.description}</p>
                        ) : null}
                      </TableCell>
                      <TableCell><StatusBadge value={flag.status} /></TableCell>
                      <TableCell className="font-mono text-xs">{flag.rolloutPercent}%</TableCell>
                      <TableCell>
                        <StatusBadge value={flag.clientWired ? "active" : "disabled"} />
                        <p className="mt-1 text-[10px] text-muted-foreground">{flag.clientWired ? "read by the app" : "not read yet"}</p>
                      </TableCell>
                      <TableCell className="font-mono text-[11px] text-muted-foreground">{flag.minAppVersion ?? "any"}</TableCell>
                      <TableCell className="text-[11px] text-muted-foreground">{formatRelative(flag.updatedAt)}</TableCell>
                      <TableCell>
                        <div className="flex flex-wrap items-center justify-end gap-2">
                          <FlagDialog canManage={manageable && !pinned} flag={{ id: flag.id, key: flag.key, name: flag.name, description: flag.description, status: flag.status, rolloutPercent: flag.rolloutPercent, clientWired: flag.clientWired, minAppVersion: flag.minAppVersion }} />
                          {flag.status !== "on" && !pinned ? (
                            <AsyncAction
                              endpoint="/api/control"
                              payload={{ resource: "flag", operation: "upsert", values: { id: flag.id, key: flag.key, name: flag.name, description: flag.description, status: "on", rolloutPercent: 100, clientWired: flag.clientWired, minAppVersion: flag.minAppVersion } }}
                              label="Turn on"
                              variant="ghost"
                              disabled={!manageable}
                              confirm={`Turn ${flag.key} on at 100%?`}
                            />
                          ) : null}
                          {flag.status !== "off" && !pinned ? (
                            <AsyncAction
                              endpoint="/api/control"
                              payload={{ resource: "flag", operation: "upsert", values: { id: flag.id, key: flag.key, name: flag.name, description: flag.description, status: "off", rolloutPercent: 0, clientWired: flag.clientWired, minAppVersion: flag.minAppVersion } }}
                              label="Turn off"
                              variant="ghost"
                              disabled={!manageable}
                              confirm={`Turn ${flag.key} off?`}
                            />
                          ) : null}
                          {!pinned ? (
                            <AsyncAction
                              endpoint="/api/control"
                              payload={{ resource: "flag", operation: "remove", values: { id: flag.id } }}
                              label="Delete"
                              variant="destructive"
                              disabled={!manageable}
                              confirm={`Delete ${flag.key}? Clients reading it will fall back to their built-in default.`}
                            />
                          ) : (
                            <span className="text-[10px] text-destructive">pinned by contract</span>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </>
  );
}
