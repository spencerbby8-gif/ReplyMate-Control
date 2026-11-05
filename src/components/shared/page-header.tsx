import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function PageHeader({
  title,
  description,
  actions,
  meta,
  className,
}: {
  title: string;
  description: string;
  actions?: ReactNode;
  meta?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cn("flex flex-col gap-4 pb-2 sm:flex-row sm:items-start sm:justify-between", className)}>
      <div className="min-w-0 space-y-1.5">
        <h1 className="text-2xl font-semibold tracking-tight text-balance">{title}</h1>
        <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">{description}</p>
        {meta ? <div className="flex flex-wrap items-center gap-2 pt-1">{meta}</div> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}
