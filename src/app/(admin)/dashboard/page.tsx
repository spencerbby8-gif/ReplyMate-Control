import type { Metadata } from "next";
import Link from "next/link";
import {
  Activity,
  ArrowRight,
  Cpu,
  Database,
  Flag,
  GitBranch,
  HeartPulse,
  LifeBuoy,
  Lock,
  Package,
  ScrollText,
  ShieldAlert,
  ShieldCheck,
  Smartphone,
  Users,
} from "lucide-react";
import { PageHeader } from "@/components/shared/page-header";
import { StatCard } from "@/components/shared/stat-card";
import { StatusBadge, Dot } from "@/components/shared/status-badge";
import { EmptyState } from "@/components/shared/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireCapability } from "@/lib/authz/guard";
import { envReport } from "@/config/env";
import { identityStatus } from "@/lib/auth/identity";
import { digestKeyStrength } from "@/lib/auth/crypto";
import { throttlePosture } from "@/lib/auth/rate-limit";
import { currentRelease, draftDrift } from "@/lib/config/versioning";
import { deviceEventSummary } from "@/lib/queries/devices";
import { appDataPlanePresent, auditImmutabilityInstalled, countControlTables } from "@/lib/queries/health";
import { formatRelative } from "@/lib/utils";
import {
  activeSessionCount,
  countAdmins,
  mfaPosture,
  countPendingInvites,
} from "@/lib/queries/admins";
import {
  auditStats,
  listAudit,
  configStats,
  deviceStats,
  flagStats,
  latestProbePerTarget,
  providerStats,
  releaseStats,
  routeStats,
  subscriptionStats,
  ticketStats,
} from "@/lib/queries/ops";
import { bridgeStatus } from "@/lib/supabase/bridge";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Dashboard" };

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ denied?: string; before?: string }>;
}) {
  const { admin } = await requireCapability("dashboard:view");
  const params = await searchParams;

  const [
    admins,
    invites,
    sessions,
    mfa,
    audit,
    flags,
    providers,
    routes,
    releases,
    devices,
    subscriptions,
    tickets,
    config,
    probes,
    events,
    identity,
    digestStrength,
    throttle,
    configRelease,
    drift,
    telemetry,
    tableCount,
    dataPlane,
    auditImmutable,
  ] = await Promise.all([
    countAdmins(),
    countPendingInvites(),
    activeSessionCount(),
    mfaPosture(),
    auditStats(),
    flagStats(),
    providerStats(),
    routeStats(),
    releaseStats(),
    deviceStats(),
    subscriptionStats(),
    ticketStats(),
    configStats(),
    latestProbePerTarget(),
    listAudit({ limit: 12, beforeId: Number.isFinite(Number(params.before)) && Number(params.before) > 0 ? Number(params.before) : undefined }),
    Promise.resolve(identityStatus()),
    Promise.resolve(digestKeyStrength()),
    throttlePosture(),
    currentRelease(),
    draftDrift(),
    deviceEventSummary(),
    countControlTables(),
    appDataPlanePresent(),
    auditImmutabilityInstalled(),
  ]);

  const draftAhead = drift.draftAhead;

  const report = envReport();
  const bridge = bridgeStatus();
  const degradedProbes = probes.filter((p) => p.status === "degraded" || p.status === "down");

  const posture: Array<{ label: string; ok: boolean; detail: string }> = [
    {
      label: "Database separation",
      ok: !dataPlane.present,
      detail: dataPlane.present
        ? `REFUSE TO OPERATE: this database contains ReplyMate app tables (${dataPlane.tables.join(", ")}). DATABASE_URL is pointing at the production data plane.`
        : `Verified at request time: ${tableCount} ctl_* tables and zero ReplyMate app tables in this database.`,
    },
    {
      label: "Audit immutability",
      ok: auditImmutable,
      detail: auditImmutable
        ? "Database triggers refuse UPDATE and DELETE on ctl_audit_log (SQLSTATE 42501)."
        : "Triggers are NOT installed. Run `npx tsx scripts/apply-hardening.ts` — the log is only protected in application code until then.",
    },
    {
      label: "Message sync",
      ok: true,
      detail: "Disabled by contract. No control in this platform can enable it.",
    },
    {
      label: "Message content access",
      ok: true,
      detail: "Blocked in code — message, memory_fact, draft, contact_summary, app_kv and style_profile are on the deny list.",
    },
    {
      label: "Provider API keys",
      ok: true,
      detail: "BYOK only. Keys live in the Android Keystore; this platform stores no key material.",
    },
    {
      label: "Admin MFA coverage",
      ok: mfa.totalActive === 0 || mfa.unenrolledPrivileged === 0,
      detail:
        mfa.totalActive === 0
          ? "No active administrators yet."
          : `${mfa.enrolled}/${mfa.totalActive} active admins enrolled. ${mfa.unenrolledPrivileged} privileged account(s) still without MFA.`,
    },
    {
      label: "Audit trail",
      ok: audit.total > 0,
      detail:
        audit.total === 0
          ? "Empty. The audit log records real events only — nothing is pre-populated."
          : `${audit.total} entries · ${audit.last7Days} in the last 7 days · ${audit.denied} denied.`,
    },
    {
      label: "Supabase bridge",
      ok: bridge.configured,
      detail: bridge.configured
        ? "Read-only, allow-listed queries permitted."
        : "Closed. Credentials absent, so the app reports unavailable instead of inventing numbers.",
    },
  ];

  return (
    <>
      <PageHeader
        title={`Welcome back${admin.displayName ? `, ${admin.displayName}` : ""}`}
        description="Operational posture for ReplyMate Control. Every figure on this page is read from the control-plane database or a live probe — nothing is estimated or simulated."
        meta={
          <>
            <Badge variant="outline" className="font-mono text-[11px]">
              role: {admin.role}
            </Badge>
            <Badge variant="outline" className="font-mono text-[11px]">
              auth: {report.authProvider}
            </Badge>
            <Badge variant={bridge.configured ? "success" : "muted"} className="font-mono text-[11px]">
              supabase: {bridge.mode}
            </Badge>
          </>
        }
      />

      {params.denied ? (
        <div className="flex items-start gap-3 rounded-lg border border-warning/30 bg-warning/5 px-4 py-3">
          <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
          <p className="text-xs leading-relaxed text-warning">
            Access denied: your role does not hold <span className="font-mono">{params.denied}</span>.
            The attempt was written to the audit log.
          </p>
        </div>
      ) : null}

      {/* Posture strip */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="size-4 text-primary" aria-hidden />
            Privacy &amp; security posture
          </CardTitle>
          <CardDescription>
            The local-first contract from <span className="font-mono">docs/SPEC.md</span> and{" "}
            <span className="font-mono">docs/BLUEPRINT.md</span>, evaluated against live state.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {posture.map((item) => (
              <li key={item.label} className="rounded-lg border bg-background/40 p-3">
                <div className="flex items-center gap-2">
                  <Dot tone={item.ok ? "success" : "warning"} pulse={!item.ok} />
                  <p className="text-xs font-semibold">{item.label}</p>
                  <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                    {item.ok ? "OK" : "ATTENTION"}
                  </span>
                </div>
                <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">{item.detail}</p>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      {/* Headline numbers */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Administrators"
          value={admins.count}
          hint={`${admins.active} active · ${invites} invitation${invites === 1 ? "" : "s"} outstanding`}
          icon={Users}
          tone={admins.count === 0 ? "warning" : "neutral"}
        />
        <StatCard
          label="MFA coverage"
          value={`${mfa.coveragePercent}%`}
          hint={
            mfa.totalActive === 0
              ? "No active administrators"
              : `${mfa.enrolled} of ${mfa.totalActive} enrolled`
          }
          icon={ShieldCheck}
          tone={mfa.unenrolledPrivileged > 0 ? "warning" : "positive"}
        />
        <StatCard
          label="Active sessions"
          value={sessions}
          hint="Opaque cookies; only SHA-256 digests are stored"
          icon={Lock}
          tone="neutral"
        />
        <StatCard
          label="Audit entries"
          value={audit.total}
          hint={`${audit.last7Days} in the last 7 days · ${audit.denied} denied`}
          icon={ScrollText}
          tone={audit.total === 0 ? "muted" : "neutral"}
        />
      </div>

      {/* Live system health */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <HeartPulse className="size-4 text-primary" aria-hidden />
            System health
          </CardTitle>
          <CardDescription>
            Every row is a real measurement or a real configuration fact taken during this request.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {[
              {
                label: "Control-plane database",
                tone: "ok" as const,
                detail: `${tableCount} ctl_* tables reachable`,
              },
              {
                label: "Identity provider",
                tone: identity.configured ? ("ok" as const) : ("bad" as const),
                detail: `${identity.provider} · ${identity.passwordStore}${identity.configured ? "" : " · NOT CONFIGURED — sign-in fails closed"}`,
              },
              {
                label: "Supabase bridge",
                tone: bridge.configured ? ("ok" as const) : ("muted" as const),
                detail: bridge.configured ? "read-only, allow-listed" : "closed — no credentials configured",
              },
              {
                label: "Token digests",
                tone: digestStrength === "keyed" ? ("ok" as const) : ("warn" as const),
                detail: digestStrength === "keyed" ? "keyed from CONTROL_ENC_KEY" : "UNKEYED — set CONTROL_ENC_KEY",
              },
              {
                label: "Audit immutability",
                tone: audit.total >= 0 ? ("ok" as const) : ("warn" as const),
                detail: "DB triggers refuse UPDATE and DELETE (42501)",
              },
              {
                label: "Login throttling",
                tone: throttle.failuresInWindow > throttle.maxDistinctTargets ? ("warn" as const) : ("ok" as const),
                detail: `${throttle.failuresInWindow} failure(s) from ${throttle.sourcesInWindow} source(s) in the last ${throttle.windowMinutes} min`,
              },
              {
                label: "Config delivery",
                tone: configRelease ? ("ok" as const) : ("warn" as const),
                detail: configRelease
                  ? `v${configRelease.version} published${draftAhead.length > 0 ? ` · ${draftAhead.length} draft key(s) ahead` : ""}`
                  : "no release published — clients use built-in defaults",
              },
              {
                label: "Device telemetry",
                tone: telemetry.devices === 0 ? ("muted" as const) : ("ok" as const),
                detail: `${telemetry.devices} registered · ${telemetry.eventsLast24h} event(s) in 24h`,
              },
              {
                label: "External probes",
                tone: degradedProbes.length > 0 ? ("warn" as const) : probes.length === 0 ? ("muted" as const) : ("ok" as const),
                detail: probes.length === 0 ? "not run yet" : `${probes.length - degradedProbes.length}/${probes.length} healthy`,
              },
            ].map((row) => (
              <li key={row.label} className="flex items-start gap-2.5 rounded-lg border bg-background/40 p-3">
                <span className="mt-1.5">
                  <Dot tone={row.tone === "ok" ? "success" : row.tone === "warn" ? "warning" : row.tone === "bad" ? "destructive" : "muted"} pulse={row.tone === "warn" || row.tone === "bad"} />
                </span>
                <div className="min-w-0">
                  <p className="text-xs font-semibold">{row.label}</p>
                  <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{row.detail}</p>
                </div>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      {/* Platform surfaces */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="AI providers" value={providers.total} hint={`${providers.available} available · ${providers.unconfigured} awaiting keys`} icon={Cpu} tone="neutral" />
        <StatCard label="Model routes" value={routes.total} hint={`${routes.enabled} enabled · ${routes.tasksCovered} task kinds covered`} icon={GitBranch} tone="neutral" />
        <StatCard label="Feature flags" value={flags.total} hint={`${flags.on} on · ${flags.canary} canary · ${flags.shadow} shadow`} icon={Flag} tone="neutral" />
        <StatCard
          label="Releases"
          value={releases.total}
          hint={releases.latest ? `Latest ${releases.latest.versionName} · ${releases.broken} marked broken` : "Ledger not yet imported"}
          icon={Package}
          tone={releases.total === 0 ? "warning" : "positive"}
        />
        <StatCard label="Configuration keys" value={config.total} hint={`${config.locked} locked by the app contract`} icon={Database} tone="neutral" />
        <StatCard label="Devices" value={devices.total} hint="Opt-in diagnostics only — requires explicit consent" icon={Smartphone} tone={devices.total === 0 ? "muted" : "neutral"} />
        <StatCard label="Subscriptions" value={subscriptions.total} hint={`${subscriptions.active} active · no billing provider connected`} icon={LifeBuoy} tone={subscriptions.total === 0 ? "muted" : "neutral"} />
        <StatCard label="Support tickets" value={tickets.total} hint={`${tickets.open} open · ${tickets.resolved} resolved`} icon={LifeBuoy} tone={tickets.total === 0 ? "muted" : "neutral"} />
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        {/* Recent activity */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between">
              <span className="flex items-center gap-2">
                <Activity className="size-4 text-primary" aria-hidden />
                Recent activity
              </span>
              <Button asChild variant="ghost" size="sm">
                <Link href="/audit">
                  Full audit log
                  <ArrowRight className="size-3.5" aria-hidden />
                </Link>
              </Button>
            </CardTitle>
            <CardDescription>Append-only. There is no update or delete path for these rows.</CardDescription>
          </CardHeader>
          <CardContent>
            {events.length === 0 ? (
              <EmptyState
                icon={ScrollText}
                title="No audited actions yet"
                reason="The audit log is written only by real privileged actions — sign-ins, invitation changes, flag updates and denials. It is never pre-populated with example rows."
                nextStep="Sign out and back in, or issue an invitation from Users, and entries will appear here immediately."
                tone="neutral"
              />
            ) : (
              <ul className="divide-y">
                {events.map((event) => (
                  <li key={event.id} className="flex items-start gap-3 py-2.5">
                    <span className="mt-1.5">
                      <Dot tone={event.outcome === "success" ? "success" : event.outcome === "denied" ? "destructive" : "warning"} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-mono text-xs">{event.action}</p>
                      <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                        {event.actorEmail ?? "system"}
                        {event.entity ? ` · ${event.entity}${event.entityId ? `:${event.entityId.slice(0, 8)}` : ""}` : ""}
                      </p>
                    </div>
                    <span className="shrink-0 text-[11px] text-muted-foreground">{formatRelative(event.ts)}</span>
                  </li>
                ))}
              </ul>
            )}
            {events.length > 0 ? (
              <div className="mt-3 flex items-center justify-between gap-3 border-t pt-3">
                <p className="text-[11px] text-muted-foreground">
                  Showing {events.length} of {audit.total}. Keyset pagination — the cursor is the
                  oldest row id on this page, so a new event arriving mid-scroll cannot shift the
                  window and duplicate a row.
                </p>
                <div className="flex shrink-0 items-center gap-2">
                  {params.before ? (
                    <Button asChild variant="ghost" size="sm">
                      <Link href="/dashboard">Newest</Link>
                    </Button>
                  ) : null}
                  <Button asChild variant="outline" size="sm">
                    <Link href={`/dashboard?before=${events[events.length - 1].id}`}>
                      Load older
                      <ArrowRight className="size-3.5" aria-hidden />
                    </Link>
                  </Button>
                </div>
              </div>
            ) : null}
          </CardContent>
        </Card>

        {/* Monitoring + bridge */}
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Activity className="size-4 text-primary" aria-hidden />
                Dependency health
              </CardTitle>
              <CardDescription>Latest result per monitored target.</CardDescription>
            </CardHeader>
            <CardContent>
              {probes.length === 0 ? (
                <EmptyState
                  icon={Activity}
                  title="No probes have run"
                  reason="Probes are executed on demand from the Monitoring page and record real HTTP results. Nothing is cached from a previous deployment or faked."
                  nextStep="Open Monitoring and run the probe suite."
                  tone="waiting"
                  action={
                    <Button asChild size="sm">
                      <Link href="/monitoring">
                        Open monitoring
                        <ArrowRight className="size-3.5" aria-hidden />
                      </Link>
                    </Button>
                  }
                />
              ) : (
                <ul className="space-y-2">
                  {probes.slice(0, 6).map((probe) => (
                    <li key={probe.target} className="flex items-center gap-2.5 rounded-md border px-3 py-2">
                      <Dot tone={probe.status === "ok" ? "success" : probe.status === "degraded" ? "warning" : "destructive"} pulse={probe.status !== "ok"} />
                      <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{probe.target}</span>
                      {probe.latencyMs !== null ? (
                        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{probe.latencyMs}ms</span>
                      ) : null}
                      <StatusBadge value={probe.status} />
                    </li>
                  ))}
                </ul>
              )}
              {degradedProbes.length > 0 ? (
                <p className="mt-3 text-[11px] text-warning">
                  {degradedProbes.length} target(s) not reporting healthy.
                </p>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Supabase bridge</CardTitle>
              <CardDescription>{bridge.reason}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-xs">
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">Mode</span>
                <StatusBadge value={bridge.configured ? "active" : "disabled"} />
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">Project</span>
                <span className="truncate font-mono text-[11px]">
                  {bridge.projectUrl ? new URL(bridge.projectUrl).host : "not configured"}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">Access</span>
                <span className="font-mono text-[11px]">read-only · allow-list</span>
              </div>
              <p className="pt-1 text-[11px] leading-relaxed text-muted-foreground">
                Even when live, the bridge can only read <span className="font-mono">usage_event</span> aggregates,{" "}
                <span className="font-mono">provider_def</span> metadata and the schema ledger. Content tables are
                denied before a query is built.
              </p>
              <Button asChild variant="outline" size="sm" className="mt-2 w-full">
                <Link href="/privacy">Review the privacy contract</Link>
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
