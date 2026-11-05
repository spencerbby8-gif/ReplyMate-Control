"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The single mutation primitive in this app.
 *
 * Every write control renders through this, so there are no dead buttons: a
 * control either has a real endpoint wired here or it does not exist. Errors are
 * surfaced inline together with the request id from the audit trail.
 */
export function AsyncAction({
  endpoint,
  method = "POST",
  payload,
  label,
  icon,
  variant = "outline",
  size = "sm",
  confirm,
  disabled,
  disabledReason,
  className,
  successMessage,
}: {
  endpoint: string;
  method?: "POST" | "PUT" | "PATCH" | "DELETE";
  payload?: Record<string, unknown>;
  label: string;
  icon?: ReactNode;
  variant?: "default" | "outline" | "ghost" | "destructive" | "secondary" | "success";
  size?: "default" | "sm" | "lg" | "icon" | "icon-sm";
  confirm?: string;
  disabled?: boolean;
  disabledReason?: string;
  className?: string;
  successMessage?: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  async function run() {
    if (confirm && !window.confirm(confirm)) return;
    setPending(true);
    setError(null);
    setFlash(null);
    try {
      const response = await fetch(endpoint, {
        method,
        headers: { "content-type": "application/json" },
        body: payload ? JSON.stringify(payload) : undefined,
      });
      const text = await response.text();
      let body: { error?: string; requestId?: string; data?: unknown } = {};
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        body = { error: text.slice(0, 200) };
      }
      if (!response.ok) {
        setError(`${body.error ?? `Request failed (HTTP ${response.status})`}${body.requestId ? ` · ${body.requestId}` : ""}`);
        return;
      }
      setFlash(successMessage ?? "Done.");
      router.refresh();
      window.setTimeout(() => setFlash(null), 4000);
    } catch {
      setError("Network error — the request did not reach the server.");
    } finally {
      setPending(false);
    }
  }

  const isDisabled = disabled || pending;

  return (
    <span className={cn("inline-flex flex-col items-start gap-1", className)}>
      <Button
        type="button"
        variant={variant}
        size={size}
        onClick={run}
        disabled={isDisabled}
        title={disabled && disabledReason ? disabledReason : undefined}
        aria-disabled={isDisabled}
      >
        {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : icon}
        {label}
      </Button>
      {error ? (
        <span role="alert" className="flex max-w-sm items-start gap-1.5 text-[11px] leading-snug text-destructive">
          <AlertTriangle className="mt-px size-3 shrink-0" aria-hidden />
          {error}
        </span>
      ) : null}
      {flash ? <span className="max-w-sm text-[11px] leading-snug text-success">{flash}</span> : null}
      {disabled && disabledReason && !error ? (
        <span className="max-w-sm text-[11px] leading-snug text-muted-foreground">{disabledReason}</span>
      ) : null}
    </span>
  );
}
