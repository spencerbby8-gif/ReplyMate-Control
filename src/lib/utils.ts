import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { navItems as NAV_LOOKUP } from "@/config/nav";

/** Tailwind-aware class merge — the shadcn/ui convention. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Deterministic, locale-stable timestamp formatting for server-rendered pages. */
export function formatDateTime(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(date);
}

export function formatRelative(value: Date | string | null | undefined): string {
  if (!value) return "never";
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "never";
  const diffMs = Date.now() - date.getTime();
  const abs = Math.abs(diffMs);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 31_536_000_000],
    ["month", 2_592_000_000],
    ["day", 86_400_000],
    ["hour", 3_600_000],
    ["minute", 60_000],
    ["second", 1_000],
  ];
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  for (const [unit, ms] of units) {
    if (abs >= ms) return rtf.format(Math.round(-diffMs / ms), unit);
  }
  return "just now";
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return new Intl.NumberFormat("en-GB").format(value);
}

/** Truncate for table cells; never used on secrets (secrets are never rendered). */
export function truncate(value: string, max = 64): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/**
 * Resolves the breadcrumb label for a path from the navigation registry.
 * Kept here (not in config/nav) so client components can import it without
 * pulling the server-only permission helpers along.
 */
export function findNavItemTitle(
  pathname: string,
  registry: ReadonlyArray<{ title: string; href: string }> = NAV_LOOKUP,
): string {
  const exact = registry.find((item) => item.href === pathname);
  if (exact) return exact.title;
  const parent = registry
    .filter((item) => pathname.startsWith(`${item.href}/`))
    .sort((a, b) => b.href.length - a.href.length)[0];
  return parent?.title ?? "Console";
}
