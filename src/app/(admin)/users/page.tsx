import type { Metadata } from "next";
import { ShieldAlert, UserRoundCog, Users as UsersIcon } from "lucide-react";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { StatusBadge } from "@/components/shared/status-badge";
import { AsyncAction } from "@/components/shared/async-action";
import { InviteAdminForm } from "@/components/forms/forms";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requireCapability } from "@/lib/authz/guard";
import { describeRole } from "@/lib/authz/permissions";
import { formatRelative } from "@/lib/utils";
import { listAdmins, listInvites } from "@/lib/queries/admins";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Users" };

export default async function UsersPage() {
  const { admin } = await requireCapability("users:view");
  const canManage = admin.role === "owner";
  const [admins, invites] = await Promise.all([listAdmins(), listInvites()]);
  const pendingInvites = invites.filter((i) => !i.acceptedAt && !i.revokedAt && i.expiresAt > new Date());

  return (
    <>
      <PageHeader
        title="Users"
        description="Invitation-only administrator accounts. Roles are evaluated server-side on every request; the sidebar is filtered by the same matrix, so hiding a link grants nothing."
        actions={canManage ? <InviteAdminForm actorRole={admin.role} /> : undefined}
        meta={
          <>
            <Badge variant="outline" className="font-mono text-[11px]">{admins.length} accounts</Badge>
            <Badge variant="outline" className="font-mono text-[11px]">{pendingInvites.length} pending invites</Badge>
            {!canManage ? <Badge variant="warning" className="font-mono text-[11px]">read-only for {admin.role}</Badge> : null}
          </>
        }
      />

      {!canManage ? (
        <div className="flex items-start gap-3 rounded-lg border border-warning/30 bg-warning/5 px-4 py-3">
          <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
          <p className="text-xs leading-relaxed text-warning">
            Administrator lifecycle management (invite, suspend, re-role, reset MFA) is owner-only.
            You can read this page because you hold <span className="font-mono">users:view</span>, but
            every write will be rejected with 403 and written to the audit log.
          </p>
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <UsersIcon className="size-4 text-primary" aria-hidden />
            Administrators
          </CardTitle>
          <CardDescription>Role precedence: owner &gt; admin &gt; operator &gt; support &gt; viewer.</CardDescription>
        </CardHeader>
        <CardContent>
          {admins.length === 0 ? (
            <EmptyState
              icon={UsersIcon}
              title="No administrators have been provisioned"
              reason="Accounts are created only by redeeming an invitation, or by the server-side bootstrap script that creates the first owner. Nothing is pre-seeded."
              nextStep="Run `npx tsx scripts/bootstrap.ts` with BOOTSTRAP_OWNER_EMAIL and BOOTSTRAP_OWNER_PASSWORD set in the server environment."
              tone="waiting"
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Account</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>MFA</TableHead>
                  <TableHead>Last sign-in</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {admins.map((row) => {
                  const isSelf = row.id === admin.id;
                  return (
                    <TableRow key={row.id}>
                      <TableCell>
                        <p className="font-medium">{row.displayName ?? row.email}</p>
                        <p className="font-mono text-[11px] text-muted-foreground">
                          {row.email}
                          {isSelf ? " · you" : ""}
                        </p>
                        {row.supabaseUserId ? (
                          <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">supabase: {row.supabaseUserId.slice(0, 8)}…</p>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        <StatusBadge value={row.role} />
                        <p className="mt-1 max-w-[220px] text-[11px] leading-snug text-muted-foreground">{describeRole(row.role)}</p>
                      </TableCell>
                      <TableCell><StatusBadge value={row.status} /></TableCell>
                      <TableCell>
                        <StatusBadge value={row.mfaEnrolledAt ? "active" : "invited"} />
                        <p className="mt-1 text-[11px] text-muted-foreground">
                          {row.mfaEnrolledAt ? `enrolled ${formatRelative(row.mfaEnrolledAt)}` : row.mfaRequired ? "required, not enrolled" : "not enrolled"}
                        </p>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {row.lastLoginAt ? formatRelative(row.lastLoginAt) : "never"}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap items-center justify-end gap-2">
                          {row.status === "active" ? (
                            <AsyncAction
                              endpoint="/api/control"
                              payload={{ resource: "admin", operation: "update", values: { id: row.id, status: "suspended" } }}
                              label="Suspend"
                              variant="destructive"
                              disabled={!canManage || isSelf || row.role === "owner"}
                              disabledReason={isSelf ? "You cannot suspend your own account." : row.role === "owner" ? "Owner accounts are owner-managed." : undefined}
                              confirm={`Suspend ${row.email}? All their sessions are revoked immediately.`}
                            />
                          ) : (
                            <AsyncAction
                              endpoint="/api/control"
                              payload={{ resource: "admin", operation: "update", values: { id: row.id, status: "active" } }}
                              label="Reactivate"
                              disabled={!canManage || row.role === "owner"}
                              confirm={`Reactivate ${row.email}?`}
                            />
                          )}
                          <AsyncAction
                            endpoint="/api/control"
                            icon={<UserRoundCog className="size-4" aria-hidden />}
                            payload={{ resource: "admin", operation: "resetMfa", values: { id: row.id } }}
                            label="Reset MFA"
                            disabled={!canManage}
                            confirm={`Clear the TOTP factor for ${row.email} and revoke all their sessions? They must re-enrol before regaining access.`}
                          />
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
          <CardTitle>Invitations</CardTitle>
          <CardDescription>
            Single-use tokens. Only the SHA-256 digest is stored, so a link cannot be recovered from
            the database or re-issued by reading this table.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {invites.length === 0 ? (
            <EmptyState
              icon={UsersIcon}
              title="No invitations issued"
              reason="Invitations are created here by an owner. There is no self-service sign-up path and no directory sync."
              nextStep={canManage ? "Use “Invite administrator” above." : "Ask an owner to issue one."}
              tone="neutral"
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Email</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>MFA</TableHead>
                  <TableHead>Invited by</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {invites.map((invite) => {
                  const expired = invite.expiresAt <= new Date();
                  const state = invite.acceptedAt ? "accepted" : invite.revokedAt ? "revoked" : expired ? "expired" : "pending";
                  return (
                    <TableRow key={invite.id}>
                      <TableCell className="font-mono text-xs">{invite.email}</TableCell>
                      <TableCell><StatusBadge value={invite.role} /></TableCell>
                      <TableCell className="text-xs text-muted-foreground">{invite.mfaRequired ? "required" : "optional"}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{invite.inviterEmail ?? "bootstrap"}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{formatRelative(invite.expiresAt)}</TableCell>
                      <TableCell><StatusBadge value={state === "pending" ? "invited" : state === "accepted" ? "active" : state === "revoked" ? "suspended" : "unknown"} /></TableCell>
                      <TableCell className="text-right">
                        {state === "pending" ? (
                          <AsyncAction
                            endpoint="/api/control"
                            payload={{ resource: "invite", operation: "revoke", values: { id: invite.id } }}
                            label="Revoke"
                            variant="destructive"
                            disabled={!canManage}
                            confirm={`Revoke the invitation for ${invite.email}?`}
                          />
                        ) : (
                          <span className="text-[11px] text-muted-foreground">—</span>
                        )}
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
