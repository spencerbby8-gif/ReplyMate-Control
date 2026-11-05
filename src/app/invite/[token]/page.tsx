import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { MailWarning, ShieldCheck } from "lucide-react";
import { AcceptInviteForm } from "@/components/auth/accept-invite-form";
import { Button } from "@/components/ui/button";
import { getSession } from "@/lib/auth/session";
import { digestToken } from "@/lib/auth/crypto";
import { findPendingInviteByHash } from "@/lib/queries/admins";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Accept invitation" };

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const session = await getSession();
  if (session) redirect("/dashboard");

  const { token } = await params;
  const invite = token ? await findPendingInviteByHash(digestToken(token)) : null;

  if (!invite) {
    return (
      <main className="grid min-h-dvh place-items-center px-6 py-12">
        <div className="w-full max-w-md space-y-5 rounded-xl border bg-card p-8 text-center shadow-sm">
          <span className="mx-auto grid size-10 place-items-center rounded-lg bg-destructive/10 text-destructive">
            <MailWarning className="size-5" aria-hidden />
          </span>
          <div className="space-y-1.5">
            <h1 className="text-lg font-semibold">This invitation is not valid</h1>
            <p className="text-sm leading-relaxed text-muted-foreground">
              Invitations are single-use and expire. This link has already been accepted, was
              revoked by an owner, or has passed its expiry time.
            </p>
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Ask an owner to issue a new invitation from <span className="font-medium">Users</span>.
            There is no self-service sign-up.
          </p>
          <Button asChild variant="outline">
            <Link href="/login">Back to sign in</Link>
          </Button>
        </div>
      </main>
    );
  }

  return (
    <main className="grid min-h-dvh place-items-center px-6 py-12">
      <div className="w-full max-w-md space-y-6 rounded-xl border bg-card p-8 shadow-sm">
        <span className="grid size-10 place-items-center rounded-lg bg-primary/10 text-primary">
          <ShieldCheck className="size-5" aria-hidden />
        </span>
        <div className="space-y-1.5">
          <h1 className="text-lg font-semibold tracking-tight">Accept your invitation</h1>
          <p className="text-sm leading-relaxed text-muted-foreground">
            You have been invited to ReplyMate Control as{" "}
            <span className="font-medium text-foreground">{invite.email}</span> with the{" "}
            <span className="font-medium text-foreground">{invite.role}</span> role.
          </p>
        </div>

        <AcceptInviteForm token={token} email={invite.email} mfaRequired={invite.mfaRequired} />

        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Your password is hashed with scrypt before storage and is never sent to ReplyMate,
          Supabase or any third party. This invitation expires at{" "}
          <span className="font-mono">{invite.expiresAt.toISOString()}</span>.
        </p>
      </div>
    </main>
  );
}
