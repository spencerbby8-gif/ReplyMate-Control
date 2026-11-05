import type { Metadata } from "next";
import { Activity, Radar, TriangleAlert } from "lucide-react";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { StatCard } from "@/components/shared/stat-card";
import { StatusBadge, Dot } from "@/components/shared/status-badge";
import { AsyncAction } from "@/components/shared/async-action";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requireCapability } from "@/lib/authz/guard";
import { can } from "@/lib/authz/permissions";
import { formatDateTime } from "@/lib/utils";
import { defaultProbeTargets } from "@/lib/monitoring/probes";
import { latestProbePerTarget, listProbes } from "@/lib/queries/ops";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Monitoring" };

export default async function MonitoringPage() {
  const { admin } = await requireCapability("monitoring:view");
  const canRun = can(admin.role, "monitoring:run");
  const [latest, history] = await Promise.all([latestProbePerTarget(), listProbes()]);

  const targets = defaultProbeTargets();
  const healthy = latest.filter((p) => p.status === "ok").length;
  const degraded = latest.filter((p) => p.status === "degraded").length;
  const down = latest.filter((p) => p.status === "down").length;

  return (
    <>
      <PageHeader
        title="Monitoring"
        description="On-demand reachability probes against the dependencies this platform and the ReplyMate client rely on. Results are real HTTP measurements taken from this server and persisted per run."
        actions={
          canRun ? (
            <AsyncAction
              endpoint="/api/control"
              payload={{ resource: "probe", operation: "run", values: {} }}
              icon={<Radar className="size-4" aria-hidden />}
              label="Run probe suite"
              confirm={`Probe all ${targets.length + 1} targets now? Each request times out after 8 seconds.`}
            />
          ) : undefined
        }
        meta={
          <>
            <Badge variant="outline" className="font-mono text-[11px]">{targets.length + 1} targets</Badge>
            <Badge variant={down > 0 ? "destructive" : "success"} className="font-mono text-[11px]">{healthy} healthy</Badge>
            {degraded > 0 ? <Badge variant="warning" className="font-mono text-[11px]">{degraded} degraded</Badge> : null}
            {down > 0 ? <Badge variant="destructive" className="font-mono text-[11px]">{down} down</Badge> : null}
          </>
        }
      />

      <Alert>
        <TriangleAlert aria-hidden />
        <AlertTitle>What a probe can and cannot prove</AlertTitle>
        <AlertDescription>
          <p>
            These are unauthenticated reachability checks: DNS resolution, TLS handshake and an HTTP
            response. ReplyMate is BYOK, so this platform holds no provider key and cannot verify
            anyone&rsquo;s quota, billing or key validity. An HTTP 401 from a provider API is recorded
            as <span className="font-mono">reachable</span>, not as a failure.
          </p>
          <p>
            Nothing runs on a schedule in this deployment. Probes execute when an operator triggers
            them, which is stated plainly rather than implying continuous monitoring.
          </p>
        </AlertDescription>
      </Alert>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Targets" value={targets.length + 1} hint="Database plus external dependencies" icon={Activity} tone="neutral" />
        <StatCard label="Healthy" value={latest.length > 0 ? healthy : "—"} hint={latest.length > 0 ? "Responded below 1500ms" : "No probes run yet"} icon={Activity} tone={latest.length === 0 ? "muted" : "positive"} />
        <StatCard label="Degraded" value={latest.length > 0 ? degraded : "—"} hint="Reachable but slow or 5xx" icon={TriangleAlert} tone={degraded > 0 ? "warning" : "positive"} />
        <StatCard label="Down" value={latest.length > 0 ? down : "—"} hint="No response or server error" icon={TriangleAlert} tone={down > 0 ? "critical" : "positive"} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Activity className="size-4 text-primary" aria-hidden />
            Latest result per target
          </CardTitle>
          <CardDescription>Most recent measurement for each target, newest first.</CardDescription>
        </CardHeader>
        <CardContent>
          {latest.length === 0 ? (
            <EmptyState
              icon={Activity}
              title="No probes have run in this environment"
              reason="Probe results are recorded only when the suite is executed. There is no background scheduler and no cached result carried over from another deployment, so this list starts empty."
              nextStep={canRun ? "Use “Run probe suite”. Expect provider endpoints to answer 401 or 404 — that still counts as reachable." : "An operator or owner can run the suite."}
              tone="waiting"
              action={
                canRun ? (
                  <AsyncAction
                    endpoint="/api/control"
                    payload={{ resource: "probe", operation: "run", values: {} }}
                    icon={<Radar className="size-4" aria-hidden />}
                    label="Run probe suite"
                  />
                ) : undefined
              }
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Target</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Latency</TableHead>
                  <TableHead className="text-right">HTTP</TableHead>
                  <TableHead>Detail</TableHead>
                  <TableHead>Checked</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {latest.map((probe) => (
                  <TableRow key={probe.target}>
                    <TableCell>
                      <p className="flex items-center gap-2 font-mono text-[11px]">
                        <Dot tone={probe.status === "ok" ? "success" : probe.status === "degraded" ? "warning" : "destructive"} pulse={probe.status !== "ok"} />
                        {probe.target}
                      </p>
                    </TableCell>
                    <TableCell className="font-mono text-[11px] text-muted-foreground">{probe.kind}</TableCell>
                    <TableCell><StatusBadge value={probe.status} /></TableCell>
                    <TableCell className="text-right font-mono text-xs">{probe.latencyMs !== null ? `${probe.latencyMs}ms` : "—"}</TableCell>
                    <TableCell className="text-right font-mono text-xs">{probe.httpStatus ?? "—"}</TableCell>
                    <TableCell className="max-w-[320px] text-[11px] leading-relaxed text-muted-foreground">{probe.message ?? "—"}</TableCell>
                    <TableCell className="whitespace-nowrap text-[11px] text-muted-foreground">{formatDateTime(probe.checkedAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Configured targets</CardTitle>
          <CardDescription>Derived from the provider catalogue, so a new provider in the client automatically becomes a monitored dependency.</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            <li className="rounded-md border px-3 py-2">
              <p className="font-mono text-[11px]">control-plane postgres</p>
              <p className="mt-0.5 text-[10px] text-muted-foreground">select 1 · database</p>
            </li>
            {targets.map((target) => (
              <li key={target.target} className="rounded-md border px-3 py-2">
                <p className="font-mono text-[11px]">{target.target}</p>
                <p className="mt-0.5 break-all text-[10px] text-muted-foreground">{target.url}</p>
              </li>
            ))}
          </ul>
          <p className="mt-4 text-[11px] leading-relaxed text-muted-foreground">
            {history.length} historical probe result(s) retained. Each run appends; nothing is
            overwritten, so a degradation can be traced back through previous runs.
          </p>
        </CardContent>
      </Card>
    </>
  );
}
