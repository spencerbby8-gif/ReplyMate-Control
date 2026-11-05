"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { AlertTriangle, KeyRound, Loader2, RotateCw, ShieldCheck, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input, Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Vault controls.
 *
 * Two properties are enforced in the UI as well as the server, because a control
 * that lets an operator paste a key into the wrong provider is a spend incident:
 *
 *  1. The operator must type the provider key back into a confirmation field.
 *  2. The value field is `type="password"` with `autoComplete="off"`, is never
 *     held in state after submit, and is cleared on close.
 *
 * The value is sent once to `/api/control`, which forwards it to the Supabase
 * Management API and stores only a fingerprint. It cannot be read back from
 * anywhere, so these forms have no "show current value" affordance — there is no
 * current value to show.
 */

type Outcome = { ok: boolean; message: string };

function useVaultAction() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  async function submit(payload: Record<string, unknown>): Promise<boolean> {
    setPending(true);
    setOutcome(null);
    try {
      const response = await fetch("/api/control", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = (await response.json().catch(() => ({}))) as {
        data?: { summary?: string };
        error?: string;
        requestId?: string;
      };
      if (!response.ok) {
        setOutcome({
          ok: false,
          message: `${body.error ?? `Request failed (HTTP ${response.status})`}${body.requestId ? ` · ${body.requestId}` : ""}`,
        });
        return false;
      }
      setOutcome({ ok: true, message: body.data?.summary ?? "Done." });
      router.refresh();
      return true;
    } catch {
      setOutcome({ ok: false, message: "Network error — the request did not reach the server." });
      return false;
    } finally {
      setPending(false);
    }
  }

  return { submit, pending, outcome, clear: () => setOutcome(null) };
}

function OutcomeBanner({ outcome }: { outcome: Outcome | null }) {
  if (!outcome) return null;
  return (
    <p
      role={outcome.ok ? "status" : "alert"}
      className={`rounded-md border px-3 py-2 text-xs leading-relaxed ${
        outcome.ok
          ? "border-success/30 bg-success/5 text-success"
          : "border-destructive/30 bg-destructive/5 text-destructive"
      }`}
    >
      {outcome.message}
    </p>
  );
}

function ConfirmField({
  providerKey,
  value,
  onChange,
}: {
  providerKey: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const matches = value.trim().toLowerCase() === providerKey.toLowerCase();
  return (
    <div className="space-y-1.5">
      <Label htmlFor={`confirm-${providerKey}`}>
        Type <span className="font-mono text-foreground">{providerKey}</span> to confirm
      </Label>
      <Input
        id={`confirm-${providerKey}`}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoComplete="off"
        className="font-mono"
        aria-invalid={value.length > 0 && !matches}
      />
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        Not a modal you can click through. The server rejects a mismatch, which is
        what catches pasting a key while the wrong provider is selected.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Set / replace a key
// ---------------------------------------------------------------------------

export function SetKeyDialog({
  providerKey,
  slot,
  secretName,
  disabled,
  disabledReason,
}: {
  providerKey: string;
  slot: "primary" | "next";
  secretName: string;
  disabled?: boolean;
  disabledReason?: string;
}) {
  const { submit, pending, outcome, clear } = useVaultAction();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [confirm, setConfirm] = useState("");
  const [note, setNote] = useState("");

  const confirmed = confirm.trim().toLowerCase() === providerKey.toLowerCase();
  const valid = value.trim().length >= 8 && !/\s/.test(value.trim()) && confirmed;

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    const ok = await submit({
      resource: "vault",
      operation: "setKey",
      values: { providerKey, slot, value, note: note || null, confirmProvider: confirm },
    });
    // The value leaves scope here regardless of outcome.
    setValue("");
    setConfirm("");
    setNote("");
    if (ok) setOpen(false);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setValue("");
          setConfirm("");
          setNote("");
          clear();
        }
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" disabled={disabled} title={disabledReason}>
          <KeyRound className="size-4" aria-hidden />
          {slot === "next" ? "Set next slot" : "Set key"}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Write <span className="font-mono">{secretName}</span>
          </DialogTitle>
          <DialogDescription>
            Stored in Supabase Edge Function Secrets on the production project.
            This platform keeps a fingerprint and a character count — there is no
            column in which the value could be stored, so it cannot be read back
            by anyone, including you.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor={`value-${providerKey}-${slot}`}>Provider API key</Label>
            <Input
              id={`value-${providerKey}-${slot}`}
              type="password"
              autoComplete="off"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder="paste the key"
              required
              minLength={8}
              maxLength={512}
            />
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {value.length > 0
                ? `${value.length} characters${/\s/.test(value) ? " · contains whitespace, which will be rejected" : ""}`
                : "Never echoed back, never logged, never written to the audit record."}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={`note-${providerKey}-${slot}`}>Note (optional)</Label>
            <Textarea
              id={`note-${providerKey}-${slot}`}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              rows={2}
              maxLength={300}
              placeholder="e.g. rotated after quota reset"
            />
          </div>

          <ConfirmField providerKey={providerKey} value={confirm} onChange={setConfirm} />

          <OutcomeBanner outcome={outcome} />

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending || !valid}>
              {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <ShieldCheck className="size-4" aria-hidden />}
              Write to Supabase secrets
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Rotation
// ---------------------------------------------------------------------------

export function RotateDialog({
  providerKey,
  phase,
  disabled,
  disabledReason,
}: {
  providerKey: string;
  phase: "stage" | "promote";
  disabled?: boolean;
  disabledReason?: string;
}) {
  const { submit, pending, outcome, clear } = useVaultAction();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [confirm, setConfirm] = useState("");

  const confirmed = confirm.trim().toLowerCase() === providerKey.toLowerCase();
  const valid = value.trim().length >= 8 && !/\s/.test(value.trim()) && confirmed;
  const operation = phase === "stage" ? "stageRotation" : "promoteRotation";

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    const ok = await submit({
      resource: "vault",
      operation,
      values: { providerKey, value, confirmProvider: confirm },
    });
    setValue("");
    setConfirm("");
    if (ok) setOpen(false);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setValue("");
          setConfirm("");
          clear();
        }
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant={phase === "stage" ? "default" : "outline"} disabled={disabled} title={disabledReason}>
          <RotateCw className="size-4" aria-hidden />
          {phase === "stage" ? "Rotate" : "Promote"}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {phase === "stage" ? `Stage a new ${providerKey} key` : `Promote the ${providerKey} rotation`}
          </DialogTitle>
          <DialogDescription>
            {phase === "stage"
              ? "Writes the new key to the _NEXT slot and marks the provider rotating. The gateway then prefers the new key and falls back to the current one if the new key fails auth — zero downtime, no flag day."
              : "Writes the key to the primary slot, deletes _NEXT and clears the rotating flag. You must re-enter the SAME key that was staged: Supabase secrets are write-only and this platform stores nothing, so the server verifies it by fingerprint rather than by reading it back."}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor={`rotate-${providerKey}-${phase}`}>
              {phase === "stage" ? "New provider API key" : "The staged key, re-entered"}
            </Label>
            <Input
              id={`rotate-${providerKey}-${phase}`}
              type="password"
              autoComplete="off"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              required
              minLength={8}
              maxLength={512}
            />
            {phase === "promote" ? (
              <p className="text-[11px] leading-relaxed text-warning">
                Re-entry is a control, not an inconvenience: it proves you still
                possess the key being promoted.
              </p>
            ) : null}
          </div>

          <ConfirmField providerKey={providerKey} value={confirm} onChange={setConfirm} />
          <OutcomeBanner outcome={outcome} />

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending || !valid}>
              {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <RotateCw className="size-4" aria-hidden />}
              {phase === "stage" ? "Stage rotation" : "Promote to primary"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Disable (destructive)
// ---------------------------------------------------------------------------

export function DisableKeyDialog({
  providerKey,
  slot,
  secretName,
  disabled,
}: {
  providerKey: string;
  slot: "primary" | "next";
  secretName: string;
  disabled?: boolean;
}) {
  const { submit, pending, outcome, clear } = useVaultAction();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState("");
  const confirmed = confirm.trim().toLowerCase() === providerKey.toLowerCase();

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    const ok = await submit({
      resource: "vault",
      operation: "disableKey",
      values: { providerKey, slot, confirmProvider: confirm },
    });
    setConfirm("");
    if (ok) setOpen(false);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setConfirm("");
          clear();
        }
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="destructive" disabled={disabled}>
          <Trash2 className="size-4" aria-hidden />
          Delete
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="size-4 text-destructive" aria-hidden />
            Delete <span className="font-mono">{secretName}</span>
          </DialogTitle>
          <DialogDescription>
            Removes the secret from the production project. The gateway will stop
            resolving {providerKey} from the {slot} slot immediately. Because the
            value is not stored anywhere, <strong>it cannot be recovered</strong> —
            you must re-enter it to restore service.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="space-y-4">
          <ConfirmField providerKey={providerKey} value={confirm} onChange={setConfirm} />
          <OutcomeBanner outcome={outcome} />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="destructive" disabled={pending || !confirmed}>
              {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Trash2 className="size-4" aria-hidden />}
              Permanently delete secret
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
