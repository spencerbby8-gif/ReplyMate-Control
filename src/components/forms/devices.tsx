"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Copy, KeyRound, Loader2, Smartphone } from "lucide-react";
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
 * Device registration.
 *
 * Consent is a required, explicit input: the timestamp is when the user of that
 * device agreed to diagnostics, not when an operator felt like filling a form.
 * The ingest key is returned exactly once and is stored only as a digest.
 */
export function DeviceRegisterDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<{ key: string; deviceId: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const [label, setLabel] = useState("");
  const [appVersion, setAppVersion] = useState("");
  const [androidApiLevel, setAndroidApiLevel] = useState("");
  const [deviceModel, setDeviceModel] = useState("");
  const [consentRecordedAt, setConsentRecordedAt] = useState("");
  const [notes, setNotes] = useState("");
  const [expiresInDays, setExpiresInDays] = useState(90);

  const consentInFuture = consentRecordedAt !== "" && new Date(consentRecordedAt).getTime() > Date.now();

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/control", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          resource: "device",
          operation: "register",
          values: {
            label,
            appVersion: appVersion || null,
            androidApiLevel: androidApiLevel ? Number(androidApiLevel) : null,
            deviceModel: deviceModel || null,
            consentRecordedAt: new Date(consentRecordedAt).toISOString(),
            notes: notes || null,
            expiresInDays,
          },
        }),
      });
      const payload = (await response.json()) as {
        data?: { ingestKey?: string; deviceId?: string };
        error?: string;
      };
      if (!response.ok || !payload.data?.ingestKey) {
        setError(payload.error ?? "Registration failed.");
        return;
      }
      setIssued({ key: payload.data.ingestKey, deviceId: payload.data.deviceId ?? "" });
      setLabel("");
      setAppVersion("");
      setAndroidApiLevel("");
      setDeviceModel("");
      setNotes("");
      router.refresh();
    } catch {
      setError("Network error — the request did not reach the server.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setIssued(null);
          setError(null);
          setCopied(false);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm">
          <Smartphone className="size-4" aria-hidden />
          Register device
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Register a device for opt-in diagnostics</DialogTitle>
          <DialogDescription>
            Records that a specific device&rsquo;s user consented, and issues a scoped ingest key.
            Only the five allow-listed event kinds can ever be sent with it.
          </DialogDescription>
        </DialogHeader>

        {issued ? (
          <div className="space-y-4">
            <div className="rounded-lg border border-success/30 bg-success/5 p-4">
              <p className="flex items-center gap-2 text-sm font-semibold text-success">
                <KeyRound className="size-4" aria-hidden />
                Ingest key issued — shown once
              </p>
              <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                Only its digest is stored, so it cannot be recovered later. Send it as{" "}
                <span className="font-mono">Authorization: Bearer &lt;key&gt;</span> to{" "}
                <span className="font-mono">POST /api/ingest/events</span>.
              </p>
              <div className="mt-3 flex items-start gap-2">
                <code className="min-w-0 flex-1 break-all rounded bg-background p-2 font-mono text-[11px]">
                  {issued.key}
                </code>
                <Button
                  size="icon-sm"
                  variant="outline"
                  onClick={() => {
                    void navigator.clipboard.writeText(issued.key);
                    setCopied(true);
                  }}
                  aria-label="Copy ingest key"
                >
                  <Copy className="size-3.5" aria-hidden />
                </Button>
              </div>
              {copied ? <p className="mt-1 text-[11px] text-success">Copied.</p> : null}
            </div>
            <DialogFooter>
              <Button onClick={() => setOpen(false)}>Done</Button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="device-label">Label</Label>
              <Input
                id="device-label"
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                required
                maxLength={80}
                placeholder="Owner's Pixel 8 — test device"
              />
              <p className="text-[11px] text-muted-foreground">
                An operator-facing name. Do not put the device owner&rsquo;s personal name here.
              </p>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="device-app-version">App version</Label>
                <Input
                  id="device-app-version"
                  value={appVersion}
                  onChange={(event) => setAppVersion(event.target.value)}
                  className="font-mono"
                  placeholder="1.5.9"
                  maxLength={24}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="device-api">Android API level</Label>
                <Input
                  id="device-api"
                  type="number"
                  min={24}
                  max={99}
                  value={androidApiLevel}
                  onChange={(event) => setAndroidApiLevel(event.target.value)}
                  className="font-mono"
                  placeholder="34"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="device-model">Device model</Label>
              <Input
                id="device-model"
                value={deviceModel}
                onChange={(event) => setDeviceModel(event.target.value)}
                className="font-mono"
                placeholder="Pixel 8"
                maxLength={64}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="device-consent">Consent recorded at</Label>
              <Input
                id="device-consent"
                type="datetime-local"
                value={consentRecordedAt}
                onChange={(event) => setConsentRecordedAt(event.target.value)}
                required
                max={new Date().toISOString().slice(0, 16)}
              />
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                When the person using that device agreed to diagnostics. Required, cannot be in the
                future, and cannot be back-dated into a row after the fact — revoking consent stops
                ingestion immediately.
              </p>
              {consentInFuture ? (
                <p className="text-[11px] text-destructive">Consent cannot be recorded in the future.</p>
              ) : null}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="device-expiry">Key lifetime (days)</Label>
              <Input
                id="device-expiry"
                type="number"
                min={1}
                max={365}
                value={expiresInDays}
                onChange={(event) => setExpiresInDays(Number(event.target.value))}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="device-notes">Notes</Label>
              <Textarea
                id="device-notes"
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                rows={2}
                maxLength={500}
                placeholder="What this device is being used to reproduce"
              />
            </div>

            {error ? (
              <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                {error}
              </p>
            ) : null}

            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={pending || !label || !consentRecordedAt || consentInFuture}>
                {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <KeyRound className="size-4" aria-hidden />}
                Register and issue key
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
