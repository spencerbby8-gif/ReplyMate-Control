import type { Metadata } from "next";
import { GitBranch, TriangleAlert } from "lucide-react";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { StatCard } from "@/components/shared/stat-card";
import { StatusBadge } from "@/components/shared/status-badge";
import { AsyncAction } from "@/components/shared/async-action";
import { RouteDialog } from "@/components/forms/forms";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requireCapability } from "@/lib/authz/guard";
import { can } from "@/lib/authz/permissions";
import { OUTPUT_CAP_RULE, TASK_CATALOGUE, effectiveOutputCap, providerByKey } from "@/config/catalog";
import { listRoutes, routeStats } from "@/lib/queries/ops";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Model routing" };

export default async function ModelRoutingPage() {
  const { admin } = await requireCapability("routing:view");
  const manageable = can(admin.role, "routing:manage");
  const [routes, stats] = await Promise.all([listRoutes(), routeStats()]);

  const violations = routes.filter((route) => route.maxOutputTokens < effectiveOutputCap(route.thinking));
  const tasksCovered = new Set(routes.filter((r) => r.enabled).map((r) => r.task));
  const uncovered = TASK_CATALOGUE.filter((task) => !tasksCovered.has(task.key));

  return (
    <>
      <PageHeader
        title="Model routing"
        description="Task-to-model policy. The Android client resolves a task against these rows at generation time; the server rejects any provider the client does not implement and any output cap that would starve a thinking-enabled reply."
        actions={manageable ? <RouteDialog canManage={manageable} /> : undefined}
        meta={
          <>
            <Badge variant="outline" className="font-mono text-[11px]">{stats.total} routes</Badge>
            <Badge variant="outline" className="font-mono text-[11px]">{stats.enabled} enabled</Badge>
            <Badge variant={violations.length > 0 ? "destructive" : "success"} className="font-mono text-[11px]">
              {violations.length} cap violations
            </Badge>
          </>
        }
      />

      <Alert variant={violations.length > 0 ? "destructive" : "default"}>
        <TriangleAlert aria-hidden />
        <AlertTitle>Output-cap rule in force</AlertTitle>
        <AlertDescription>
          <p>{OUTPUT_CAP_RULE.description}</p>
          <p className="font-mono text-[11px]">
            source: {OUTPUT_CAP_RULE.source} · baseline {OUTPUT_CAP_RULE.baselineChatCap} + thinking
            budget (none {OUTPUT_CAP_RULE.thinkingBudgets.none} / low {OUTPUT_CAP_RULE.thinkingBudgets.low} /
            high {OUTPUT_CAP_RULE.thinkingBudgets.high}) + headroom {OUTPUT_CAP_RULE.replyHeadroom}
          </p>
        </AlertDescription>
      </Alert>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Routes" value={stats.total} hint="Policy rows defined" icon={GitBranch} tone={stats.total === 0 ? "warning" : "neutral"} />
        <StatCard label="Enabled" value={stats.enabled} hint="Served to the client" icon={GitBranch} tone="positive" />
        <StatCard label="Tasks covered" value={`${stats.tasksCovered}/${TASK_CATALOGUE.length}`} hint={uncovered.length > 0 ? `Missing: ${uncovered.map((t) => t.key).join(", ")}` : "Every generation task has a policy"} icon={GitBranch} tone={uncovered.length > 0 ? "warning" : "positive"} />
        <StatCard label="Cap violations" value={violations.length} hint="Would starve background drafts" icon={TriangleAlert} tone={violations.length > 0 ? "critical" : "positive"} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <GitBranch className="size-4 text-primary" aria-hidden />
            Routing policies
          </CardTitle>
          <CardDescription>Lowest priority number wins per task. Provider must exist in the client catalogue.</CardDescription>
        </CardHeader>
        <CardContent>
          {routes.length === 0 ? (
            <EmptyState
              icon={GitBranch}
              title="No routing policies defined"
              reason="The routing table is empty, so the client falls back to its own on-device defaults (the user-picked provider and model in Settings). No policy is being served and none is pretended to be."
              nextStep={
                manageable
                  ? "Create a route for the reply task first — that is the foreground path users actually feel."
                  : "An operator or owner can define routes."
              }
              tone="waiting"
              action={manageable ? <RouteDialog canManage={manageable} /> : undefined}
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Task</TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead>Model</TableHead>
                  <TableHead>Priority</TableHead>
                  <TableHead>Thinking</TableHead>
                  <TableHead>Output cap</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {routes.map((route) => {
                  const required = effectiveOutputCap(route.thinking);
                  const violation = route.maxOutputTokens < required;
                  const provider = providerByKey(route.providerKey);
                  return (
                    <TableRow key={route.id}>
                      <TableCell>
                        <p className="font-medium">{TASK_CATALOGUE.find((t) => t.key === route.task)?.label ?? route.task}</p>
                        <p className="font-mono text-[10px] text-muted-foreground">{route.task}</p>
                      </TableCell>
                      <TableCell>
                        <p className="text-xs">{provider?.displayName ?? route.providerKey}</p>
                        <p className="font-mono text-[10px] text-muted-foreground">{provider?.dialects.join("+") ?? "unknown dialect"}</p>
                      </TableCell>
                      <TableCell className="font-mono text-[11px]">{route.modelId}</TableCell>
                      <TableCell className="font-mono text-xs">{route.priority}</TableCell>
                      <TableCell><StatusBadge value={route.thinking} /></TableCell>
                      <TableCell>
                        <span className={`font-mono text-xs ${violation ? "text-destructive" : ""}`}>
                          {route.maxOutputTokens}
                        </span>
                        {violation ? <p className="font-mono text-[10px] text-destructive">min {required}</p> : null}
                      </TableCell>
                      <TableCell>
                        <StatusBadge value={route.enabled ? "on" : "off"} />
                        {route.notes ? <p className="mt-1 max-w-[200px] text-[10px] leading-snug text-muted-foreground">{route.notes}</p> : null}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap items-center justify-end gap-2">
                          <RouteDialog canManage={manageable} route={{ id: route.id, task: route.task, providerKey: route.providerKey, modelId: route.modelId, priority: route.priority, thinking: route.thinking, maxOutputTokens: route.maxOutputTokens, enabled: route.enabled, notes: route.notes }} />
                          <AsyncAction
                            endpoint="/api/control"
                            payload={{ resource: "route", operation: "upsert", values: { id: route.id, task: route.task, providerKey: route.providerKey, modelId: route.modelId, priority: route.priority, thinking: route.thinking, maxOutputTokens: Math.max(route.maxOutputTokens, required), enabled: !route.enabled } }}
                            label={route.enabled ? "Disable" : "Enable"}
                            variant="ghost"
                            disabled={!manageable}
                          />
                          <AsyncAction
                            endpoint="/api/control"
                            payload={{ resource: "route", operation: "remove", values: { id: route.id } }}
                            label="Delete"
                            variant="destructive"
                            disabled={!manageable}
                            confirm={`Delete the ${route.task} route to ${route.providerKey}/${route.modelId}?`}
                          />
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
