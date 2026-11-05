import type { Metadata } from "next";
import { Ban, Check, Lock, ShieldCheck, X } from "lucide-react";
import { PageHeader } from "@/components/shared/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requireCapability } from "@/lib/authz/guard";
import { envReport } from "@/config/env";
import { REPLYMATE_SUPABASE_PROJECT_URL, REPLYMATE_APPLIED_MIGRATIONS, SOURCE_FILES } from "@/config/catalog";
import { privacyInventory } from "@/lib/privacy/guard";
import { fetchSupabaseMigrationLedger } from "@/lib/integrations/github";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Privacy" };

function Rule({ ok, label, detail }: { ok: boolean; label: string; detail: string }) {
  return (
    <li className="flex items-start gap-3 rounded-md border p-3">
      <span className={`mt-0.5 grid size-5 shrink-0 place-items-center rounded-full ${ok ? "bg-success/15 text-success" : "bg-destructive/15 text-destructive"}`}>
        {ok ? <Check className="size-3" aria-hidden /> : <X className="size-3" aria-hidden />}
      </span>
      <div className="min-w-0">
        <p className="text-xs font-semibold">{label}</p>
        <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{detail}</p>
      </div>
    </li>
  );
}

export default async function PrivacyPage() {
  await requireCapability("privacy:view");
  const inventory = privacyInventory();
  const report = envReport();
  const ledger = await fetchSupabaseMigrationLedger();

  return (
    <>
      <PageHeader
        title="Privacy contract"
        description="The binding rules this platform operates under, inherited from ReplyMate's local-first design and enforced in code rather than by policy alone."
        meta={
          <>
            <Badge variant="success" className="font-mono text-[11px]">sync_enabled=false</Badge>
            <Badge variant="success" className="font-mono text-[11px]">byok_keys=on-device</Badge>
            <Badge variant="outline" className="font-mono text-[11px]">{inventory.denied.length} denied tables</Badge>
            <Badge variant="outline" className="font-mono text-[11px]">{inventory.allowed.length} allow-listed</Badge>
          </>
        }
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldCheck className="size-4 text-success" aria-hidden />
              Guaranteed
            </CardTitle>
            <CardDescription>Invariants that hold in every environment and every code path.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2">
              <Rule ok label="Message sync can never be enabled from here" detail="SYNC_ENABLED=false in the Android app is pinned by SupabaseConfigTest. The message_sync flag is pinned off server-side, cannot be set to any other value and cannot be deleted." />
              <Rule ok label="No message content is readable" detail="message, memory_fact, contact_summary, draft, style_profile, app_kv, contact and contact_channel are on a deny list checked before any query is built." />
              <Rule ok label="No provider API key is stored or transmitted" detail="Keys are BYOK, encrypted with the Android Keystore (rm_master, AES/GCM/NoPadding) in the app's private secrets.xml. provider_def.key_ref is excluded from every permitted projection." />
              <Rule ok label="Access is allow-list, not deny-list" detail="checkTableAccess refuses anything not explicitly permitted with a reason, and throws PrivacyViolation (HTTP 451) rather than returning an empty result that looks like success." />
              <Rule ok label="Audit payloads are redacted before write" detail="Credential-shaped keys and values are replaced, content-shaped fields are dropped, and the log is append-only with no update or delete path anywhere in the repository." />
              <Rule ok label="Secrets are never rendered, logged or committed" detail="envReport() exposes presence booleans only. .env is gitignored, a pre-commit secret scan runs, and the GitHub PAT and Supabase service-role key appear in no source file." />
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Ban className="size-4 text-destructive" aria-hidden />
              Out of scope for this platform
            </CardTitle>
            <CardDescription>Things that would require an owner-approved change to the Android product.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2">
              <Rule ok={false} label="Reading any conversation" detail="Not possible by construction. There is no code path, no query and no API route that selects message content." />
              <Rule ok={false} label="Remote wipe, lock or configuration push to a device" detail="No device channel exists. The app is local-first and pulls configuration only where a future phase wires it." />
              <Rule ok={false} label="Applying database migrations" detail="This platform never runs a migration against the ReplyMate project. Migration SQL authored here is documentation for an owner to apply deliberately." />
              <Rule ok={false} label="Building, signing, publishing or deploying the Android app" detail="The repository integration is GET-only. Releases are recorded by reading releases/RELEASES.md." />
              <Rule ok={false} label="Billing or taking payment" detail="Deferred by the Supabase foundation phase. No gateway is connected and no synthetic subscription data is shown." />
              <Rule ok={false} label="Exporting end-user identities" detail="The only end-user read permitted is a scalar count. No email, id or metadata crosses the bridge." />
            </ul>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Lock className="size-4 text-primary" aria-hidden />
            Cross-database access control
          </CardTitle>
          <CardDescription>
            Enforced by <span className="font-mono">src/lib/privacy/guard.ts</span> and covered by{" "}
            <span className="font-mono">tests/privacy-guard.test.ts</span>.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-success">Allowed (aggregate / non-content)</h3>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Table</TableHead>
                  <TableHead>Permitted columns</TableHead>
                  <TableHead>Mode</TableHead>
                  <TableHead>Justification</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {inventory.allowed.map((entry) => (
                  <TableRow key={entry.table}>
                    <TableCell className="font-mono text-[11px]">{entry.table}</TableCell>
                    <TableCell className="font-mono text-[10px] text-muted-foreground">{entry.columns.join(", ")}</TableCell>
                    <TableCell><Badge variant={entry.aggregateOnly ? "warning" : "info"} className="font-mono text-[10px]">{entry.aggregateOnly ? "aggregate" : "row"}</Badge></TableCell>
                    <TableCell className="max-w-[420px] text-[11px] leading-relaxed text-muted-foreground">{entry.reason}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </section>

          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-destructive">Denied (end-user content)</h3>
            <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
              {inventory.denied.map((entry) => (
                <li key={entry.table} className="rounded-md border border-destructive/25 bg-destructive/[0.04] p-2.5">
                  <p className="font-mono text-[11px] font-medium text-destructive">{entry.table}</p>
                  <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">{entry.reason}</p>
                </li>
              ))}
            </ul>
          </section>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>ReplyMate cloud foundation</CardTitle>
            <CardDescription>Read live from the source repository where network egress allows.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-xs">
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">Project URL</span>
              <span className="break-all font-mono text-[11px]">{REPLYMATE_SUPABASE_PROJECT_URL}</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">Migrations recorded as applied</span>
              <span className="font-mono text-[11px]">{REPLYMATE_APPLIED_MIGRATIONS.join(", ")}</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">RLS</span>
              <span className="font-mono text-[11px]">enabled on all 10 app tables + ledger</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">anon role privileges</span>
              <span className="font-mono text-[11px]">none (revoked in 0003)</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">authenticated role privileges</span>
              <span className="font-mono text-[11px]">exactly CRUD, owner-scoped by RLS</span>
            </div>

            {ledger.ok ? (
              <div className="border-t pt-3">
                <p className="mb-2 font-medium">Ledger as read from {ledger.source}</p>
                <ul className="space-y-1">
                  {ledger.rows.map((row) => (
                    <li key={`${row.version}-${row.file}`} className="flex items-baseline gap-2 font-mono text-[11px]">
                      <span className="w-12 shrink-0 text-muted-foreground">{row.version}</span>
                      <span className="min-w-0 flex-1 break-all">{row.file}</span>
                      <span className="shrink-0 text-muted-foreground">{row.applied}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="border-t pt-3 leading-relaxed text-muted-foreground">
                The source ledger could not be read from this host ({ledger.error}). The versions above
                come from <span className="font-mono">{SOURCE_FILES.supabaseReadme}</span> and are
                shown as documented rather than presented as a live confirmation.
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>This platform&rsquo;s own posture</CardTitle>
            <CardDescription>What is true of ReplyMate Control itself, right now.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-xs">
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">Identity provider</span>
              <span className="font-mono text-[11px]">{report.authProvider}</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">Supabase bridge</span>
              <Badge variant={report.supabase.configured ? "success" : "muted"} className="font-mono text-[10px]">
                {report.supabase.configured ? "live" : "closed"}
              </Badge>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">TOTP encryption key</span>
              <Badge variant={report.controlPlane.hasEncryptionKey ? "success" : "destructive"} className="font-mono text-[10px]">
                {report.controlPlane.hasEncryptionKey ? "present" : "missing"}
              </Badge>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">Session lifetime</span>
              <span className="font-mono text-[11px]">{report.controlPlane.sessionTtlHours}h sliding</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">AI ops assistant</span>
              <span className="font-mono text-[11px]">{report.aiOps.llmActive ? `${report.aiOps.provider} (llm)` : "deterministic"}</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">Source repository token</span>
              <Badge variant={report.replymate.hasReadToken ? "info" : "muted"} className="font-mono text-[10px]">
                {report.replymate.hasReadToken ? "configured" : "not configured"}
              </Badge>
            </div>
            <p className="border-t pt-3 leading-relaxed text-muted-foreground">
              Presence flags only. No secret value is exposed on this page, in{" "}
              <span className="font-mono">/api/health</span>, or in any API response.
            </p>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
