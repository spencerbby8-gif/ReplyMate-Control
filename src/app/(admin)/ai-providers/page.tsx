import type { Metadata } from "next";
import { Cpu, KeyRound, RefreshCcw } from "lucide-react";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { StatCard } from "@/components/shared/stat-card";
import { StatusBadge } from "@/components/shared/status-badge";
import { AsyncAction } from "@/components/shared/async-action";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requireCapability } from "@/lib/authz/guard";
import { can } from "@/lib/authz/permissions";
import { PROVIDER_CATALOGUE, FALLBACK_SEARCH, SOURCE_FILES } from "@/config/catalog";
import { listProviders, providerStats } from "@/lib/queries/ops";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "AI providers" };

export default async function ProvidersPage() {
  const { admin } = await requireCapability("providers:view");
  const manageable = can(admin.role, "providers:manage");
  const [providers, stats] = await Promise.all([listProviders(), providerStats()]);

  return (
    <>
      <PageHeader
        title="AI providers"
        description="The provider catalogue ReplyMate actually implements, with the wire dialect and capability binding for each. Transcribed from the Android repository — not invented here."
        actions={
          manageable ? (
            <AsyncAction
              endpoint="/api/control"
              payload={{ resource: "provider", operation: "resyncCatalogue", values: {} }}
              icon={<RefreshCcw className="size-4" aria-hidden />}
              label="Re-sync catalogue"
              variant="outline"
              confirm="Re-sync provider rows from the ReplyMate source catalogue? Operational status you set is preserved for existing keys."
            />
          ) : undefined
        }
        meta={
          <>
            <Badge variant="outline" className="font-mono text-[11px]">{PROVIDER_CATALOGUE.length} in source catalogue</Badge>
            <Badge variant="outline" className="font-mono text-[11px]">{stats.total} rows loaded</Badge>
            <Badge variant="success" className="font-mono text-[11px]">byok only · zero keys stored here</Badge>
          </>
        }
      />

      <Card className="border-primary/25 bg-primary/[0.03]">
        <CardContent className="flex items-start gap-3 pt-0">
          <KeyRound className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
          <p className="text-xs leading-relaxed text-muted-foreground">
            <span className="font-medium text-foreground">No key material exists in this platform.</span>{" "}
            ReplyMate is BYOK: each user&rsquo;s provider key is encrypted with the Android Keystore
            (<span className="font-mono">rm_master</span>, AES/GCM/NoPadding) and stored in the
            app&rsquo;s private <span className="font-mono">secrets.xml</span>. The cloud{" "}
            <span className="font-mono">provider_def.key_ref</span> column holds a vault label, and even
            that is excluded from every query this platform is allowed to build. Status here describes
            <em> availability of the integration</em>, never the health of any individual user&rsquo;s key.
          </p>
        </CardContent>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Providers" value={stats.total} hint="Implemented by the Android client" icon={Cpu} tone={stats.total === 0 ? "warning" : "neutral"} />
        <StatCard label="Available" value={stats.available} hint="Marked available for routing" icon={Cpu} tone="positive" />
        <StatCard label="Degraded" value={stats.degraded} hint="Known provider-side issues" icon={Cpu} tone={stats.degraded > 0 ? "warning" : "positive"} />
        <StatCard label="Awaiting keys" value={stats.unconfigured} hint="Needs a user-supplied key on device" icon={KeyRound} tone="muted" />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Cpu className="size-4 text-primary" aria-hidden />
            Catalogue
          </CardTitle>
          <CardDescription>
            Source: <span className="font-mono">{SOURCE_FILES.providerType}</span> for keys, base URLs
            and dialects; <span className="font-mono">{SOURCE_FILES.capabilityMap}</span> for search and
            reasoning support.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {providers.length === 0 ? (
            <EmptyState
              icon={Cpu}
              title="Provider rows have not been loaded into this environment"
              reason={`The catalogue itself is known and complete — ${PROVIDER_CATALOGUE.length} providers are transcribed from the ReplyMate source. What is missing is the local table rows, which are created by the bootstrap script or the re-sync action.`}
              nextStep={
                manageable
                  ? "Use “Re-sync catalogue” above. This writes reference rows only; it contacts no provider."
                  : "An operator or owner can re-sync the catalogue."
              }
              tone="waiting"
              action={
                manageable ? (
                  <AsyncAction
                    endpoint="/api/control"
                    payload={{ resource: "provider", operation: "resyncCatalogue", values: {} }}
                    icon={<RefreshCcw className="size-4" aria-hidden />}
                    label="Re-sync catalogue now"
                  />
                ) : undefined
              }
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Provider</TableHead>
                  <TableHead>Dialect</TableHead>
                  <TableHead>Default base URL</TableHead>
                  <TableHead>Search</TableHead>
                  <TableHead>Reasoning</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {providers.map((provider) => {
                  const catalogue = PROVIDER_CATALOGUE.find((p) => p.key === provider.key);
                  return (
                    <TableRow key={provider.id}>
                      <TableCell className="max-w-[360px]">
                        <p className="font-medium">{provider.displayName}</p>
                        <p className="font-mono text-[11px] text-muted-foreground">{provider.key}</p>
                        {catalogue ? (
                          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{catalogue.capabilityNote}</p>
                        ) : null}
                      </TableCell>
                      <TableCell className="font-mono text-[11px]">{provider.dialect}</TableCell>
                      <TableCell className="max-w-[220px] truncate font-mono text-[11px] text-muted-foreground" title={provider.defaultBaseUrl ?? undefined}>
                        {provider.defaultBaseUrl ?? "user-supplied"}
                      </TableCell>
                      <TableCell><StatusBadge value={provider.searchSupport} /></TableCell>
                      <TableCell><StatusBadge value={provider.reasoningSupport} /></TableCell>
                      <TableCell><StatusBadge value={provider.status} /></TableCell>
                      <TableCell>
                        <div className="flex flex-wrap items-center justify-end gap-2">
                          {(["available", "degraded", "disabled"] as const)
                            .filter((status) => status !== provider.status)
                            .map((status) => (
                              <AsyncAction
                                key={status}
                                endpoint="/api/control"
                                payload={{ resource: "provider", operation: "update", values: { id: provider.id, status } }}
                                label={`Mark ${status}`}
                                variant="ghost"
                                disabled={!manageable}
                                confirm={`Mark ${provider.key} as ${status}?`}
                              />
                            ))}
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

      <Card>
        <CardHeader>
          <CardTitle>Fallback retrieval backend</CardTitle>
          <CardDescription>
            Used only where a provider reports search support as <span className="font-mono">fallback</span>.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-xs leading-relaxed text-muted-foreground">
          <p>
            <span className="font-medium text-foreground">{FALLBACK_SEARCH.name}</span> — key-less,
            official, free. Endpoints:
          </p>
          <ul className="space-y-1 pl-4">
            {FALLBACK_SEARCH.endpoints.map((endpoint) => (
              <li key={endpoint} className="break-all font-mono text-[11px]">{endpoint}</li>
            ))}
          </ul>
          <p className="pt-1">{FALLBACK_SEARCH.honesty}</p>
          <p className="font-mono text-[11px]">
            transport: {FALLBACK_SEARCH.transport.perCallTimeoutMs}ms per call ·{" "}
            {FALLBACK_SEARCH.transport.hardTimeoutMs}ms hard · {FALLBACK_SEARCH.transport.totalBudgetMs}ms total
          </p>
        </CardContent>
      </Card>
    </>
  );
}
