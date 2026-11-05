"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Check, Loader2, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

function scorePassword(value: string) {
  let score = 0;
  if (value.length >= 12) score += 1;
  if (value.length >= 16) score += 1;
  if (/[a-z]/.test(value) && /[A-Z]/.test(value)) score += 1;
  if (/\d/.test(value)) score += 1;
  if (/[^\w\s]/.test(value)) score += 1;
  return Math.min(score, 5);
}

const REQUIREMENTS = [
  { label: "At least 12 characters", test: (v: string) => v.length >= 12 },
  { label: "Mixed case letters", test: (v: string) => /[a-z]/.test(v) && /[A-Z]/.test(v) },
  { label: "At least one number", test: (v: string) => /\d/.test(v) },
];

export function AcceptInviteForm({
  token,
  email,
  mfaRequired,
}: {
  token: string;
  email: string;
  mfaRequired: boolean;
}) {
  const router = useRouter();
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const requirementsMet = REQUIREMENTS.every((r) => r.test(password));
  const matches = password.length > 0 && password === confirm;
  const strength = scorePassword(password);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!requirementsMet || !matches) return;
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/invite/accept", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, displayName: displayName.trim() || null, password }),
      });
      const payload = await response.json();
      if (!response.ok) {
        setError(payload?.error ?? "Could not activate the account.");
        setPending(false);
        return;
      }
      router.replace("/login?invited=1");
      router.refresh();
    } catch {
      setError("Network error. The activation request did not reach the server.");
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="displayName">Display name <span className="font-normal text-muted-foreground">(optional)</span></Label>
        <Input
          id="displayName"
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          placeholder="How colleagues should see you"
          maxLength={80}
          disabled={pending}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="invite-email">Email</Label>
        <Input id="invite-email" value={email} readOnly disabled className="opacity-70" />
        <p className="text-[11px] text-muted-foreground">
          The invitation is bound to this address and cannot be reassigned.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="new-password">Password</Label>
        <Input
          id="new-password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
          minLength={12}
          disabled={pending}
        />
        <div className="flex gap-1" aria-hidden>
          {[0, 1, 2, 3, 4].map((i) => (
            <span
              key={i}
              className={`h-1 flex-1 rounded-full transition-colors ${
                i < strength
                  ? strength <= 2
                    ? "bg-destructive"
                    : strength === 3
                      ? "bg-warning"
                      : "bg-success"
                  : "bg-muted"
              }`}
            />
          ))}
        </div>
        <ul className="space-y-1 pt-1">
          {REQUIREMENTS.map((requirement) => {
            const met = requirement.test(password);
            return (
              <li key={requirement.label} className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <Check className={`size-3 ${met ? "text-success" : "opacity-30"}`} aria-hidden />
                <span className={met ? "text-foreground/80" : undefined}>{requirement.label}</span>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="space-y-2">
        <Label htmlFor="confirm-password">Confirm password</Label>
        <Input
          id="confirm-password"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
          required
          disabled={pending}
          aria-invalid={confirm.length > 0 && !matches}
        />
        {confirm.length > 0 && !matches ? (
          <p className="text-[11px] text-destructive">Passwords do not match.</p>
        ) : null}
      </div>

      {mfaRequired ? (
        <p className="rounded-md border border-info/30 bg-info/5 px-3 py-2 text-[11px] leading-relaxed text-info">
          Two-factor enrolment is required for this invitation. You will be prompted to scan a TOTP
          QR code immediately after your first sign-in.
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs leading-relaxed text-destructive">
          {error}
        </p>
      ) : null}

      <Button type="submit" className="w-full" disabled={pending || !requirementsMet || !matches}>
        {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <UserPlus className="size-4" aria-hidden />}
        {pending ? "Activating…" : "Activate account"}
      </Button>
    </form>
  );
}
