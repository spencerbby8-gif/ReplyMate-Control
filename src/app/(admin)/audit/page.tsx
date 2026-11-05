import type { Metadata } from "next";
import { ScrollText, ShieldOff } from "lucide-react";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { StatCard } from "@/components/shared/stat-card";
import { StatusBadge, Dot } from "@/components/shared/status-badge";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requireCapability } from "@/lib/authz/guard";
import { formatDateTime } from "@/lib/utils";
import { auditStats, distinctAuditActions, listAudit } from "@/lib/queries/ops";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Audit log" };

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ action?: string; limit?: string }>;
}) {
  const { admin } = await requireCapability("audit:view");
  const params = await searchParams;
  const limit = Math.min(Math.max(Number(params.limit ?? 100) || 100, 10), 500);

  const [entries, stats, actions] = await Promise.all([
    listAudit({ limit, action: params.action }),
    auditStats(),
    distinctAuditActions(),
  ]);

  return (
    <>
      <PageHeader
        title="Audit log"
        description="Append-only record of every privileged action. There is no update path, no delete path and no API route in this repository that can mutate these rows — a rejected attempt is recorded exactly like a completed one."
        meta={
          <>
            <Badge variant="outline" className="font-mono text-[11px]">{stats.total} entries</Badge>
            <Badge variant="outline" className="font-mono text-[11px]">{stats.last7Days} last 7 days</Badge>
            <Badge variant={stats.denied > 0 ? "warning" : "outline"} className="font-mono text-[11px]">{stats.denied} denied</Badge>
            <Badge variant={stats.privacyViolations > 0 ? "destructive" : "success"} className="font-mono text-[11px]">
              {stats.privacyViolations} privacy violations
            </Badge>
          </>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Total entries" value={stats.total} hint="Written by real actions only" icon={ScrollText} tone={stats.total === 0 ? "muted" : "neutral"} />
        <StatCard label="Last 7 days" value={stats.last7Days} hint="Activity in the current window" icon={ScrollText} tone="neutral" />
        <StatCard label="Denied" value={stats.denied} hint="403s, lockouts and revoked invitations" icon={ShieldOff} tone={stats.denied > 0 ? "warning" : "positive"} />
        <StatCard label="Privacy violations" value={stats.privacyViolations} hint="Blocked attempts to read denied tables" icon={ShieldOff} tone={stats.privacyViolations > 0 ? "critical" : "positive"} />
      </div>

      {actions.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Filter by action</CardTitle>
            <CardDescription>
              {actions.length} distinct action type(s) recorded. Filtering is a link, so it is
              shareable and server-rendered.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            <Badge variant={!params.action ? "default" : "outline"} className="font-mono text-[11px]">
              <a href="/audit" className={!params.action ? "pointer-events-none" : undefined}>all</a>
            </Badge>
            {actions.map((action) => (
              <a key={action} href={`/audit?action=${encodeURIComponent(action)}&limit=${limit}`}>
                <Badge variant={params.action === action ? "default" : "outline"} className="font-mono text-[11px] hover:bg-accent">
                  {action}
                </Badge>
              </a>
            ))}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ScrollText className="size-4 text-primary" aria-hidden />
            Entries {params.action ? <span className="font-mono text-xs text-muted-foreground">({params.action})</span> : null}
          </CardTitle>
          <CardDescription>
            Showing the most recent {Math.min(limit, entries.length)} of {stats.total}. Detail payloads
            pass through redaction before they are written — credential-shaped keys and content-shaped
            fields are replaced, never stored.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {entries.length === 0 ? (
            <EmptyState
              icon={ScrollText}
              title={params.action ? `No entries for ${params.action}` : "The audit log is empty"}
              reason={
                params.action
                  ? "No action of that type has been recorded yet."
                  : "Nothing is pre-populated. Entries appear the moment a real privileged action occurs — a sign-in, an invitation, a flag change or a denial."
              }
              nextStep={params.action ? "Clear the filter to see every action type." : "Sign out and back in, or issue an invitation from Users."}
              tone="neutral"
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Timestamp (UTC)</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Actor</TableHead>
                  <TableHead>Target</TableHead>
                  <TableHead>Outcome</TableHead>
                  <TableHead>Detail</TableHead>
                  <TableHead>Request</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.map((entry) => (
                  <TableRow key={entry.id}>
                    <TableCell className="whitespace-nowrap font-mono text-[11px] text-muted-foreground">
                      {formatDateTime(entry.ts)}
                    </TableCell>
                    <TableCell className="font-mono text-[11px]">{entry.action}</TableCell>
                    <TableCell>
                      <p className="text-xs">{entry.actorEmail ?? "system"}</p>
                      {entry.actorRole ? <p className="font-mono text-[10px] text-muted-foreground">{entry.actorRole}</p> : null}
                      {entry.ip ? <p className="font-mono text-[10px] text-muted-foreground">{entry.ip}</p> : null}
                    </TableCell>
                    <TableCell className="font-mono text-[11px] text-muted-foreground">
                      {entry.entity ? `${entry.entity}${entry.entityId ? `:${entry.entityId.slice(0, 8)}` : ""}` : "—"}
                    </TableCell>
                    <TableCell>
                      <span className="flex items-center gap-1.5">
                        <Dot tone={entry.outcome === "success" ? "success" : entry.outcome === "denied" ? "destructive" : "warning"} />
                        <StatusBadge value={entry.outcome} />
                      </span>
                    </TableCell>
                    <TableCell className="max-w-[360px]">
                      {entry.detail ? (
                        <pre className="max-h-24 overflow-auto rounded bg-muted/40 p-2 font-mono text-[10px] leading-relaxed text-muted-foreground scrollbar-thin">
                          {JSON.stringify(entry.detail, null, 1)}
                        </pre>
                      ) : (
                        <span className="text-[11px] text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-[10px] text-muted-foreground">
                      {entry.requestId ? entry.requestId.slice(0, 8) : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          <p className="mt-4 text-[11px] leading-relaxed text-muted-foreground">
            Signed in as <span className="font-mono">{admin.email}</span> ({admin.role}). Reading this
            page is itself an authorized action gated on <span className="font-mono">audit:view</span>.
          </p>
        </CardContent>
      </Card>
    </>
  );
}
