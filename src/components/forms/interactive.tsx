"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Check, KeyRound, Loader2, ShieldCheck, Sparkles, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

// --------------------------------------------------------------------------
// TOTP enrolment
// --------------------------------------------------------------------------

/** Renders an otpauth:// URI as a QR code without any third-party dependency. */
function QrPlaceholder({ uri }: { uri: string }) {
  return (
    <div className="space-y-2">
      <div className="rounded-md border bg-muted/30 p-3">
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Scan this URI with your authenticator app, or enter the manual key below. The URI is shown
          once; the secret is stored encrypted and is never rendered again.
        </p>
        <code className="mt-2 block break-all rounded bg-background p-2 font-mono text-[11px]">{uri}</code>
      </div>
    </div>
  );
}

export function MfaEnrolment({ enrolled, mfaRequired }: { enrolled: boolean; mfaRequired: boolean }) {
  const router = useRouter();
  const [stage, setStage] = useState<"idle" | "awaiting-code">("idle");
  const [uri, setUri] = useState<string | null>(null);
  const [manualKey, setManualKey] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function begin() {
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/mfa/setup", { method: "POST" });
      const payload = await response.json();
      if (!response.ok) {
        setError(payload?.error ?? "Could not start enrolment.");
        return;
      }
      setUri(payload.data.otpauthUri);
      setManualKey(payload.data.manualEntryKey);
      setStage("awaiting-code");
    } catch {
      setError("Network error — the request did not reach the server.");
    } finally {
      setPending(false);
    }
  }

  async function confirm(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/mfa/setup", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const payload = await response.json();
      if (!response.ok) {
        setError(payload?.error ?? "Verification failed.");
        setCode("");
        return;
      }
      setDone(true);
      setUri(null);
      setManualKey(null);
      router.refresh();
    } catch {
      setError("Network error — the request did not reach the server.");
    } finally {
      setPending(false);
    }
  }

  if (enrolled || done) {
    return (
      <div className="flex items-start gap-3 rounded-lg border border-success/30 bg-success/5 p-4">
        <ShieldCheck className="mt-0.5 size-5 shrink-0 text-success" aria-hidden />
        <div className="space-y-1">
          <p className="text-sm font-semibold text-success">TOTP factor enrolled</p>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Every sign-in for this account now requires a rotating 6-digit code. Codes are
            single-use: each TOTP step is recorded and a replay is rejected and audited.
            {mfaRequired ? " MFA is required by policy for this account." : ""}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {stage === "idle" ? (
        <div className="flex flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <p className="flex items-center gap-2 text-sm font-semibold">
              <KeyRound className="size-4 text-primary" aria-hidden />
              Two-factor authentication
            </p>
            <p className="max-w-xl text-xs leading-relaxed text-muted-foreground">
              Enrol a TOTP factor (RFC 6238, SHA-1, 30-second step, 6 digits) with any authenticator
              app. The shared secret is encrypted with AES-256-GCM under CONTROL_ENC_KEY before it is
              stored, and enrolment is refused outright if that key is absent.
            </p>
          </div>
          <Button onClick={begin} disabled={pending} className="shrink-0">
            {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <KeyRound className="size-4" aria-hidden />}
            Begin enrolment
          </Button>
        </div>
      ) : (
        <form onSubmit={confirm} className="space-y-4 rounded-lg border p-4">
          <div className="space-y-1">
            <p className="text-sm font-semibold">Step 2 — prove possession</p>
            <p className="text-xs leading-relaxed text-muted-foreground">
              The factor only goes live after a valid code is verified. Until then sign-in is not
              affected.
            </p>
          </div>

          {uri ? <QrPlaceholder uri={uri} /> : null}
          {manualKey ? (
            <div className="rounded-md border bg-background p-2">
              <p className="text-[11px] text-muted-foreground">Manual entry key</p>
              <code className="block break-all font-mono text-sm">{manualKey}</code>
            </div>
          ) : null}

          <div className="space-y-2">
            <Label htmlFor="enrol-code">Authenticator code</Label>
            <Input
              id="enrol-code"
              inputMode="numeric"
              pattern="\d{6}"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              className="max-w-[180px] text-center font-mono text-lg tracking-[0.4em]"
              placeholder="000000"
              autoFocus
            />
          </div>

          {error ? (
            <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              {error}
            </p>
          ) : null}

          <div className="flex gap-2">
            <Button type="submit" disabled={pending || code.length !== 6}>
              {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Check className="size-4" aria-hidden />}
              Verify and enable
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setStage("idle");
                setUri(null);
                setManualKey(null);
                setCode("");
                setError(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

// --------------------------------------------------------------------------
// AI operations assistant console
// --------------------------------------------------------------------------

type AiopsTool = { name: string; ok: boolean; note?: string };

type AiopsResponse = {
  data: {
    summary: string;
    assistant: {
      answer: string;
      mode: string;
      sessionId: string;
      tools: AiopsTool[];
      honest: string[];
    } | null;
  };
  error?: string;
  requestId?: string;
};

type Turn = {
  role: "user" | "assistant";
  content: string;
  tools?: AiopsTool[];
  mode?: string;
};

export function AiOpsConsole({ llmActive, provider }: { llmActive: boolean; provider: string }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [prompt, setPrompt] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns, pending]);

  async function send(event: React.FormEvent) {
    event.preventDefault();
    const text = prompt.trim();
    if (!text || pending) return;

    setPending(true);
    setError(null);
    setTurns((prev) => [...prev, { role: "user", content: text }]);
    setPrompt("");

    try {
      const response = await fetch("/api/control", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          resource: "aiops",
          operation: "run",
          values: { prompt: text, sessionId: sessionId ?? undefined },
        }),
      });
      const payload = (await response.json()) as AiopsResponse;
      if (!response.ok || !payload.data?.assistant) {
        setError(payload.error ?? `Request failed (HTTP ${response.status})`);
        setTurns((prev) => [...prev, { role: "assistant", content: payload.error ?? "The assistant could not run." }]);
        return;
      }
      setSessionId(payload.data.assistant.sessionId);
      setTurns((prev) => [
        ...prev,
        {
          role: "assistant",
          content: payload.data.assistant!.answer,
          tools: payload.data.assistant!.tools,
          mode: payload.data.assistant!.mode,
        },
      ]);
    } catch {
      setError("Network error — the assistant request did not reach the server.");
    } finally {
      setPending(false);
    }
  }

  const suggestions = [
    "What is the MFA coverage across administrators?",
    "Which providers support native web search?",
    "Show the release ledger state.",
    "Are any model routes below the required output cap?",
    "What may this platform read from Supabase?",
    "What am I allowed to do with my role?",
  ];

  return (
    <div className="flex h-[620px] flex-col overflow-hidden rounded-xl border bg-card">
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <Sparkles className="size-4 text-primary" aria-hidden />
        <p className="text-sm font-semibold">Operations assistant</p>
        <Badge variant={llmActive ? "success" : "muted"} className="ml-auto font-mono text-[10px]">
          {llmActive ? `llm:${provider}` : "deterministic"}
        </Badge>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto p-4 scrollbar-thin">
        {turns.length === 0 ? (
          <div className="space-y-3 pt-4">
            <p className="text-sm leading-relaxed text-muted-foreground">
              {llmActive
                ? `Answers are produced by ${provider} over a fixed tool registry. The model receives tool output as grounding and cannot reach the database directly.`
                : "No LLM provider key is configured, so the assistant runs its deterministic runbook engine: an intent router selects real tools, the tools query this control plane, and the answer is composed only from what they returned."}
            </p>
            <p className="text-xs leading-relaxed text-muted-foreground">
              It will not guess. If no runbook matches, it says so and lists what it can execute.
            </p>
            <div className="flex flex-wrap gap-2 pt-1">
              {suggestions.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  onClick={() => setPrompt(suggestion)}
                  className="rounded-full border px-3 py-1.5 text-left text-[11px] leading-snug text-muted-foreground transition-colors hover:border-primary/40 hover:bg-accent hover:text-foreground"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {turns.map((turn, index) => (
          <div key={index} className={cn("flex", turn.role === "user" ? "justify-end" : "justify-start")}>
            <div
              className={cn(
                "max-w-[85%] space-y-2 rounded-lg border px-3.5 py-2.5",
                turn.role === "user" ? "bg-primary/10 border-primary/25" : "bg-muted/30",
              )}
            >
              {turn.role === "assistant" && turn.tools && turn.tools.length > 0 ? (
                <div className="flex flex-wrap items-center gap-1.5">
                  <Wrench className="size-3 text-muted-foreground" aria-hidden />
                  {turn.tools.map((tool) => (
                    <Badge key={tool.name} variant={tool.ok ? "success" : "destructive"} className="font-mono text-[10px]">
                      {tool.name}
                    </Badge>
                  ))}
                  <Badge variant="outline" className="font-mono text-[10px]">
                    {turn.mode}
                  </Badge>
                </div>
              ) : null}
              <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed">{turn.content}</pre>
            </div>
          </div>
        ))}

        {pending ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
            Running tools against the control plane…
          </div>
        ) : null}
        <div ref={endRef} />
      </div>

      {error ? (
        <p role="alert" className="border-t border-destructive/30 bg-destructive/5 px-4 py-2 text-[11px] text-destructive">
          {error}
        </p>
      ) : null}

      <form onSubmit={send} className="flex items-end gap-2 border-t p-3">
        <div className="flex-1 space-y-1">
          <Label htmlFor="aiops-prompt" className="sr-only">Ask the operations assistant</Label>
          <Input
            id="aiops-prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Ask about flags, providers, routing, releases, privacy or your own permissions…"
            disabled={pending}
            maxLength={2000}
            autoComplete="off"
          />
        </div>
        <Button type="submit" disabled={pending || prompt.trim().length < 2}>
          {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Sparkles className="size-4" aria-hidden />}
          Run
        </Button>
      </form>
    </div>
  );
}
