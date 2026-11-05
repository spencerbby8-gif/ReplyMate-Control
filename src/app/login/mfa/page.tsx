import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft, KeyRound } from "lucide-react";
import { MfaChallengeForm } from "@/components/auth/mfa-challenge-form";
import { getSession } from "@/lib/auth/session";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Two-factor verification" };

export default async function MfaPage() {
  const session = await getSession({ requireMfa: false });
  if (!session) redirect("/login?reason=expired");
  if (session.session.mfaVerified) redirect("/dashboard");

  if (!session.admin.mfaSecretEnc) {
    // Enrolled flag set but no secret stored: refuse rather than fall back to
    // password-only. The admin must re-enrol from /security.
    return (
      <main className="grid min-h-dvh place-items-center px-6">
        <div className="w-full max-w-md space-y-5 rounded-xl border bg-card p-8 shadow-sm">
          <span className="grid size-10 place-items-center rounded-lg bg-warning/10 text-warning">
            <KeyRound className="size-5" aria-hidden />
          </span>
          <div className="space-y-1.5">
            <h1 className="text-lg font-semibold">MFA factor unavailable</h1>
            <p className="text-sm leading-relaxed text-muted-foreground">
              This account is required to present a second factor, but no TOTP secret is stored for
              it. Sign-in will not be silently downgraded to password-only.
            </p>
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            An owner must reset the factor from <span className="font-medium">Users</span>, after
            which you can re-enrol from <span className="font-medium">Security</span>.
          </p>
          <Link
            href="/login"
            className="inline-flex items-center gap-2 text-sm font-medium text-primary underline-offset-4 hover:underline"
          >
            <ArrowLeft className="size-4" aria-hidden />
            Back to sign in
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="grid min-h-dvh place-items-center px-6 py-12">
      <div className="w-full max-w-md space-y-6 rounded-xl border bg-card p-8 shadow-sm">
        <div className="space-y-1.5">
          <span className="grid size-10 place-items-center rounded-lg bg-primary/10 text-primary">
            <KeyRound className="size-5" aria-hidden />
          </span>
          <h1 className="pt-2 text-lg font-semibold tracking-tight">Two-factor verification</h1>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Enter the 6-digit code from your authenticator app for{" "}
            <span className="font-medium text-foreground">{session.admin.email}</span>.
          </p>
        </div>

        <MfaChallengeForm />

        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Codes rotate every 30 seconds and each code can be used once. A ±1 step window absorbs
          clock skew; replays are rejected and audited.
        </p>
      </div>
    </main>
  );
}
