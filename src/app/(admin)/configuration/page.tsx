import type { Metadata } from "next";
import { Lock, SlidersHorizontal } from "lucide-react";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { StatCard } from "@/components/shared/stat-card";
import { StatusBadge } from "@/components/shared/status-badge";
import { ConfigDialog } from "@/components/forms/forms";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requireCapability } from "@/lib/authz/guard";
import { can } from "@/lib/authz/permissions";
import { formatRelative } from "@/lib/utils";
import { configStats, listConfig } from "@/lib/queries/ops";

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
  const [items, stats] = await Promise.all([listConfig(), configStats()]);

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
        <StatCard label="Editable" value={stats.total - stats.locked} hint="Changeable by config:manage" icon={SlidersHorizontal} tone="positive" />
        <StatCard label="Categories" value={categories.length} hint={categories.join(", ") || "none"} icon={SlidersHorizontal} tone="neutral" />
      </div>

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
