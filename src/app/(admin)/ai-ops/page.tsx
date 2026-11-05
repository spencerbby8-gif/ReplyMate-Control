import type { Metadata } from "next";
import { Sparkles, Wrench } from "lucide-react";
import { PageHeader } from "@/components/shared/page-header";
import { AiOpsConsole } from "@/components/forms/interactive";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requireCapability } from "@/lib/authz/guard";
import { envReport } from "@/config/env";
import { RUNBOOKS } from "@/lib/aiops/engine";
import { listAiopsSessions } from "@/lib/queries/ops";
import { formatRelative } from "@/lib/utils";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "AI operations" };

export default async function AiOpsPage() {
  const { admin } = await requireCapability("aiops:use");
  const report = envReport();
  const sessions = await listAiopsSessions(admin.id);

  return (
    <>
      <PageHeader
        title="AI operations assistant"
        description="An assistant with read-only tools over this control plane. It reports what its tools actually returned and refuses to guess; when nothing matches a runbook it says so and lists what it can execute."
        meta={
          <>
            <Badge variant={report.aiOps.llmActive ? "success" : "muted"} className="font-mono text-[11px]">
              mode: {report.aiOps.llmActive ? `llm:${report.aiOps.provider}` : "deterministic"}
            </Badge>
            <Badge variant="outline" className="font-mono text-[11px]">{RUNBOOKS.length} runbooks</Badge>
            <Badge variant="outline" className="font-mono text-[11px]">read-only tools</Badge>
          </>
        }
      />

      <AiOpsConsole llmActive={report.aiOps.llmActive} provider={report.aiOps.provider} />

      <div className="grid gap-4 lg:grid-cols-[1fr_1.2fr]">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Wrench className="size-4 text-primary" aria-hidden />
              Tool registry
            </CardTitle>
            <CardDescription>
              Each tool is a real query against this control plane. Selection is intent-based in
              deterministic mode; in LLM mode the same registry is offered to the model and tool calls
              are executed here — the model never reaches the database directly.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Tool</TableHead>
                  <TableHead>What it reads</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {RUNBOOKS.map((runbook) => (
                  <TableRow key={runbook.name}>
                    <TableCell className="whitespace-nowrap font-mono text-[11px]">{runbook.name}</TableCell>
                    <TableCell className="text-[11px] leading-relaxed text-muted-foreground">{runbook.description}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Sparkles className="size-4 text-primary" aria-hidden />
                Your sessions
              </CardTitle>
              <CardDescription>Persisted per administrator, including every tool call and its result.</CardDescription>
            </CardHeader>
            <CardContent>
              {sessions.length === 0 ? (
                <p className="rounded-lg border border-dashed px-4 py-8 text-center text-xs leading-relaxed text-muted-foreground">
                  No sessions yet. Ask the assistant a question above — a session is created on the
                  first run and every subsequent turn is appended to it, along with the tool calls it
                  made and the exact data they returned.
                </p>
              ) : (
                <ul className="divide-y">
                  {sessions.map((session) => (
                    <li key={session.id} className="flex items-center gap-3 py-2.5">
                      <span className="min-w-0 flex-1 truncate text-xs">{session.title}</span>
                      <Badge variant="outline" className="shrink-0 font-mono text-[10px]">{session.mode}</Badge>
                      <span className="shrink-0 text-[11px] text-muted-foreground">{formatRelative(session.updatedAt)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card className="border-primary/25 bg-primary/[0.03]">
            <CardHeader>
              <CardTitle>Honesty guarantees</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-xs leading-relaxed text-muted-foreground">
              <p>
                <span className="font-medium text-foreground">No invented numbers.</span> Every figure
                in an answer comes from a tool that queried the database or ran a live probe in this
                request.
              </p>
              <p>
                <span className="font-medium text-foreground">No simulated integrations.</span> When
                the Supabase bridge is closed, the assistant reports that it is closed and why — it
                does not return zeros formatted to look like telemetry.
              </p>
              <p>
                <span className="font-medium text-foreground">No privacy erosion.</span> The tool
                registry has no read path to message content, memory facts or drafts, so no prompt can
                reach them.
              </p>
              <p>
                <span className="font-medium text-foreground">Explicit degradation.</span> If an LLM
                provider is configured but unreachable, the raw tool output is shown with the failure
                stated, rather than a plausible-sounding paraphrase.
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
