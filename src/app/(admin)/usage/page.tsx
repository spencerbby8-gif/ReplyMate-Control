import type { Metadata } from "next";
import { BarChart3, Database, ShieldOff } from "lucide-react";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { StatCard } from "@/components/shared/stat-card";
import { StatusBadge } from "@/components/shared/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requireCapability } from "@/lib/authz/guard";
import { formatDateTime, formatNumber } from "@/lib/utils";
import { readProviderDistribution, readUsageAggregates, bridgeStatus } from "@/lib/supabase/bridge";
import { checkTableAccess, privacyInventory } from "@/lib/privacy/guard";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Usage" };

export default async function UsagePage() {
  await requireCapability("usage:view");
  const bridge = bridgeStatus();

  // Only attempt a read when the bridge is actually configured. When it is not,
  // the page reports unavailability rather than rendering zeros that read as data.
  const [usage, distribution] = bridge.configured
    ? await Promise.all([readUsageAggregates(), readProviderDistribution()])
    : [
        { ok: false as const, data: null, source: "supabase" as const, error: bridge.reason, code: "unconfigured" as const },
        { ok: false as const, data: null, source: "supabase" as const, error: bridge.reason, code: "unconfigured" as const },
      ];

  const deniedTables = privacyInventory().denied;
  const usageDecision = checkTableAccess("usage_event");
  const providerDecision = checkTableAccess("provider_def");
  const messageDecision = checkTableAccess("message");

  const totals = usage.ok && usage.data
    ? usage.data.reduce(
        (acc, row) => ({
          requests: acc.requests + row.requests,
          tokensIn: acc.tokensIn + row.tokens_in,
          tokensOut: acc.tokensOut + row.tokens_out,
        }),
        { requests: 0, tokensIn: 0, tokensOut: 0 },
      )
    : null;

  return (
    <>
      <PageHeader
        title="Usage"
        description="Aggregate token and request telemetry from the ReplyMate cloud foundation. Grouped by model and usage kind only — there is no per-user, per-contact or per-message breakdown, because that would require reading content this platform is forbidden from touching."
        meta={
          <>
            <Badge variant={bridge.configured ? "success" : "muted"} className="font-mono text-[11px]">
              bridge: {bridge.mode}
            </Badge>
            <Badge variant="outline" className="font-mono text-[11px]">aggregate only</Badge>
            <Badge variant="outline" className="font-mono text-[11px]">read only</Badge>
          </>
        }
      />

      <Alert variant={bridge.configured ? "info" : "warning"}>
        <Database aria-hidden />
        <AlertTitle>{bridge.configured ? "Supabase bridge is live" : "Supabase bridge is closed"}</AlertTitle>
        <AlertDescription>
          <p>{bridge.reason}</p>
          {bridge.projectUrl ? (
            <p className="font-mono text-[11px]">project: {new URL(bridge.projectUrl).host}</p>
          ) : (
            <p className="font-mono text-[11px]">
              project: xdcsxxwhvpiissetbrdr.supabase.co (documented, not connected from this environment)
            </p>
          )}
        </AlertDescription>
      </Alert>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Requests" value={totals ? formatNumber(totals.requests) : "—"} hint={totals ? "Rows in usage_event" : "Bridge unavailable"} icon={BarChart3} tone={totals ? "neutral" : "muted"} />
        <StatCard label="Tokens in" value={totals ? formatNumber(totals.tokensIn) : "—"} hint="Prompt tokens, summed" icon={BarChart3} tone={totals ? "neutral" : "muted"} />
        <StatCard label="Tokens out" value={totals ? formatNumber(totals.tokensOut) : "—"} hint="Completion tokens, summed" icon={BarChart3} tone={totals ? "neutral" : "muted"} />
        <StatCard
          label="Denied tables"
          value={deniedTables.length}
          hint="message, memory_fact, contact_summary, draft, style_profile, app_kv"
          icon={ShieldOff}
          tone="positive"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Tokens by model and kind</CardTitle>
            <CardDescription>
              {usageDecision.allowed
                ? `Allow-listed read: ${usageDecision.columns.join(", ")} on ${usageDecision.table}. ${usageDecision.reason}`
                : usageDecision.reason}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {!usage.ok ? (
              <EmptyState
                icon={BarChart3}
                title="Usage telemetry unavailable"
                reason={usage.error}
                nextStep="Set NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY in the server environment, then reload. No numbers are estimated in the meantime."
                tone="waiting"
              />
            ) : usage.data.length === 0 ? (
              <EmptyState
                icon={BarChart3}
                title="No usage events recorded"
                reason="The bridge connected successfully and the query returned zero rows. usage_event is written by the app only when a user has signed in and generated a draft; a fresh or idle project legitimately has none."
                tone="neutral"
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Model</TableHead>
                    <TableHead>Kind</TableHead>
                    <TableHead className="text-right">Requests</TableHead>
                    <TableHead className="text-right">Tokens in</TableHead>
                    <TableHead className="text-right">Tokens out</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {usage.data.map((row) => (
                    <TableRow key={`${row.model}-${row.kind}`}>
                      <TableCell className="font-mono text-[11px]">{row.model}</TableCell>
                      <TableCell><StatusBadge value={row.kind} /></TableCell>
                      <TableCell className="text-right font-mono text-xs">{formatNumber(row.requests)}</TableCell>
                      <TableCell className="text-right font-mono text-xs">{formatNumber(row.tokens_in)}</TableCell>
                      <TableCell className="text-right font-mono text-xs">{formatNumber(row.tokens_out)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Provider and model distribution</CardTitle>
            <CardDescription>
              {providerDecision.allowed
                ? `Allow-listed read: ${providerDecision.columns.join(", ")} on ${providerDecision.table}. key_ref is excluded — even a vault label is not needed here.`
                : providerDecision.reason}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {!distribution.ok ? (
              <EmptyState
                icon={Database}
                title="Provider distribution unavailable"
                reason={distribution.error}
                nextStep="Configure the Supabase bridge credentials to enable this read."
                tone="waiting"
              />
            ) : distribution.data.length === 0 ? (
              <EmptyState
                icon={Database}
                title="No provider rows recorded"
                reason="The query succeeded and returned zero rows. provider_def only gains a row when a user adds a BYOK key on their device."
                tone="neutral"
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Provider</TableHead>
                    <TableHead>Model</TableHead>
                    <TableHead className="text-right">Rows</TableHead>
                    <TableHead className="text-right">Active</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {distribution.data.map((row) => (
                    <TableRow key={`${row.type}-${row.model_name}`}>
                      <TableCell className="font-mono text-[11px]">{row.type}</TableCell>
                      <TableCell className="font-mono text-[11px]">{row.model_name}</TableCell>
                      <TableCell className="text-right font-mono text-xs">{formatNumber(row.total)}</TableCell>
                      <TableCell className="text-right font-mono text-xs">{formatNumber(row.active)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="border-destructive/25">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-destructive">
            <ShieldOff className="size-4" aria-hidden />
            What this page can never show
          </CardTitle>
          <CardDescription>
            {messageDecision.allowed ? "Unexpected: message access is allowed." : messageDecision.reason}
          </CardDescription>
        </CardHeader>
        <CardContent className="text-xs leading-relaxed text-muted-foreground">
          <p>
            Message bodies, memory facts, rolling summaries, drafts, prompt snapshots, style samples,
            contact names and <span className="font-mono">app_kv</span> preferences are all on the deny
            list in <span className="font-mono">src/lib/privacy/guard.ts</span>. Access is refused
            before a query is constructed, the refusal throws a{" "}
            <span className="font-mono">PrivacyViolation</span> (HTTP 451), and the attempt is written
            to the audit log.
          </p>
          <p className="pt-2 font-mono text-[11px]">
            checked at {formatDateTime(new Date())} · sync_enabled=false · byok_keys=on-device-only
          </p>
        </CardContent>
      </Card>
    </>
  );
}
