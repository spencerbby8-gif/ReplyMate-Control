import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AlertTriangle, Lock, ServerOff, ShieldCheck } from "lucide-react";
import { LoginForm } from "@/components/auth/login-form";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { envReport } from "@/config/env";
import { identityStatus } from "@/lib/auth/identity";
import { digestKeyStrength } from "@/lib/auth/crypto";
import { LOGIN_THROTTLE } from "@/lib/auth/rate-limit";
import { getSession } from "@/lib/auth/session";
import { countAdmins } from "@/lib/queries/admins";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string; invited?: string; expired?: string }>;
}) {
  const session = await getSession();
  if (session) redirect("/dashboard");

  const params = await searchParams;
  const report = envReport();
  const identity = identityStatus();
  const digestStrength = digestKeyStrength();
  const bootstrap = await countAdmins();

  return (
    <main className="grid min-h-dvh lg:grid-cols-[1.05fr_1fr]">
      {/* Narrative panel */}
      <section className="relative hidden flex-col justify-between overflow-hidden border-r bg-sidebar p-10 lg:flex">
        <div className="grid-noise pointer-events-none absolute inset-0 opacity-[0.35]" aria-hidden />
        <div className="relative">
          <div className="flex items-center gap-3">
            <span className="grid size-9 place-items-center rounded-lg bg-primary/15 text-primary">
              <ShieldCheck className="size-5" aria-hidden />
            </span>
            <div>
              <p className="text-sm font-semibold leading-tight">ReplyMate Control</p>
              <p className="text-xs text-muted-foreground">Separate administrative platform</p>
            </div>
          </div>
        </div>

        <div className="relative max-w-md space-y-6">
          <h1 className="text-3xl font-semibold leading-tight tracking-tight text-balance">
            Administration that respects the local-first contract.
          </h1>
          <ul className="space-y-3 text-sm leading-relaxed text-muted-foreground">
            <li className="flex gap-3">
              <Lock className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
              <span>
                Invitation only. There is no self-service sign-up — an owner issues a single-use,
                expiring invite.
              </span>
            </li>
            <li className="flex gap-3">
              <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
              <span>
                Roles are enforced server-side on every request. Hiding a link in the UI grants
                nothing.
              </span>
            </li>
            <li className="flex gap-3">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
              <span>
                This platform cannot read ReplyMate messages, memory facts or drafts, and cannot
                enable sync. That boundary is code, not policy.
              </span>
            </li>
          </ul>
        </div>

        <p className="relative font-mono text-[11px] text-muted-foreground/70">
          sync_enabled=false · provider_keys=on-device-keystore · audit=append-only
        </p>
      </section>

      {/* Form panel */}
      <section className="flex items-center justify-center px-5 py-12 sm:px-10">
        <div className="w-full max-w-sm space-y-6">
          <div className="space-y-2 lg:hidden">
            <p className="text-sm font-semibold">ReplyMate Control</p>
            <p className="text-xs text-muted-foreground">Separate administrative platform</p>
          </div>

          <div className="space-y-1.5">
            <h2 className="text-xl font-semibold tracking-tight">Sign in</h2>
            <p className="text-sm text-muted-foreground">
              Use the credentials from your invitation.
            </p>
          </div>

          {params.reason === "invalid" ? (
            <Alert variant="destructive">
              <AlertTitle>Sign-in failed</AlertTitle>
              <AlertDescription>
                <p>The email or password was not recognised, or the session needs MFA.</p>
              </AlertDescription>
            </Alert>
          ) : null}

          {params.reason === "locked" ? (
            <Alert variant="destructive">
              <AlertTitle>Account temporarily locked</AlertTitle>
              <AlertDescription>
                <p>Too many failed attempts. The lock clears automatically after 15 minutes.</p>
              </AlertDescription>
            </Alert>
          ) : null}

          {params.reason === "expired" || params.expired ? (
            <Alert variant="warning">
              <AlertTitle>Session expired</AlertTitle>
              <AlertDescription>
                <p>Sign in again to continue.</p>
              </AlertDescription>
            </Alert>
          ) : null}

          {params.invited ? (
            <Alert variant="success">
              <AlertTitle>Account activated</AlertTitle>
              <AlertDescription>
                <p>Sign in with the password you just set.</p>
              </AlertDescription>
            </Alert>
          ) : null}

          <LoginForm />

          <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
            <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Access status
            </p>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {bootstrap.count === 0 ? (
                <>
                  <span className="font-medium text-foreground">No administrator exists yet.</span>{" "}
                  Run the bootstrap script on the server to create the first owner — it reads
                  BOOTSTRAP_OWNER_EMAIL / BOOTSTRAP_OWNER_PASSWORD from the environment and never
                  accepts credentials over HTTP.
                </>
              ) : (
                <>
                  {bootstrap.count} administrator{bootstrap.count === 1 ? "" : "s"} provisioned.
                  Invitations are issued from <span className="font-medium text-foreground">Users</span>{" "}
                  by an owner.
                </>
              )}
            </p>
            <p className="font-mono text-[11px] text-muted-foreground/80">
              auth_provider={identity.provider} · passwords={identity.passwordStore} · mfa=
              {identity.mfaVerifier}
            </p>
            <p className="text-[11px] leading-relaxed text-muted-foreground/80">{identity.detail}</p>
            <p className="font-mono text-[11px] text-muted-foreground/80">
              supabase_bridge={report.supabase.configured ? "live" : "closed"} · token_digest=
              {digestStrength} · csrf=origin-checked
            </p>
            <p className="text-[11px] leading-relaxed text-muted-foreground/80">
              Throttling: 5 failures locks an account for 15 minutes, and a source that fails against{" "}
              {LOGIN_THROTTLE.maxDistinctTargets} distinct accounts within{" "}
              {LOGIN_THROTTLE.windowMinutes} minutes is refused for {LOGIN_THROTTLE.cooldownMinutes}{" "}
              minutes — which is what stops password guessing from becoming account enumeration.
            </p>
            {!identity.configured ? (
              <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-warning">
                <ServerOff className="mt-0.5 size-3 shrink-0" aria-hidden />
                The configured identity provider is not usable, so sign-in fails closed rather than
                falling back to local password hashes.
              </p>
            ) : null}
          </div>

          <p className="text-center text-xs text-muted-foreground">
            Need access?{" "}
            <Link href="/privacy" className="font-medium text-primary underline-offset-4 hover:underline">
              Read the privacy contract
            </Link>
          </p>
        </div>
      </section>
    </main>
  );
}
