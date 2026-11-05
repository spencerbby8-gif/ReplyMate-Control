import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type Tone = "success" | "warning" | "destructive" | "info" | "muted" | "secondary";

const TONE_MAP: Record<string, Tone> = {
  // providers
  available: "success",
  degraded: "warning",
  disabled: "muted",
  unconfigured: "muted",
  // releases
  draft: "muted",
  building: "info",
  published: "success",
  paused: "warning",
  broken: "destructive",
  // flags
  off: "muted",
  shadow: "info",
  canary: "warning",
  on: "success",
  // people
  active: "success",
  invited: "info",
  suspended: "destructive",
  // tickets
  open: "info",
  triaged: "warning",
  waiting: "warning",
  resolved: "success",
  closed: "muted",
  // monitoring
  ok: "success",
  down: "destructive",
  unknown: "muted",
  // misc
  success: "success",
  denied: "destructive",
  error: "destructive",
  native: "success",
  family_split: "info",
  fallback: "warning",
  none: "muted",
  low: "muted",
  normal: "info",
  high: "warning",
  urgent: "destructive",
};

export function StatusBadge({ value, className }: { value: string; className?: string }) {
  const tone = TONE_MAP[value] ?? "secondary";
  return (
    <Badge variant={tone} className={cn("font-mono text-[11px] tracking-tight", className)}>
      {value}
    </Badge>
  );
}

export function Dot({ tone = "muted", pulse = false }: { tone?: Tone; pulse?: boolean }) {
  return (
    <span className="relative flex size-2">
      {pulse ? (
        <span
          className={cn(
            "absolute inline-flex h-full w-full animate-ping rounded-full opacity-60",
            tone === "success" && "bg-success",
            tone === "warning" && "bg-warning",
            tone === "destructive" && "bg-destructive",
            tone === "info" && "bg-info",
            (tone === "muted" || tone === "secondary") && "bg-muted-foreground",
          )}
        />
      ) : null}
      <span
        className={cn(
          "relative inline-flex size-2 rounded-full",
          tone === "success" && "bg-success",
          tone === "warning" && "bg-warning",
          tone === "destructive" && "bg-destructive",
          tone === "info" && "bg-info",
          (tone === "muted" || tone === "secondary") && "bg-muted-foreground",
        )}
      />
    </span>
  );
}
