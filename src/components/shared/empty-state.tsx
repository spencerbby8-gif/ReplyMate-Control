import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The only empty-state component in the app.
 *
 * Product rule: an empty state must say WHY it is empty and WHAT would make it
 * non-empty. Never a decorative "No data yet" and never placeholder rows.
 */
export function EmptyState({
  icon: Icon,
  title,
  reason,
  nextStep,
  action,
  tone = "neutral",
  className,
}: {
  icon: LucideIcon;
  title: string;
  reason: string;
  nextStep?: string;
  action?: ReactNode;
  tone?: "neutral" | "blocked" | "waiting";
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center rounded-xl border border-dashed px-6 py-14 text-center",
        tone === "blocked" && "border-warning/40 bg-warning/5",
        tone === "waiting" && "border-info/40 bg-info/5",
        tone === "neutral" && "bg-muted/20",
        className,
      )}
    >
      <div
        className={cn(
          "mb-4 grid size-11 place-items-center rounded-lg border",
          tone === "blocked" ? "border-warning/40 text-warning" : "text-muted-foreground",
        )}
      >
        <Icon className="size-5" aria-hidden />
      </div>
      <h3 className="text-sm font-semibold">{title}</h3>
      <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted-foreground">{reason}</p>
      {nextStep ? (
        <p className="mt-3 max-w-xl text-xs leading-relaxed text-muted-foreground/80">
          <span className="font-medium text-foreground/80">Next step:</span> {nextStep}
        </p>
      ) : null}
      {action ? <div className="mt-5 flex flex-wrap items-center justify-center gap-2">{action}</div> : null}
    </div>
  );
}
