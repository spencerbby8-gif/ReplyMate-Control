"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { AlertTriangle, Flag, GitBranch, LifeBuoy, Loader2, Plus, SlidersHorizontal, UserPlus } from "lucide-react";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { PROVIDER_CATALOGUE, TASK_CATALOGUE, OUTPUT_CAP_RULE, effectiveOutputCap } from "@/config/catalog";

/**
 * Mutation forms. Every one of these posts to `/api/control`, which authorizes
 * server-side, executes and audits. Nothing here writes optimistically: the UI
 * refreshes from the database after a successful response.
 */

function useControlAction() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(payload: Record<string, unknown>): Promise<boolean> {
    return (await submitForResult(payload)).ok;
  }

  async function submitForResult(payload: Record<string, unknown>): Promise<{ ok: boolean; data: Record<string, unknown> }> {
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/control", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string; requestId?: string };
      if (!response.ok) {
        setError(`${body.error ?? `Request failed (HTTP ${response.status})`}${body.requestId ? ` · ${body.requestId}` : ""}`);
        return { ok: false, data: {} };
      }
      router.refresh();
      return { ok: true, data: (body as Record<string, unknown>) ?? {} };
    } catch {
      setError("Network error — the request did not reach the server.");
      return { ok: false, data: {} };
    } finally {
      setPending(false);
    }
  }

  const errorNode = error ? (
    <p role="alert" className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs leading-relaxed text-destructive">
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      {error}
    </p>
  ) : null;

  return { submit, submitForResult, pending, error, errorNode, reset: () => setError(null) };
}

function FormRow({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
      {hint ? <p className="text-[11px] leading-relaxed text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

// --------------------------------------------------------------------------
// Invitations
// --------------------------------------------------------------------------

const ROLES = ["owner", "admin", "operator", "support", "viewer"] as const;

export function InviteAdminForm({ actorRole }: { actorRole: string }) {
  const { submitForResult, pending, errorNode, reset } = useControlAction();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<(typeof ROLES)[number]>("viewer");
  const [mfaRequired, setMfaRequired] = useState(true);
  const [expiresInHours, setExpiresInHours] = useState(72);
  const [link, setLink] = useState<string | null>(null);

  const ownerOnly = role === "owner" && actorRole !== "owner";

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    const result = await submitForResult({
      resource: "invite",
      operation: "create",
      values: { email, role, mfaRequired, expiresInHours },
    });
    if (result.ok) {
      // The link is returned exactly once — only its SHA-256 digest is stored,
      // so it can never be recovered from the database afterwards.
      const inviteUrl = typeof result.data.inviteUrl === "string" ? result.data.inviteUrl : null;
      setLink(inviteUrl ? `${window.location.origin}${inviteUrl}` : null);
      setEmail("");
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          reset();
          setLink(null);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm">
          <UserPlus className="size-4" aria-hidden />
          Invite administrator
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invite an administrator</DialogTitle>
          <DialogDescription>
            Creates a single-use, expiring invitation. There is no self-service sign-up: an account
            only exists once this link is redeemed.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="space-y-4">
          <FormRow label="Email address" hint="Bound to the invitation; it cannot be reassigned later.">
            <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="colleague@company.com" autoComplete="off" />
          </FormRow>

          <FormRow label="Role" hint={ownerOnly ? "Only an owner may invite another owner." : "Checked server-side on every subsequent request."}>
            <Select value={role} onValueChange={(value) => setRole(value as (typeof ROLES)[number])}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ROLES.map((value) => (
                  <SelectItem key={value} value={value} disabled={value === "owner" && actorRole !== "owner"}>
                    {value}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormRow>

          <FormRow label="Invitation lifetime (hours)">
            <Input type="number" min={1} max={168} value={expiresInHours} onChange={(e) => setExpiresInHours(Number(e.target.value))} />
          </FormRow>

          <div className="flex items-center justify-between gap-4 rounded-md border p-3">
            <div className="min-w-0">
              <Label htmlFor="mfa-required" className="text-sm">Require TOTP MFA</Label>
              <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                The account cannot reach a privileged page until a factor is enrolled.
              </p>
            </div>
            <Switch id="mfa-required" checked={mfaRequired} onCheckedChange={setMfaRequired} />
          </div>

          {errorNode}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={pending || ownerOnly || !email}>
              {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Plus className="size-4" aria-hidden />}
              Create invitation
            </Button>
          </DialogFooter>
        </form>

        {link ? (
          <p className="break-all rounded-md border bg-muted/40 p-2 font-mono text-[11px]">{link}</p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

// --------------------------------------------------------------------------
// Feature flags
// --------------------------------------------------------------------------

const FLAG_STATUSES = ["off", "shadow", "canary", "on"] as const;

export type FlagRow = {
  id: string;
  key: string;
  name: string;
  description: string | null;
  status: string;
  rolloutPercent: number;
  clientWired: boolean;
  minAppVersion: string | null;
};

export function FlagDialog({ flag, canManage }: { flag?: FlagRow; canManage: boolean }) {
  const { submit, pending, errorNode, reset } = useControlAction();
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState(flag?.key ?? "");
  const [name, setName] = useState(flag?.name ?? "");
  const [description, setDescription] = useState(flag?.description ?? "");
  const [status, setStatus] = useState<string>(flag?.status ?? "off");
  const [rolloutPercent, setRolloutPercent] = useState(flag?.rolloutPercent ?? 0);
  const [clientWired, setClientWired] = useState(flag?.clientWired ?? false);
  const [minAppVersion, setMinAppVersion] = useState(flag?.minAppVersion ?? "");

  const isSyncFlag = key === "message_sync";
  const blocked = isSyncFlag && status !== "off";

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    const ok = await submit({
      resource: "flag",
      operation: "upsert",
      values: {
        id: flag?.id,
        key,
        name,
        description: description || null,
        status,
        rolloutPercent,
        clientWired,
        minAppVersion: minAppVersion || null,
      },
    });
    if (ok) setOpen(false);
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (!next) reset(); }}>
      <DialogTrigger asChild>
        <Button size="sm" variant={flag ? "ghost" : "default"} disabled={!canManage}>
          {flag ? <SlidersHorizontal className="size-4" aria-hidden /> : <Flag className="size-4" aria-hidden />}
          {flag ? "Edit" : "New flag"}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{flag ? `Edit ${flag.key}` : "Define a feature flag"}</DialogTitle>
          <DialogDescription>
            Flags describe client behaviour. A flag marked &ldquo;client not wired&rdquo; is recorded
            honestly: the Android app does not read it yet.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="space-y-4">
          <FormRow label="Key" hint="Lowercase letters, digits and underscores. Immutable once created.">
            <Input value={key} onChange={(e) => setKey(e.target.value)} disabled={Boolean(flag)} required pattern="[a-z0-9_]+" className="font-mono" />
          </FormRow>
          <FormRow label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />
          </FormRow>
          <FormRow label="Description" hint="Say what the flag actually gates, and cite the phase if there is one.">
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
          </FormRow>

          <div className="grid gap-4 sm:grid-cols-2">
            <FormRow label="Status">
              <Select value={status} onValueChange={(value) => { setStatus(value); if (value === "on") setRolloutPercent(100); if (value === "off") setRolloutPercent(0); }}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {FLAG_STATUSES.map((value) => (
                    <SelectItem key={value} value={value} disabled={isSyncFlag && value !== "off"}>{value}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormRow>
            <FormRow label="Rollout %" hint="Must be 100 when status is 'on', 0 when 'off'.">
              <Input type="number" min={0} max={100} value={rolloutPercent} onChange={(e) => setRolloutPercent(Number(e.target.value))} />
            </FormRow>
          </div>

          <FormRow label="Minimum app version" hint="Optional. Leave blank if the flag applies to every version.">
            <Input value={minAppVersion ?? ""} onChange={(e) => setMinAppVersion(e.target.value)} placeholder="1.7.2" className="font-mono" />
          </FormRow>

          <div className="flex items-center justify-between gap-4 rounded-md border p-3">
            <div>
              <Label htmlFor="client-wired" className="text-sm">Client is wired to this flag</Label>
              <p className="mt-1 text-[11px] text-muted-foreground">Uncheck if the Android app does not read it yet.</p>
            </div>
            <Switch id="client-wired" checked={clientWired} onCheckedChange={setClientWired} />
          </div>

          {isSyncFlag ? (
            <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-[11px] leading-relaxed text-destructive">
              <span className="font-semibold">message_sync is pinned off.</span> ReplyMate is local-first;
              SYNC_ENABLED=false is asserted by SupabaseConfigTest in the Android repo. The server rejects
              any other value, and the flag cannot be deleted.
            </p>
          ) : null}
          {errorNode}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={pending || blocked || !key || !name}>
              {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
              {flag ? "Save changes" : "Create flag"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// --------------------------------------------------------------------------
// Model routing
// --------------------------------------------------------------------------

export type RouteRow = {
  id: string;
  task: string;
  providerKey: string;
  modelId: string;
  priority: number;
  thinking: string;
  maxOutputTokens: number;
  enabled: boolean;
  notes: string | null;
};

export function RouteDialog({ route, canManage }: { route?: RouteRow; canManage: boolean }) {
  const { submit, pending, errorNode, reset } = useControlAction();
  const [open, setOpen] = useState(false);
  const [task, setTask] = useState(route?.task ?? TASK_CATALOGUE[0].key);
  const [providerKey, setProviderKey] = useState(route?.providerKey ?? PROVIDER_CATALOGUE[0].key);
  const [modelId, setModelId] = useState(route?.modelId ?? "");
  const [priority, setPriority] = useState(route?.priority ?? 100);
  const [thinking, setThinking] = useState(route?.thinking ?? "none");
  const [maxOutputTokens, setMaxOutputTokens] = useState(route?.maxOutputTokens ?? effectiveOutputCap("none"));
  const [enabled, setEnabled] = useState(route?.enabled ?? false);
  const [notes, setNotes] = useState(route?.notes ?? "");

  const provider = PROVIDER_CATALOGUE.find((p) => p.key === providerKey);
  const requiredCap = effectiveOutputCap(thinking as "none" | "low" | "high");
  const capViolation = maxOutputTokens < requiredCap;
  const reasoningUnsupported = provider?.reasoningSupport === "none" && thinking !== "none";

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    const ok = await submit({
      resource: "route",
      operation: "upsert",
      values: {
        id: route?.id,
        task,
        providerKey,
        modelId,
        priority,
        thinking,
        maxOutputTokens,
        enabled,
        notes: notes || null,
      },
    });
    if (ok) setOpen(false);
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (!next) reset(); }}>
      <DialogTrigger asChild>
        <Button size="sm" variant={route ? "ghost" : "default"} disabled={!canManage}>
          {route ? <SlidersHorizontal className="size-4" aria-hidden /> : <GitBranch className="size-4" aria-hidden />}
          {route ? "Edit" : "New route"}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{route ? "Edit routing policy" : "Define a routing policy"}</DialogTitle>
          <DialogDescription>
            Routes are advisory policy for the client. The provider must be one the Android app
            actually implements — unknown providers are rejected server-side.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <FormRow label="Task">
              <Select value={task} onValueChange={setTask}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {TASK_CATALOGUE.map((t) => (
                    <SelectItem key={t.key} value={t.key}>{t.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormRow>
            <FormRow label="Provider">
              <Select value={providerKey} onValueChange={setProviderKey}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PROVIDER_CATALOGUE.map((p) => (
                    <SelectItem key={p.key} value={p.key}>{p.displayName}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormRow>
          </div>

          <FormRow label="Model id" hint="Exactly as the provider expects it, e.g. gemini-2.5-flash or claude-sonnet-4-5.">
            <Input value={modelId} onChange={(e) => setModelId(e.target.value)} required className="font-mono" placeholder="model-id" />
          </FormRow>

          <div className="grid gap-4 sm:grid-cols-3">
            <FormRow label="Priority" hint="Lower wins.">
              <Input type="number" min={0} max={9999} value={priority} onChange={(e) => setPriority(Number(e.target.value))} />
            </FormRow>
            <FormRow label="Thinking">
              <Select value={thinking} onValueChange={(value) => { setThinking(value); setMaxOutputTokens(effectiveOutputCap(value as "none" | "low" | "high")); }}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">none</SelectItem>
                  <SelectItem value="low">low</SelectItem>
                  <SelectItem value="high">high</SelectItem>
                </SelectContent>
              </Select>
            </FormRow>
            <FormRow label="Max output tokens">
              <Input type="number" min={1} value={maxOutputTokens} onChange={(e) => setMaxOutputTokens(Number(e.target.value))} />
            </FormRow>
          </div>

          <div className="rounded-md border bg-muted/30 p-3 text-[11px] leading-relaxed text-muted-foreground">
            <p className="font-medium text-foreground">Output-cap rule ({OUTPUT_CAP_RULE.source})</p>
            <p className="mt-1">{OUTPUT_CAP_RULE.description}</p>
            <p className="mt-1 font-mono">
              required minimum for thinking=&quot;{thinking}&quot; = {requiredCap}
            </p>
          </div>

          {capViolation ? (
            <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-[11px] text-destructive">
              {maxOutputTokens} is below the required {requiredCap}. The server will reject this route.
            </p>
          ) : null}
          {reasoningUnsupported ? (
            <p className="rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-[11px] text-warning">
              {provider?.displayName} reports reasoning support &ldquo;none&rdquo; — the client sends no
              thinking control for this dialect, so this setting will be ignored at runtime.
            </p>
          ) : null}

          <FormRow label="Notes">
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
          </FormRow>

          <div className="flex items-center justify-between gap-4 rounded-md border p-3">
            <div>
              <Label htmlFor="route-enabled" className="text-sm">Enabled</Label>
              <p className="mt-1 text-[11px] text-muted-foreground">Disabled routes are visible but not served.</p>
            </div>
            <Switch id="route-enabled" checked={enabled} onCheckedChange={setEnabled} />
          </div>

          {errorNode}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={pending || capViolation || !modelId}>
              {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
              {route ? "Save route" : "Create route"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// --------------------------------------------------------------------------
// Support ticket intake
// --------------------------------------------------------------------------

export function TicketDialog() {
  const { submit, pending, errorNode, reset } = useControlAction();
  const [open, setOpen] = useState(false);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [requesterEmail, setRequesterEmail] = useState("");
  const [appVersion, setAppVersion] = useState("");
  const [priority, setPriority] = useState("normal");

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    const ok = await submit({
      resource: "ticket",
      operation: "create",
      values: {
        subject,
        body: body || undefined,
        requesterEmail: requesterEmail || undefined,
        appVersion: appVersion || undefined,
        priority,
      },
    });
    if (ok) {
      setSubject("");
      setBody("");
      setRequesterEmail("");
      setAppVersion("");
      setOpen(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (!next) reset(); }}>
      <DialogTrigger asChild>
        <Button size="sm">
          <LifeBuoy className="size-4" aria-hidden />
          Log a ticket
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Log a support ticket</DialogTitle>
          <DialogDescription>
            Manual intake. There is no connected inbound channel yet, so tickets only exist when an
            operator records one here. Never paste message content from a user&rsquo;s device.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="space-y-4">
          <FormRow label="Subject">
            <Input value={subject} onChange={(e) => setSubject(e.target.value)} required minLength={3} maxLength={200} />
          </FormRow>
          <FormRow label="Details" hint="Describe symptoms and diagnostics. Do not include message bodies, contacts or API keys.">
            <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={4} maxLength={8000} />
          </FormRow>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormRow label="Requester email" hint="Optional.">
              <Input type="email" value={requesterEmail} onChange={(e) => setRequesterEmail(e.target.value)} />
            </FormRow>
            <FormRow label="App version" hint="e.g. 1.5.9">
              <Input value={appVersion} onChange={(e) => setAppVersion(e.target.value)} className="font-mono" />
            </FormRow>
          </div>
          <FormRow label="Priority">
            <Select value={priority} onValueChange={setPriority}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                {["low", "normal", "high", "urgent"].map((value) => (
                  <SelectItem key={value} value={value}>{value}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormRow>

          {errorNode}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={pending || !subject}>
              {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Plus className="size-4" aria-hidden />}
              Create ticket
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// --------------------------------------------------------------------------
// Configuration value editor
// --------------------------------------------------------------------------

export function ConfigDialog({
  item,
  canManage,
}: {
  item: { id: string; key: string; valueType: string; value: unknown; locked: boolean; description: string | null };
  canManage: boolean;
}) {
  const { submit, pending, errorNode, reset } = useControlAction();
  const [open, setOpen] = useState(false);
  const serialized = typeof item.value === "string" ? item.value : JSON.stringify(item.value, null, 2);
  const [draft, setDraft] = useState(serialized);

  const locked = item.locked || item.key.startsWith("privacy.");

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    let value: unknown = draft;
    if (item.valueType === "json") {
      try {
        value = JSON.parse(draft);
      } catch {
        return;
      }
    } else if (item.valueType === "boolean") {
      value = draft === "true";
    } else if (item.valueType === "number") {
      value = Number(draft);
    }
    const ok = await submit({ resource: "config", operation: "update", values: { id: item.id, value } });
    if (ok) setOpen(false);
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (!next) { reset(); setDraft(serialized); } }}>
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost" disabled={!canManage || locked}>
          <SlidersHorizontal className="size-4" aria-hidden />
          {locked ? "Locked" : "Edit"}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="font-mono text-base">{item.key}</DialogTitle>
          <DialogDescription>{item.description ?? "No description recorded."}</DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="space-y-4">
          {locked ? (
            <p className="rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-[11px] leading-relaxed text-warning">
              This key is pinned by the ReplyMate app contract or is a privacy invariant. It is
              read-only here on purpose — changing it means changing code and shipping a release.
            </p>
          ) : null}

          <FormRow label={`Value (${item.valueType})`}>
            {item.valueType === "boolean" ? (
              <Select value={draft} onValueChange={setDraft} disabled={locked}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="true">true</SelectItem>
                  <SelectItem value="false">false</SelectItem>
                </SelectContent>
              </Select>
            ) : item.valueType === "json" ? (
              <Textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={8} disabled={locked} className="font-mono text-xs" />
            ) : (
              <Input value={draft} onChange={(e) => setDraft(e.target.value)} disabled={locked} type={item.valueType === "number" ? "number" : "text"} className="font-mono" />
            )}
          </FormRow>

          {errorNode}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={pending || locked}>
              {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
              Save value
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
