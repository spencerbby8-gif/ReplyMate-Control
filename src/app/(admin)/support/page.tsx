import type { Metadata } from "next";
import { LifeBuoy, Inbox } from "lucide-react";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { StatCard } from "@/components/shared/stat-card";
import { StatusBadge } from "@/components/shared/status-badge";
import { AsyncAction } from "@/components/shared/async-action";
import { TicketDialog } from "@/components/forms/forms";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requireCapability } from "@/lib/authz/guard";
import { can } from "@/lib/authz/permissions";
import { formatDateTime, formatRelative } from "@/lib/utils";
import { listTickets, ticketStats } from "@/lib/queries/ops";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Support" };

const NEXT_STATUS: Record<string, Array<{ status: string; label: string }>> = {
  open: [{ status: "triaged", label: "Triage" }, { status: "resolved", label: "Resolve" }],
  triaged: [{ status: "waiting", label: "Mark waiting" }, { status: "resolved", label: "Resolve" }],
  waiting: [{ status: "triaged", label: "Resume triage" }, { status: "resolved", label: "Resolve" }],
  resolved: [{ status: "closed", label: "Close" }, { status: "open", label: "Reopen" }],
  closed: [{ status: "open", label: "Reopen" }],
};

export default async function SupportPage() {
  const { admin } = await requireCapability("support:view");
  const manageable = can(admin.role, "support:manage");
  const [tickets, stats] = await Promise.all([listTickets(), ticketStats()]);

  return (
    <>
      <PageHeader
        title="Support"
        description="Inbound requests and triage. There is no connected intake channel — no email forwarding, no in-app feedback transport and no widget — so tickets exist only when an operator records one here."
        actions={manageable ? <TicketDialog /> : undefined}
        meta={
          <>
            <Badge variant="outline" className="font-mono text-[11px]">{stats.total} tickets</Badge>
            <Badge variant={stats.open > 0 ? "warning" : "success"} className="font-mono text-[11px]">{stats.open} open</Badge>
            <Badge variant="muted" className="font-mono text-[11px]">manual intake only</Badge>
          </>
        }
      />

      <Alert>
        <Inbox aria-hidden />
        <AlertTitle>Handling rules</AlertTitle>
        <AlertDescription>
          <p>
            Never paste a user&rsquo;s message content, contact names, memory facts, prompt snapshots
            or provider keys into a ticket. ReplyMate&rsquo;s own Diagnostics blocks (provider,
            endpoint, model, status, provider-said, ReplyMate-read, suggested fix) are safe to copy —
            they are designed to be shared and contain no message text.
          </p>
        </AlertDescription>
      </Alert>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Tickets" value={stats.total} hint="Recorded manually" icon={LifeBuoy} tone={stats.total === 0 ? "muted" : "neutral"} />
        <StatCard label="Open" value={stats.open} hint="open + triaged + waiting" icon={LifeBuoy} tone={stats.open > 0 ? "warning" : "positive"} />
        <StatCard label="Resolved" value={stats.resolved} hint="resolved + closed" icon={LifeBuoy} tone="positive" />
        <StatCard label="Intake channels" value={0} hint="None connected" icon={Inbox} tone="muted" />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <LifeBuoy className="size-4 text-primary" aria-hidden />
            Queue
          </CardTitle>
          <CardDescription>Assignment happens automatically when a ticket leaves the open state.</CardDescription>
        </CardHeader>
        <CardContent>
          {tickets.length === 0 ? (
            <EmptyState
              icon={LifeBuoy}
              title="The support queue is empty"
              reason="No ticket has been recorded. This is a real empty queue rather than a failed fetch — there is no inbound transport that could have delivered one."
              nextStep={manageable ? "Use “Log a ticket” to record a report from a user." : "An operator, support agent or owner can log a ticket."}
              tone="neutral"
              action={manageable ? <TicketDialog /> : undefined}
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Reference</TableHead>
                  <TableHead>Subject</TableHead>
                  <TableHead>Requester</TableHead>
                  <TableHead>App version</TableHead>
                  <TableHead>Priority</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Updated</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tickets.map((ticket) => (
                  <TableRow key={ticket.id}>
                    <TableCell className="font-mono text-[11px]">{ticket.reference}</TableCell>
                    <TableCell className="max-w-[360px]">
                      <p className="text-xs font-medium">{ticket.subject}</p>
                      {ticket.body ? (
                        <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">{ticket.body}</p>
                      ) : null}
                    </TableCell>
                    <TableCell className="font-mono text-[11px] text-muted-foreground">{ticket.requesterEmail ?? "—"}</TableCell>
                    <TableCell className="font-mono text-[11px]">{ticket.appVersion ?? "—"}</TableCell>
                    <TableCell><StatusBadge value={ticket.priority} /></TableCell>
                    <TableCell><StatusBadge value={ticket.status} /></TableCell>
                    <TableCell className="whitespace-nowrap text-[11px] text-muted-foreground" title={formatDateTime(ticket.updatedAt)}>
                      {formatRelative(ticket.updatedAt)}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap items-center justify-end gap-2">
                        {(NEXT_STATUS[ticket.status] ?? []).map((transition) => (
                          <AsyncAction
                            key={transition.status}
                            endpoint="/api/control"
                            payload={{ resource: "ticket", operation: "update", values: { id: ticket.id, status: transition.status } }}
                            label={transition.label}
                            variant="ghost"
                            disabled={!manageable}
                            confirm={`${transition.label} ${ticket.reference}?`}
                          />
                        ))}
                      </div>
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
