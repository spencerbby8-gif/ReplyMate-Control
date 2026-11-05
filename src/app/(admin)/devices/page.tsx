import type { Metadata } from "next";
import Link from "next/link";
import { Activity, Gauge, KeyRound, Radio, ShieldOff, Smartphone, Stethoscope } from "lucide-react";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { StatCard } from "@/components/shared/stat-card";
import { StatusBadge, Dot } from "@/components/shared/status-badge";
import { AsyncAction } from "@/components/shared/async-action";
import { DeviceRegisterDialog } from "@/components/forms/devices";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requireCapability } from "@/lib/authz/guard";
import { can } from "@/lib/authz/permissions";
import { EVENT_KIND_DOCS, EVENT_KINDS, MAX_BATCH_SIZE } from "@/lib/ingest/allowlist";
import { MAX_INGEST_PER_MINUTE } from "@/lib/ingest/auth";
import { formatDateTime, formatNumber, formatRelative } from "@/lib/utils";
import { keyStateReport } from "@/lib/auth/key-state";
import {
  deviceEventSummary,
  listDeviceEvents,
  listDevicesWithActivity,
  operationalDiagnostics,
} from "@/lib/queries/devices";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Devices" };

export default async function DevicesPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string; device?: string }>;
}) {
  const { admin } = await requireCapability("devices:view");
  const manageable = can(admin.role, "devices:manage");
  const params = await searchParams;

  const [devices, summary, diagnostics, events, keyState] = await Promise.all([
    listDevicesWithActivity(),
    deviceEventSummary(),
    operationalDiagnostics(),
    listDeviceEvents({ deviceId: params.device, kind: params.kind, limit: 60 }),
    keyStateReport(),
  ]);

  const activeDevices = devices.filter((row) => row.device.status === "active");

  return (
    <>
      <PageHeader
        title="Devices"
        description="Opt-in device registration, allow-listed operational telemetry and the diagnostics derived from it. Nothing here is collected without a recorded consent timestamp, and no shipped client build sends it yet."
        actions={manageable ? <DeviceRegisterDialog /> : undefined}
        meta={
          <>
            <Badge variant="outline" className="font-mono text-[11px]">{summary.devices} registered</Badge>
            <Badge variant="success" className="font-mono text-[11px]">{summary.consentedDevices} consented</Badge>
            <Badge variant="outline" className="font-mono text-[11px]">{formatNumber(summary.totalEvents)} events</Badge>
            <Badge variant="muted" className="font-mono text-[11px]">{EVENT_KINDS.length} permitted kinds</Badge>
          </>
        }
      />

      <Alert>
        <ShieldOff aria-hidden />
        <AlertTitle>What can never be sent through this channel</AlertTitle>
        <AlertDescription>
          <p>
            Ingestion is validated by <span className="font-mono">src/lib/ingest/allowlist.ts</span>{" "}
            before anything is written. Unknown event kinds are refused, unexpected fields are
            refused, and a recursive sweep rejects any key shaped like content or identity —{" "}
            <span className="font-mono">body</span>, <span className="font-mono">message</span>,{" "}
            <span className="font-mono">contact</span>, <span className="font-mono">sender</span>,{" "}
            <span className="font-mono">remote_key</span>, <span className="font-mono">prompt</span>,{" "}
            <span className="font-mono">transcript</span>, <span className="font-mono">apiKey</span>{" "}
            and 25 more. String values are screened for email, phone, deep-link, URL-with-query and
            credential shapes. There is no free-form payload column, so content has nowhere to go
            even if a client tried.
          </p>
          <p>
            A heartbeat that reports <span className="font-mono">syncEnabled=true</span> is refused
            with its own error code: a device with sync on is a product-level emergency, not telemetry.
          </p>
        </AlertDescription>
      </Alert>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Registered devices" value={summary.devices} hint={`${activeDevices.length} active · ${summary.devices - summary.consentedDevices} revoked`} icon={Smartphone} tone={summary.devices === 0 ? "muted" : "neutral"} />
        <StatCard label="Events received" value={formatNumber(summary.totalEvents)} hint={`${formatNumber(summary.eventsLast24h)} in the last 24 hours`} icon={Radio} tone={summary.totalEvents === 0 ? "muted" : "neutral"} />
        <StatCard
          label="Draft latency p95"
          value={diagnostics.latency.p95 !== null ? `${diagnostics.latency.p95}ms` : "—"}
          hint={diagnostics.latency.samples > 0 ? `from ${diagnostics.latency.samples} real samples` : "No draft_latency events yet"}
          icon={Gauge}
          tone={diagnostics.latency.samples === 0 ? "muted" : diagnostics.latency.p95 !== null && diagnostics.latency.p95 > 5000 ? "warning" : "positive"}
        />
        <StatCard label="Provider errors" value={diagnostics.providerErrors.total} hint={`${diagnostics.crashes} crash report(s)`} icon={Activity} tone={diagnostics.providerErrors.total > 0 ? "warning" : "muted"} />
      </div>

      {keyState.rotated ? (
        <Alert variant="destructive">
          <KeyRound aria-hidden />
          <AlertTitle>{keyState.orphaned.deviceTokens} device key(s) can no longer authenticate</AlertTitle>
          <AlertDescription>
            <p>
              The encryption key changed (previously{" "}
              <span className="font-mono">{keyState.previousFingerprint}</span>, now{" "}
              <span className="font-mono">{keyState.fingerprint ?? "none"}</span>). Ingest keys are
              stored as one-way digests, so those devices will receive <span className="font-mono">401
              invalid_credential</span> — which looks like a wrong key rather than a rotated one. Use
              <span className="font-medium"> Reissue key</span> on each affected device and redeploy
              the new value to it.
            </p>
          </AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Smartphone className="size-4 text-primary" aria-hidden />
            Registrations
          </CardTitle>
          <CardDescription>
            Each registration carries a consent timestamp and a scoped, expiring, digest-only ingest
            key. Revoking stops ingestion immediately — the key stops authenticating and the device
            row is marked revoked.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {devices.length === 0 ? (
            <EmptyState
              icon={Smartphone}
              title="No devices are registered"
              reason="Two things are both true and neither is hidden. (1) No shipped ReplyMate build sends telemetry, so nothing arrives by itself. (2) Registration here is a deliberate operator act, and none has been performed in this environment. The consent_recorded_at column is NOT NULL, so a row cannot exist without a recorded consent."
              nextStep={
                manageable
                  ? "Register a device to obtain an ingest key, then POST allow-listed events to /api/ingest/events. Until a client build ships the opt-in consent screen and transport, real devices will not appear on their own — and this page will keep saying so."
                  : "An operator, admin or owner can register a device."
              }
              tone="waiting"
              action={manageable ? <DeviceRegisterDialog /> : undefined}
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Device</TableHead>
                  <TableHead>App / API</TableHead>
                  <TableHead>Consent</TableHead>
                  <TableHead>Events</TableHead>
                  <TableHead>Last seen</TableHead>
                  <TableHead>Keys</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {devices.map(({ device, eventCount, lastEventAt, tokens }) => (
                  <TableRow key={device.id}>
                    <TableCell>
                      <p className="flex items-center gap-2 text-xs font-medium">
                        <Dot tone={device.status === "active" ? "success" : "destructive"} pulse={device.status === "active"} />
                        {device.label ?? "unlabelled"}
                      </p>
                      <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">{device.id.slice(0, 8)}…</p>
                      {device.deviceModel ? <p className="font-mono text-[10px] text-muted-foreground">{device.deviceModel}</p> : null}
                    </TableCell>
                    <TableCell className="font-mono text-[11px]">
                      {device.appVersion ?? "—"} / {device.androidApiLevel ?? "—"}
                    </TableCell>
                    <TableCell>
                      <StatusBadge value={device.status} />
                      <p className="mt-1 text-[10px] text-muted-foreground" title={formatDateTime(device.consentRecordedAt)}>
                        consent {formatRelative(device.consentRecordedAt)}
                      </p>
                      {device.consentRevokedAt ? (
                        <p className="text-[10px] text-destructive">revoked {formatRelative(device.consentRevokedAt)}</p>
                      ) : null}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      <a href={`/devices?device=${device.id}`} className="underline-offset-4 hover:underline">
                        {formatNumber(eventCount)}
                      </a>
                      {lastEventAt ? <p className="text-[10px] text-muted-foreground">{formatRelative(lastEventAt)}</p> : null}
                    </TableCell>
                    <TableCell className="text-[11px] text-muted-foreground">
                      {device.lastSeenAt ? formatRelative(device.lastSeenAt) : "never"}
                    </TableCell>
                    <TableCell>
                      <p className="flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
                        <KeyRound className="size-3" aria-hidden />
                        {tokens.filter((token) => !token.revokedAt).length} live / {tokens.length} total
                      </p>
                      {tokens[0] ? (
                        <p className="text-[10px] text-muted-foreground">
                          expires {formatDateTime(tokens[0].expiresAt)}
                        </p>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex flex-wrap items-center justify-end gap-2">
                      {device.status === "active" && manageable ? (
                        <AsyncAction
                          endpoint="/api/control"
                          payload={{ resource: "device", operation: "reissueKey", values: { id: device.id, expiresInDays: 90 } }}
                          icon={<KeyRound className="size-4" aria-hidden />}
                          label="Reissue key"
                          variant="outline"
                          confirm={`Issue a new ingest key for ${device.label ?? device.id}? The current key is revoked immediately and cannot be recovered, so the new one must be copied now.`}
                        />
                      ) : null}
                      {device.status === "active" ? (
                        <AsyncAction
                          endpoint="/api/control"
                          payload={{ resource: "device", operation: "revoke", values: { id: device.id, reason: "Revoked by an operator" } }}
                          label="Revoke"
                          variant="destructive"
                          disabled={!manageable}
                          confirm={`Revoke ${device.label ?? device.id}? Its ingest keys stop authenticating immediately and further telemetry is refused.`}
                        />
                      ) : (
                        <span className="text-[11px] text-muted-foreground">revoked</span>
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

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Stethoscope className="size-4 text-primary" aria-hidden />
              Operational diagnostics
            </CardTitle>
            <CardDescription>Computed from stored events. A category with no events reports zero rather than a plausible guess.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <section>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Generation latency</p>
              {diagnostics.latency.samples === 0 ? (
                <p className="rounded-md border border-dashed px-3 py-4 text-center text-[11px] text-muted-foreground">
                  No <span className="font-mono">draft_latency</span> events. Percentiles are unavailable
                  rather than shown as 0ms, which would read as &ldquo;instant&rdquo;.
                </p>
              ) : (
                <div className="grid grid-cols-4 gap-2">
                  {[
                    { label: "samples", value: formatNumber(diagnostics.latency.samples) },
                    { label: "p50", value: `${diagnostics.latency.p50}ms` },
                    { label: "p95", value: `${diagnostics.latency.p95}ms` },
                    { label: "p99", value: `${diagnostics.latency.p99}ms` },
                  ].map((item) => (
                    <div key={item.label} className="rounded-md border p-2 text-center">
                      <p className="font-mono text-[10px] uppercase text-muted-foreground">{item.label}</p>
                      <p className="mt-0.5 font-mono text-sm font-semibold tabular-nums">{item.value}</p>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Provider errors</p>
              {diagnostics.providerErrors.total === 0 ? (
                <p className="rounded-md border border-dashed px-3 py-4 text-center text-[11px] text-muted-foreground">
                  No <span className="font-mono">provider_error</span> events.
                </p>
              ) : (
                <div className="space-y-3">
                  <div>
                    <p className="mb-1 text-[11px] text-muted-foreground">By provider</p>
                    <ul className="space-y-1">
                      {diagnostics.providerErrors.byProvider.map((row) => (
                        <li key={row.key} className="flex items-center gap-2 font-mono text-[11px]">
                          <span className="w-28 truncate">{row.key}</span>
                          <span className="h-1.5 flex-1 rounded-full bg-muted">
                            <span
                              className="block h-1.5 rounded-full bg-destructive/70"
                              style={{ width: `${Math.round((row.count / diagnostics.providerErrors.total) * 100)}%` }}
                            />
                          </span>
                          <span className="w-8 text-right tabular-nums">{row.count}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <p className="mb-1 text-[11px] text-muted-foreground">By error class</p>
                    <div className="flex flex-wrap gap-1.5">
                      {diagnostics.providerErrors.byClass.map((row) => (
                        <Badge key={row.key} variant="outline" className="font-mono text-[10px]">
                          {row.key}: {row.count}
                        </Badge>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </section>

            <section className="grid grid-cols-2 gap-3">
              <div className="rounded-md border p-3">
                <p className="text-[11px] uppercase tracking-wider text-muted-foreground">Crash reports</p>
                <p className="mt-1 font-mono text-xl font-semibold tabular-nums">{diagnostics.crashes}</p>
              </div>
              <div className="rounded-md border p-3">
                <p className="text-[11px] uppercase tracking-wider text-muted-foreground">Listener granted</p>
                <p className="mt-1 font-mono text-xl font-semibold tabular-nums">
                  {diagnostics.listener.reports === 0 ? "—" : `${diagnostics.listener.granted}/${diagnostics.listener.reports}`}
                </p>
              </div>
            </section>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Permitted event kinds</CardTitle>
            <CardDescription>
              The closed set. Batch cap {MAX_BATCH_SIZE} events; {MAX_INGEST_PER_MINUTE} events per
              device per minute.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="space-y-3">
              {EVENT_KINDS.map((kind) => (
                <li key={kind} className="rounded-md border p-3">
                  <div className="flex items-center justify-between gap-2">
                    <a href={`/devices?kind=${kind}`} className="font-mono text-xs font-medium underline-offset-4 hover:underline">
                      {kind}
                    </a>
                    <Badge variant="outline" className="font-mono text-[10px]">
                      {summary.byKind.find((row) => row.kind === kind)?.count ?? 0} received
                    </Badge>
                  </div>
                  <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">{EVENT_KIND_DOCS[kind].purpose}</p>
                  <p className="mt-1.5 font-mono text-[10px] text-muted-foreground/80">
                    {EVENT_KIND_DOCS[kind].fields.join(" · ")}
                  </p>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Radio className="size-4 text-primary" aria-hidden />
            Telemetry {params.kind ? <span className="font-mono text-xs text-muted-foreground">({params.kind})</span> : null}
            {params.device ? <span className="font-mono text-xs text-muted-foreground">(one device)</span> : null}
          </CardTitle>
          <CardDescription>
            Newest first. Payloads are exactly what passed the allow-list — no field here was added
            after validation.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {events.length === 0 ? (
            <EmptyState
              icon={Radio}
              title={params.kind || params.device ? "No events match this filter" : "No telemetry has been ingested"}
              reason={
                params.kind || params.device
                  ? "No stored event matches the current filter."
                  : "Ingestion requires a registered device with a live key and a client that sends allow-listed events. Neither exists in this environment yet, so the log is genuinely empty."
              }
              nextStep={params.kind || params.device ? "Clear the filter to see all events." : "Register a device, then POST to /api/ingest/events with its bearer key."}
              tone="neutral"
              action={
                params.kind || params.device ? (
                  <Button asChild size="sm" variant="outline">
                    <Link href="/devices">Clear filters</Link>
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Occurred</TableHead>
                  <TableHead>Device</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>App</TableHead>
                  <TableHead>Payload (allow-listed fields only)</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {events.map(({ event, deviceLabel }) => (
                  <TableRow key={event.id}>
                    <TableCell className="whitespace-nowrap text-[11px] text-muted-foreground">{formatDateTime(event.occurredAt)}</TableCell>
                    <TableCell className="text-[11px]">{deviceLabel ?? "—"}</TableCell>
                    <TableCell><StatusBadge value={event.kind === "provider_error" || event.kind === "app_crash" ? "denied" : "active"} />
                      <span className="ml-1.5 font-mono text-[10px] text-muted-foreground">{event.kind}</span>
                    </TableCell>
                    <TableCell className="font-mono text-[11px]">{event.appVersion ?? "—"}</TableCell>
                    <TableCell className="max-w-[520px]">
                      <pre className="max-h-20 overflow-auto rounded bg-muted/40 p-2 font-mono text-[10px] leading-relaxed text-muted-foreground scrollbar-thin">
                        {JSON.stringify(event.payload)}
                      </pre>
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
