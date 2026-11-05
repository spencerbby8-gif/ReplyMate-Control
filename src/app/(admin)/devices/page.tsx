import type { Metadata } from "next";
import { Smartphone, ShieldOff } from "lucide-react";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { StatCard } from "@/components/shared/stat-card";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requireCapability } from "@/lib/authz/guard";
import { MIN_SUPPORTED_ANDROID_API, TARGET_ANDROID_API } from "@/config/catalog";
import { formatDateTime, formatRelative } from "@/lib/utils";
import { deviceStats, listDevices } from "@/lib/queries/ops";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Devices" };

export default async function DevicesPage() {
  await requireCapability("devices:view");
  const [devices, stats] = await Promise.all([listDevices(), deviceStats()]);

  return (
    <>
      <PageHeader
        title="Devices"
        description="Opt-in device diagnostics. ReplyMate is local-first and the Android app reports nothing to this platform today, so the inventory below is empty by construction — not unfetched."
        meta={
          <>
            <Badge variant="outline" className="font-mono text-[11px]">{stats.total} enrolled</Badge>
            <Badge variant="muted" className="font-mono text-[11px]">no reporting channel exists</Badge>
            <Badge variant="outline" className="font-mono text-[11px]">minSdk {MIN_SUPPORTED_ANDROID_API} · targetSdk {TARGET_ANDROID_API}</Badge>
          </>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Enrolled devices" value={stats.total} hint="Consent is a precondition for any row" icon={Smartphone} tone={stats.total === 0 ? "muted" : "neutral"} />
        <StatCard label="Reporting channel" value="none" hint="No client build sends device diagnostics" icon={ShieldOff} tone="muted" />
        <StatCard label="Listener telemetry" value="off" hint="Notification-listener state never leaves the device" icon={ShieldOff} tone="positive" />
        <StatCard label="Content collected" value="0" hint="Message text is never part of any diagnostic" icon={ShieldOff} tone="positive" />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Smartphone className="size-4 text-primary" aria-hidden />
            Device inventory
          </CardTitle>
          <CardDescription>
            A row can only exist once a user has explicitly consented to diagnostics and a client
            build ships a channel that writes it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {devices.length === 0 ? (
            <EmptyState
              icon={Smartphone}
              title="No devices are enrolled"
              reason="This is the honest state, not a loading failure. ReplyMate stores everything on-device (getFilesDir, allowBackup=false, FLAG_SECURE on sensitive screens) and no shipped version transmits device diagnostics. The consent_recorded_at column is NOT NULL, so a row cannot be inserted without a recorded consent timestamp."
              nextStep="If device diagnostics are ever wanted, they need an owner-approved phase that adds (1) an in-app consent screen, (2) an opt-in transport, and (3) a change-control entry in docs/BLUEPRINT.md §11. Nothing here should be faked in the meantime."
              tone="blocked"
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Label</TableHead>
                  <TableHead>App version</TableHead>
                  <TableHead>API level</TableHead>
                  <TableHead>Model</TableHead>
                  <TableHead>Listener</TableHead>
                  <TableHead>Consent recorded</TableHead>
                  <TableHead>Last seen</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {devices.map((device) => (
                  <TableRow key={device.id}>
                    <TableCell className="text-xs">{device.label ?? "unlabelled"}</TableCell>
                    <TableCell className="font-mono text-[11px]">{device.appVersion ?? "—"}</TableCell>
                    <TableCell className="font-mono text-[11px]">{device.androidApiLevel ?? "—"}</TableCell>
                    <TableCell className="text-[11px] text-muted-foreground">{device.deviceModel ?? "—"}</TableCell>
                    <TableCell className="font-mono text-[11px]">{device.listenerGranted}</TableCell>
                    <TableCell className="text-[11px] text-muted-foreground">{formatDateTime(device.consentRecordedAt)}</TableCell>
                    <TableCell className="text-[11px] text-muted-foreground">{device.lastSeenAt ? formatRelative(device.lastSeenAt) : "never"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card className="border-primary/25 bg-primary/[0.03]">
        <CardHeader>
          <CardTitle>What a future diagnostics channel may not collect</CardTitle>
          <CardDescription>Binding constraints carried over from the Android security model.</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="grid gap-2 text-xs leading-relaxed text-muted-foreground sm:grid-cols-2">
            <li className="rounded-md border bg-background/40 p-3">Message bodies, notification text, media references or URIs — captured locally, never opened or uploaded.</li>
            <li className="rounded-md border bg-background/40 p-3">Contact display names, relationship notes or remote conversation keys.</li>
            <li className="rounded-md border bg-background/40 p-3">Memory facts, rolling summaries, style samples or prompt snapshots.</li>
            <li className="rounded-md border bg-background/40 p-3">Provider API keys or any vault reference. Keys never leave the Android Keystore.</li>
            <li className="rounded-md border bg-background/40 p-3">Anything without a recorded consent timestamp — the schema makes that unrepresentable.</li>
            <li className="rounded-md border bg-background/40 p-3">Persistent identifiers that could link a device to a person across installs.</li>
          </ul>
        </CardContent>
      </Card>
    </>
  );
}
