import type { Metadata } from "next";
import { KeyRound, MonitorSmartphone, ShieldCheck, TicketCheck } from "lucide-react";
import { PageHeader } from "@/components/shared/page-header";
import { StatCard } from "@/components/shared/stat-card";
import { EmptyState } from "@/components/shared/empty-state";
import { StatusBadge, Dot } from "@/components/shared/status-badge";
import { AsyncAction } from "@/components/shared/async-action";
import { MfaEnrolment } from "@/components/forms/interactive";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requireCapability } from "@/lib/authz/guard";
import { envReport } from "@/config/env";
import { encryptionAvailable } from "@/lib/auth/crypto";
import { LOCKOUT, listActiveSessions } from "@/lib/auth/session";
import { formatDateTime, formatRelative } from "@/lib/utils";
import { mfaPosture } from "@/lib/queries/admins";
import { auditStats } from "@/lib/queries/ops";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Security" };

export default async function SecurityPage() {
  const { admin } = await requireCapability("security:view");
  const report = envReport();
  const [sessions, posture, audit] = await Promise.all([
    listActiveSessions(),
    mfaPosture(),
    auditStats(),
  ]);

  const encReady = encryptionAvailable();

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
