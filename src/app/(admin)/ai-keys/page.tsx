import type { Metadata } from "next";
import { AlertTriangle, Database, KeyRound, ServerCog, ShieldCheck, TriangleAlert } from "lucide-react";
import { PageHeader } from "@/components/shared/page-header";
import { StatCard } from "@/components/shared/stat-card";
import { StatusBadge, Dot } from "@/components/shared/status-badge";
import { EmptyState } from "@/components/shared/empty-state";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DisableKeyDialog, RotateDialog, SetKeyDialog } from "@/components/forms/vault";
import { requireCapability } from "@/lib/authz/guard";
import { can } from "@/lib/authz/permissions";
import { formatDateTime } from "@/lib/utils";
import { NOT_VAULTABLE, VAULT_PROVIDERS, vaultStatus } from "@/lib/vault/provider-keys";
import {
  MANAGEMENT_PERMISSIONS,
  MANAGEMENT_SCOPES,
  BOOTSTRAP_VARIABLES,
} from "@/config/vault-requirements";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "AI key vault" };

export default async function AiKeysPage() {
  const { admin } = await requireCapability("vault:view");
  const manageable = can(admin.role, "vault:manage");
  const status = await vaultStatus();

  const mfaEnrolled = admin.mfaEnrolledAt !== null;
  const configuredKeys = status.providers.filter((p) => p.usable).length;
  const drifting = status.providers.flatMap((p) => p.slots.filter((s) => s.drifted));
  const gateway = status.functions.gateway;

  return (
    <>
      <PageHeader
        title="AI key vault"
        description="Platform provider master keys for ReplyMate's built-in AI. The authoritative store is Supabase Edge Function Secrets on the production project; this platform manages it and keeps metadata only."
        meta={
          <>
            <Badge variant={status.management.configured ? "success" : "destructive"} className="font-mono text-[11px]">
              management api: {status.management.configured ? "configured" : "not configured"}
            </Badge>
            <Badge variant={gateway?.deployed ? "success" : "warning"} className="font-mono text-[11px]">
              gateway: {gateway?.deployed ? gateway.status ?? "deployed" : "not deployed"}
            </Badge>
            <Badge variant="outline" className="font-mono text-[11px]">{configuredKeys}/{VAULT_PROVIDERS.length} providers keyed</Badge>
          </>
        }
      />

      {/* The design guarantee, stated where an operator will look for it. */}
      <Card className="border-primary/25 bg-primary/[0.03]">
        <CardContent className="flex items-start gap-3 pt-0">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
          <div className="space-y-1 text-xs leading-relaxed text-muted-foreground">
            <p className="font-medium text-foreground">
              A saved key cannot be read back — not by this UI, not by an API route, not by a
              database dump.
            </p>
            <p>
              The value exists in this process only for the duration of one request, is sent once
              over TLS to the Supabase Management API, and is then dropped.{" "}
              <span className="font-mono">ctl_provider_key</span> has{" "}
              <strong>no column in which a value could be stored</strong>: only a non-reversible
              HMAC fingerprint and a character count. Supabase does not return secret values either,
              so there is no read path at all.
            </p>
            <p>
              Consequence: this platform <strong>cannot test a key itself</strong>, because testing
              requires using it. A probe must be performed by the deployed gateway, which is the only
              component holding a value at runtime. Until it is deployed, testing reports{" "}
              <span className="font-mono">unavailable</span> rather than a fabricated result.
            </p>
          </div>
        </CardContent>
      </Card>

      {!status.management.configured ? (
        <Alert variant="destructive">
          <TriangleAlert aria-hidden />
          <AlertTitle>Management API is not configured — no key can be written</AlertTitle>
          <AlertDescription>
            <p>{status.management.reason}</p>
            <p>
              The project keys this app already holds authenticate against the <em>data plane</em>{" "}
              (PostgREST, GoTrue, Storage). They are rejected by{" "}
              <span className="font-mono">api.supabase.com</span> — verified live:{" "}
              <span className="font-mono">401 JWT could not be decoded</span>. Managing Edge Function
              secrets needs a separate access token.
            </p>
            <p className="font-medium">
              There is no fallback store and none will be created. Until the token is present, every
              write fails closed with the reason above rather than silently persisting a key in the
              database.
            </p>
          </AlertDescription>
        </Alert>
      ) : null}

      {!mfaEnrolled ? (
        <Alert variant="warning">
          <AlertTriangle aria-hidden />
          <AlertTitle>Multi-factor authentication is not enrolled</AlertTitle>
          <AlertDescription>
            <p>
              Vault writes require a session that has actually completed an MFA challenge. Enrol TOTP
              from <span className="font-medium">Security</span> and sign in again, or every write
              here will be refused with <span className="font-mono">403 mfa_required</span>.
            </p>
          </AlertDescription>
        </Alert>
      ) : null}

      {drifting.length > 0 ? (
        <Alert variant="warning">
          <AlertTriangle aria-hidden />
          <AlertTitle>{drifting.length} key record(s) have drifted from Supabase</AlertTitle>
          <AlertDescription>
            <p>
              Metadata says these secrets exist but the project does not have them — someone changed
              them in the dashboard, or a write failed part-way.{" "}
              {drifting.map((d) => d.secretName).join(", ")}
            </p>
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Providers keyed"
          value={`${configuredKeys}/${VAULT_PROVIDERS.length}`}
          hint="At least one slot present in Supabase"
          icon={KeyRound}
          tone={configuredKeys === 0 ? "warning" : "positive"}
        />
        <StatCard
          label="Platform-enabled"
          value={status.providers.filter((p) => p.platformEnabled).length}
          hint="May spend platform funds; BYOK always stays available"
          icon={ServerCog}
          tone="neutral"
        />
        <StatCard
          label="Mid-rotation"
          value={status.providers.filter((p) => p.rotating).length}
          hint="Gateway prefers _NEXT, falls back to primary"
          icon={KeyRound}
          tone={status.providers.some((p) => p.rotating) ? "warning" : "positive"}
        />
        <StatCard
          label="Untracked secrets"
          value={status.untrackedRemoteSecrets.length}
          hint="Match the gateway naming but have no metadata row"
          icon={Database}
          tone={status.untrackedRemoteSecrets.length > 0 ? "warning" : "positive"}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="size-4 text-primary" aria-hidden />
            Provider master keys
          </CardTitle>
          <CardDescription>
            Secret names match{" "}
            <span className="font-mono">supabase/functions/_shared/ai-gateway/keys.ts</span> exactly,
            so the gateway resolves what is written here without any mapping layer.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Provider</TableHead>
                <TableHead>Slot</TableHead>
                <TableHead>Secret name</TableHead>
                <TableHead>In Supabase</TableHead>
                <TableHead>Fingerprint</TableHead>
                <TableHead>Length</TableHead>
                <TableHead>Last verified</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {status.providers.flatMap((provider) =>
                provider.slots.map((slot) => (
                  <TableRow key={`${provider.providerKey}-${slot.slot}`}>
                    <TableCell>
                      <p className="flex items-center gap-2 text-xs font-medium">
                        <Dot tone={provider.usable ? "success" : "muted"} pulse={provider.rotating} />
                        {provider.providerKey}
                      </p>
                      <p className="mt-0.5 text-[10px] text-muted-foreground">
                        platform {provider.platformEnabled ? "on" : "off"} · byok always on · cap{" "}
                        {provider.dailySpendCapMicroUsd} µUSD/day
                        {provider.rotating ? " · rotating" : ""}
                      </p>
                    </TableCell>
                    <TableCell><StatusBadge value={slot.slot === "primary" ? "active" : "invited"} />
                      <span className="ml-1.5 font-mono text-[10px] text-muted-foreground">{slot.slot}</span>
                    </TableCell>
                    <TableCell className="font-mono text-[11px]">{slot.secretName}</TableCell>
                    <TableCell>
                      {slot.presentRemotely ? (
                        <StatusBadge value="active" />
                      ) : slot.drifted ? (
                        <StatusBadge value="suspended" />
                      ) : (
                        <span className="text-[11px] text-muted-foreground">absent</span>
                      )}
                      {slot.drifted ? (
                        <p className="mt-0.5 text-[10px] text-destructive">metadata only — not in Supabase</p>
                      ) : null}
                    </TableCell>
                    <TableCell className="font-mono text-[10px] text-muted-foreground">
                      {slot.fingerprint ? `${slot.fingerprint.slice(0, 12)}…` : "—"}
                    </TableCell>
                    <TableCell className="font-mono text-[11px]">
                      {slot.valueLength ? `${slot.valueLength} chars` : "—"}
                    </TableCell>
                    <TableCell className="text-[11px] text-muted-foreground">
                      {slot.lastVerifiedAt ? (
                        <>
                          <StatusBadge value={slot.lastVerifiedOutcome === "ok" ? "active" : "suspended"} />
                          <span className="mt-0.5 block text-[10px]" title={slot.lastVerifiedAt}>
                            {formatDateTime(slot.lastVerifiedAt)}
                          </span>
                        </>
                      ) : (
                        <span className="text-[10px]">never probed</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap items-center justify-end gap-2">
                        <SetKeyDialog
                          providerKey={provider.providerKey}
                          slot={slot.slot}
                          secretName={slot.secretName}
                          disabled={!manageable}
                          disabledReason={manageable ? undefined : "Requires vault:manage (owner)."}
                        />
                        {slot.slot === "primary" ? (
                          <>
                            <RotateDialog
                              providerKey={provider.providerKey}
                              phase="stage"
                              disabled={!manageable || !status.management.configured}
                              disabledReason={
                                !manageable ? "Requires vault:manage (owner)." : "Management API not configured."
                              }
                            />
                            {provider.rotating ? (
                              <RotateDialog
                                providerKey={provider.providerKey}
                                phase="promote"
                                disabled={!manageable || !status.management.configured}
                              />
                            ) : null}
                          </>
                        ) : null}
                        {slot.presentRemotely ? (
                          <DisableKeyDialog
                            providerKey={provider.providerKey}
                            slot={slot.slot}
                            secretName={slot.secretName}
                            disabled={!manageable}
                          />
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                )),
              )}
            </TableBody>
          </Table>

          <p className="mt-4 text-[11px] leading-relaxed text-muted-foreground">
            <span className="font-medium text-foreground">Rotation is two-phase.</span> Stage writes
            the new key to <span className="font-mono">_NEXT</span> and marks the provider rotating, so
            the gateway prefers the new key while the old one stays as fallback — zero downtime.
            Promotion writes it to the primary slot and deletes <span className="font-mono">_NEXT</span>,
            and requires re-entering the same key: Supabase secrets are write-only and nothing here
            stores a value, so the server verifies by fingerprint. That re-entry is a control, not an
            inconvenience — it proves continued possession.
          </p>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Required permissions — before you create a token</CardTitle>
            <CardDescription>
              Request the minimum. A token that can pause, restart or recreate the project is not
              needed to rotate a provider key, and asking for it widens the blast radius of a leak
              for nothing.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 text-xs">
            <div>
              <p className="mb-2 font-medium">Fine-grained token permissions</p>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Permission</TableHead>
                    <TableHead>Endpoint</TableHead>
                    <TableHead>Used for</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {MANAGEMENT_PERMISSIONS.map((permission) => (
                    <TableRow key={permission.name}>
                      <TableCell className="font-mono text-[11px]">{permission.name}</TableCell>
                      <TableCell className="font-mono text-[10px] text-muted-foreground">{permission.endpoint}</TableCell>
                      <TableCell className="text-[11px] text-muted-foreground">{permission.usedFor}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div>
              <p className="mb-1.5 font-medium">Legacy OAuth scopes (if a non-fine-grained token is used)</p>
              <p className="font-mono text-[11px] text-muted-foreground">{MANAGEMENT_SCOPES.join(" · ")}</p>
            </div>
            <div className="rounded-md border border-destructive/25 bg-destructive/[0.04] p-3">
              <p className="font-medium text-destructive">Deliberately NOT requested</p>
              <p className="mt-1 leading-relaxed text-muted-foreground">
                <span className="font-mono">projects:write</span>,{" "}
                <span className="font-mono">database:write</span>,{" "}
                <span className="font-mono">storage:*</span>,{" "}
                <span className="font-mono">api_gateway_keys_*</span>,{" "}
                <span className="font-mono">auth_signing_keys_*</span>,{" "}
                <span className="font-mono">organization_*</span>. None of these is needed to manage
                Edge Function secrets.
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>One-time bootstrap variables</CardTitle>
            <CardDescription>
              Add these to the hosting environment once. After that, routine key management happens
              entirely here — no dashboard visit per key change.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Variable</TableHead>
                  <TableHead>Required</TableHead>
                  <TableHead>Purpose</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {BOOTSTRAP_VARIABLES.map((variable) => (
                  <TableRow key={variable.name}>
                    <TableCell className="font-mono text-[11px]">{variable.name}</TableCell>
                    <TableCell>
                      <StatusBadge value={variable.required ? "active" : "invited"} />
                    </TableCell>
                    <TableCell className="max-w-[300px] text-[11px] leading-relaxed text-muted-foreground">
                      {variable.purpose}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
              None of these may be prefixed <span className="font-mono">NEXT_PUBLIC_</span>. The build
              refuses to start if a secret-shaped value is found behind that prefix, because Next.js
              would inline it into the browser bundle.
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Gateway deployment</CardTitle>
          <CardDescription>
            Deployment is a scripted, owner-approved action — not an admin button. Shipping code to
            production should never be one click away from a key-rotation screen.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-xs">
          {status.functions.readable ? (
            gateway?.deployed ? (
              <div className="flex flex-wrap items-center gap-2 rounded-md border border-success/30 bg-success/5 p-3">
                <Dot tone="success" pulse />
                <span className="font-mono text-[11px]">{gateway.slug}</span>
                <StatusBadge value="active" />
                <span className="font-mono text-[11px] text-muted-foreground">
                  status {gateway.status ?? "?"} · version {gateway.version ?? "?"}
                </span>
              </div>
            ) : (
              <EmptyState
                icon={ServerCog}
                title="The replymate-ai Edge Function is not deployed"
                reason="The Management API is reachable and reports no function with that slug. Until it is deployed, no component holds a provider key at runtime, so keys written here are inert and cannot be probed."
                nextStep="Run `npx tsx scripts/deploy-edge-function.ts --confirm` after reviewing what it will ship. It requires the SUPABASE_ACCESS_TOKEN with edge_functions_write, and it refuses to run without the explicit flag."
                tone="waiting"
              />
            )
          ) : (
            <EmptyState
              icon={ServerCog}
              title="Deployment state is unknown"
              reason={status.functions.error ?? "The Management API could not be queried."}
              nextStep="Configure SUPABASE_ACCESS_TOKEN with edge_functions_read to see whether the gateway is deployed."
              tone="blocked"
            />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Providers that must never hold a platform key</CardTitle>
          <CardDescription>Excluded from the vault by design, not by oversight.</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="grid gap-2 sm:grid-cols-2">
            {NOT_VAULTABLE.map((entry) => (
              <li key={entry.key} className="rounded-md border p-3">
                <p className="font-mono text-xs font-medium">{entry.key}</p>
                <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{entry.reason}</p>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
            These remain available to users through <span className="font-medium text-foreground">BYOK</span>,
            which is unchanged: their own key, encrypted in the Android Keystore, used on-device, never
            sent to this platform or to the gateway. Platform AI and BYOK are separate modes selected by
            the user and enforced server-side — a BYOK request is never silently routed through a
            platform key, or vice versa.
          </p>
        </CardContent>
      </Card>
    </>
  );
}
