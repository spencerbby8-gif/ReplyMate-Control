import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function StatCard({
  label,
  value,
  hint,
  icon: Icon,
  tone = "neutral",
  footer,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  icon?: LucideIcon;
  tone?: "neutral" | "positive" | "warning" | "critical" | "muted";
  footer?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-xl border bg-card p-5 shadow-sm transition-colors",
        "hover:border-primary/30",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{label}</p>
        {Icon ? (
          <span
            className={cn(
              "grid size-8 shrink-0 place-items-center rounded-md border",
              tone === "positive" && "border-success/30 bg-success/10 text-success",
              tone === "warning" && "border-warning/30 bg-warning/10 text-warning",
              tone === "critical" && "border-destructive/30 bg-destructive/10 text-destructive",
              tone === "muted" && "border-border bg-muted text-muted-foreground",
              tone === "neutral" && "border-primary/25 bg-primary/10 text-primary",
            )}
          >
            <Icon className="size-4" aria-hidden />
          </span>
        ) : null}
      </div>
      <p className="mt-3 font-mono text-3xl font-semibold tabular-nums tracking-tight">{value}</p>
      {hint ? <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{hint}</p> : null}
      {footer ? <div className="mt-3 border-t pt-3 text-xs text-muted-foreground">{footer}</div> : null}
    </div>
  );
}
