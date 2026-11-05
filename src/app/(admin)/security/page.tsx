import type { Metadata } from "next";
import { AlertTriangle, History as HistoryIcon, KeyRound, MonitorSmartphone, ShieldCheck, TicketCheck } from "lucide-react";
import { PageHeader } from "@/components/shared/page-header";
import { StatCard } from "@/components/shared/stat-card";
import { EmptyState } from "@/components/shared/empty-state";
import { StatusBadge, Dot } from "@/components/shared/status-badge";
import { AsyncAction } from "@/components/shared/async-action";
import { MfaEnrolment } from "@/components/forms/interactive";
import { LOGIN_THROTTLE } from "@/lib/auth/rate-limit";
import { AIOPS_RETENTION_DAYS } from "@/lib/maintenance/runner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requireCapability } from "@/lib/authz/guard";
import { can } from "@/lib/authz/permissions";
import { envReport } from "@/config/env";
import { encryptionAvailable } from "@/lib/auth/crypto";
import { keyStateReport } from "@/lib/auth/key-state";
import { gatherCutoverFacts } from "@/lib/supabase/cutover-live";
import { evaluateCutover } from "@/lib/supabase/cutover";
import { LOCKOUT, listActiveSessions } from "@/lib/auth/session";
import { formatDateTime, formatRelative } from "@/lib/utils";
import { lastMaintenanceRun, maintenanceRunCount, mfaPosture } from "@/lib/queries/admins";
import { auditStats } from "@/lib/queries/ops";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Security" };

export default async function SecurityPage() {
  const { admin } = await requireCapability("security:view");
  const report = envReport();
  const [sessions, posture, audit, maintenance, maintenanceRuns] = await Promise.all([
    listActiveSessions(),
    mfaPosture(),
    auditStats(),
    lastMaintenanceRun(),
    maintenanceRunCount(),
  ]);

  const encReady = encryptionAvailable();
  const canRunMaintenance = can(admin.role, "maintenance:run");
  const keyState = await keyStateReport();
  // Live, read-only. Runs on every render of this page; two GETs and four COUNTs.
  const { facts: cutoverFacts, notes: cutoverNotes } = await gatherCutoverFacts();
  const cutover = evaluateCutover(cutoverFacts);

  return (
    <>
      <PageHeader
        title="Security"
        description="Authentication posture for this control plane: your own factor, live sessions, and the policy that governs both."
        meta={
          <>
            <Badge variant="outline" className="font-mono text-[11px]">auth_provider: {report.authProvider}</Badge>
            <Badge variant={encReady ? "success" : "destructive"} className="font-mono text-[11px]">
              CONTROL_ENC_KEY: {encReady ? "present" : "missing"}
            </Badge>
            <Badge variant="outline" className="font-mono text-[11px]">session ttl: {report.controlPlane.sessionTtlHours}h</Badge>
          </>
        }
      />

      {keyState.rotated ? (
        <Alert variant="destructive">
          <AlertTriangle aria-hidden />
          <AlertTitle>The encryption key changed — stored credentials are orphaned</AlertTitle>
          <AlertDescription>
            <p>
              Credentials were minted under fingerprint{" "}
              <span className="font-mono">{keyState.previousFingerprint}</span>; the active key is{" "}
              <span className="font-mono">{keyState.fingerprint ?? "none"}</span> (
              {keyState.source}). Because digests are one-way, these rows can no longer be matched and
              will fail as &ldquo;invalid credential&rdquo; rather than reporting the real cause:
            </p>
            <p className="font-mono text-[11px]">
              device keys: {keyState.orphaned.deviceTokens} · invitations: {keyState.orphaned.invites} ·
              sessions: {keyState.orphaned.sessions} (benign — users simply sign in again)
            </p>
            <p>
              Restore the previous key, or reissue the affected credentials from Devices. This is the
              exact failure mode the keyfile resolver in{" "}
              <span className="font-mono">lib/auth/keys.ts</span> exists to prevent.
            </p>
          </AlertDescription>
        </Alert>
      ) : null}

      {keyState.credentialsUnreachable ? (
        <Alert variant="destructive">
          <AlertTriangle aria-hidden />
          <AlertTitle>No encryption key is available</AlertTitle>
          <AlertDescription>
            <p>
              Stored device keys and invitations cannot be matched, and TOTP enrolment is refused.
              {keyState.detail}
            </p>
          </AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Encryption key</CardTitle>
          <CardDescription>
            Where the key came from and what depends on it. The fingerprint identifies the key without
            revealing it.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-xs">
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted-foreground">Status</span>
            <Badge variant={keyState.strength === "keyed" ? "success" : "destructive"} className="font-mono text-[10px]">
              {keyState.strength}
            </Badge>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted-foreground">Source</span>
            <span className="font-mono text-[11px]">{keyState.source}</span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted-foreground">Fingerprint</span>
            <span className="font-mono text-[11px]">{keyState.fingerprint ?? "—"}</span>
          </div>
          <p className="border-t pt-2 leading-relaxed text-muted-foreground">{keyState.detail}</p>
          <p className="leading-relaxed text-muted-foreground">
            Resolution order: <span className="font-mono">CONTROL_ENC_KEY</span> from the environment,
            then <span className="font-mono">.keys/control-enc.key</span> (mode 0600, gitignored,
            created on first use). The keyfile exists because this platform regenerates{" "}
            <span className="font-mono">.env</span> on redeploy, which previously rotated the key
            silently and orphaned every stored credential.
          </p>
        </CardContent>
      </Card>

      {!encReady ? (
        <Alert variant="destructive">
          <AlertTitle>CONTROL_ENC_KEY is not configured</AlertTitle>
          <AlertDescription>
            <p>
              TOTP secrets are encrypted with AES-256-GCM under this key. Without it, enrolment is
              refused outright rather than storing a factor in plaintext. Set a value of at least 32
              characters in the server environment and restart.
            </p>
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="MFA coverage" value={`${posture.coveragePercent}%`} hint={`${posture.enrolled}/${posture.totalActive} active admins enrolled`} icon={ShieldCheck} tone={posture.unenrolledPrivileged > 0 ? "warning" : "positive"} />
        <StatCard label="Live sessions" value={sessions.length} hint="Opaque cookies; only SHA-256 digests stored" icon={MonitorSmartphone} tone="neutral" />
        <StatCard label="Denied actions" value={audit.denied} hint="Authorization refusals, all audited" icon={TicketCheck} tone={audit.denied > 0 ? "warning" : "positive"} />
        <StatCard label="Privacy violations" value={audit.privacyViolations} hint="Attempts to read denied content tables" icon={KeyRound} tone={audit.privacyViolations > 0 ? "critical" : "positive"} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="size-4 text-primary" aria-hidden />
            Supabase Auth cutover preflight
          </CardTitle>
          <CardDescription>
            Live, read-only assessment of whether <span className="font-mono">AUTH_PROVIDER</span> can
            move from <span className="font-mono">local</span> to{" "}
            <span className="font-mono">supabase</span>. Nothing here changes a project setting.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={cutover.ready ? "success" : cutover.blocking.length > 0 ? "destructive" : "warning"}>
              {cutover.ready ? "ready" : `${cutover.blocking.length} blocking`}
            </Badge>
            <span className="text-xs text-muted-foreground">{cutover.summary}</span>
          </div>
          <ul className="space-y-2">
            {cutover.checks.map((check) => (
              <li key={check.id} className="rounded-md border p-3">
                <div className="flex items-start gap-2">
                  <Dot
                    tone={
                      check.status === "pass" ? "success"
                        : check.status === "fail" ? "destructive"
                        : check.status === "warn" ? "warning" : "muted"
                    }
                    pulse={check.status === "fail"}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-semibold">{check.title}</p>
                    <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{check.detail}</p>
                    {check.action ? (
                      <p className="mt-1.5 text-[11px] leading-relaxed">
                        <span className="font-medium">Action:</span> {check.action}
                      </p>
                    ) : null}
                  </div>
                  <Badge variant="outline" className="shrink-0 font-mono text-[10px]">{check.status}</Badge>
                </div>
              </li>
            ))}
          </ul>
          {cutoverNotes.length > 0 ? (
            <ul className="space-y-1 border-t pt-3">
              {cutoverNotes.map((note) => (
                <li key={note} className="text-[11px] text-muted-foreground">· {note}</li>
              ))}
            </ul>
          ) : null}
          <p className="border-t pt-3 text-[11px] leading-relaxed text-muted-foreground">
            Reproduce from a shell with{" "}
            <span className="font-mono">npx tsx scripts/supabase-cutover-preflight.ts</span>, which
            exits non-zero when the cutover is not ready.
          </p>
        </CardContent>
      </Card>

      <Card id="mfa">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="size-4 text-primary" aria-hidden />
            Your multi-factor authentication
          </CardTitle>
          <CardDescription>
            TOTP per RFC 6238 — SHA-1, 30-second step, 6 digits, ±1 step skew window, single-use
            codes. Compatible with Google Authenticator, 1Password, Authy and Aegis.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <MfaEnrolment enrolled={admin.mfaEnrolledAt !== null} mfaRequired={admin.mfaRequired} />
          <div className="mt-4 grid gap-3 border-t pt-4 text-xs text-muted-foreground sm:grid-cols-3">
            <div>
              <p className="font-medium text-foreground">Password storage</p>
              <p className="mt-1 leading-relaxed">scrypt (N=16384, r=8, p=1), 32-byte salt, 64-byte derived key. Timing-safe comparison.</p>
            </div>
            <div>
              <p className="font-medium text-foreground">Lockout</p>
              <p className="mt-1 leading-relaxed">{LOCKOUT.maxFailedAttempts} failed attempts locks the account for {LOCKOUT.lockMinutes} minutes. Every attempt is audited.</p>
            </div>
            <div>
              <p className="font-medium text-foreground">Sessions</p>
              <p className="mt-1 leading-relaxed">256-bit CSPRNG cookie, stored as a digest only, sliding {report.controlPlane.sessionTtlHours}h expiry, HttpOnly + SameSite=Lax.</p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <HistoryIcon className="size-4 text-primary" aria-hidden />
            Maintenance
          </CardTitle>
          <CardDescription>
            Prunes expired sessions, stale login-throttle rows, expired invitations and idle
            assistant sessions. Sourced from recorded executions, not from configuration — an
            interval being set is not evidence that it ran.
          </CardDescription>
          {canRunMaintenance ? (
            <CardAction>
              <AsyncAction
                endpoint="/api/maintenance/run"
                label="Run maintenance now"
                icon={<HistoryIcon className="size-4" aria-hidden />}
                confirm="Run one maintenance pass? It deletes expired sessions, throttle rows past retention, expired un-redeemed invitations and assistant sessions idle over 30 days. The run is recorded in the audit log."
              />
            </CardAction>
          ) : null}
        </CardHeader>
        <CardContent className="space-y-3">
          {maintenance === null ? (
            <div className="rounded-lg border border-dashed px-4 py-6 text-center">
              <p className="text-sm font-semibold">Maintenance has never run</p>
              <p className="mx-auto mt-1.5 max-w-xl text-xs leading-relaxed text-muted-foreground">
                {maintenanceRuns === 0
                  ? "No `maintenance.run` entry exists in the audit log. Nothing is claimed to be scheduled until an execution is recorded."
                  : "No readable run record."}{" "}
                The in-process interval is opt-in via{" "}
                <span className="font-mono">MAINTENANCE_INTERVAL_MINUTES</span> and is not a durable
                scheduler: it stops with the process and never fires in a serverless deployment. For a
                guarantee, drive <span className="font-mono">POST /api/maintenance/run</span> from an
                external cron.
              </p>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={maintenance.outcome === "success" ? "success" : "warning"} className="font-mono text-[10px]">
                  {maintenance.outcome}
                </Badge>
                <Badge variant="outline" className="font-mono text-[10px]">trigger: {maintenance.trigger}</Badge>
                <span className="font-mono text-[11px] text-muted-foreground">{formatDateTime(maintenance.ts)}</span>
                <span className="text-[11px] text-muted-foreground">({formatRelative(maintenance.ts)})</span>
                <span className="ml-auto font-mono text-[11px] text-muted-foreground">
                  {maintenanceRuns} run{maintenanceRuns === 1 ? "" : "s"} recorded
                </span>
              </div>
              <div className="grid gap-2 sm:grid-cols-4">
                {Object.entries(maintenance.pruned).map(([key, value]) => (
                  <div key={key} className="rounded-md border p-2.5">
                    <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{key}</p>
                    <p className="mt-0.5 font-mono text-lg font-semibold tabular-nums">{value}</p>
                  </div>
                ))}
              </div>
              {maintenance.errors.length > 0 ? (
                <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-[11px] text-destructive">
                  {maintenance.errors.length} step(s) failed: {maintenance.errors.join("; ")}
                </p>
              ) : null}
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                Retention: login-throttle rows {LOGIN_THROTTLE.retentionDays} days, assistant sessions{" "}
                {AIOPS_RETENTION_DAYS} days. Sessions are pruned once past their expiry; the audit log
                is never pruned, because it is append-only by database trigger.
              </p>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <MonitorSmartphone className="size-4 text-primary" aria-hidden />
            Active sessions
          </CardTitle>
          <CardDescription>
            Every session across every administrator. Revoking is immediate — the digest stops
            matching on the next request.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {sessions.length === 0 ? (
            <EmptyState
              icon={MonitorSmartphone}
              title="No active sessions"
              reason="Sessions exist only after a successful sign-in. This list is read live from the session table."
              tone="neutral"
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Administrator</TableHead>
                  <TableHead>MFA</TableHead>
                  <TableHead>IP</TableHead>
                  <TableHead>User agent</TableHead>
                  <TableHead>Last seen</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sessions.map((session) => {
                  const isSelf = session.adminId === admin.id;
                  return (
                    <TableRow key={session.id}>
                      <TableCell>
                        <p className="flex items-center gap-2 font-mono text-xs">
                          <Dot tone={isSelf ? "success" : "muted"} />
                          {session.email}
                          {isSelf ? <span className="text-muted-foreground">(this device)</span> : null}
                        </p>
                      </TableCell>
                      <TableCell><StatusBadge value={session.mfaVerified ? "active" : "invited"} /></TableCell>
                      <TableCell className="font-mono text-[11px] text-muted-foreground">{session.ip ?? "unknown"}</TableCell>
                      <TableCell className="max-w-[240px] truncate text-[11px] text-muted-foreground" title={session.userAgent ?? undefined}>
                        {session.userAgent ?? "unknown"}
                      </TableCell>
                      <TableCell className="text-[11px] text-muted-foreground">{formatRelative(session.lastSeenAt)}</TableCell>
                      <TableCell className="text-[11px] text-muted-foreground">{formatDateTime(session.expiresAt)}</TableCell>
                      <TableCell className="text-right">
                        <AsyncAction
                          endpoint="/api/control"
                          payload={{ resource: "session", operation: "revoke", values: { id: session.id, allForAdmin: false } }}
                          label="Revoke"
                          variant={isSelf ? "outline" : "destructive"}
                          disabled={admin.role !== "owner" && admin.role !== "admin"}
                          disabledReason={admin.role !== "owner" && admin.role !== "admin" ? "Requires security:manage (owner)." : undefined}
                          confirm={isSelf ? "Revoke your own session? You will be signed out immediately." : `Revoke this session for ${session.email}?`}
                        />
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
