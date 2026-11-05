"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect } from "react";
import {
  Activity,
  BarChart3,
  ChevronLeft,
  Cpu,
  CreditCard,
  Flag,
  GitBranch,
  KeyRound,
  LayoutDashboard,
  LifeBuoy,
  Lock,
  Package,
  ScrollText,
  ShieldCheck,
  SlidersHorizontal,
  Smartphone,
  Sparkles,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { AdminRole } from "@/db/schema";

export type SidebarNavItem = {
  title: string;
  href: string;
  icon: string;
  description: string;
};

export type SidebarGroup = { label: string; items: SidebarNavItem[] };

const ICONS: Record<string, LucideIcon> = {
  LayoutDashboard,
  Activity,
  Users,
  ShieldCheck,
  ScrollText,
  Cpu,
  GitBranch,
  KeyRound,
  BarChart3,
  Sparkles,
  Flag,
  Package,
  Smartphone,
  CreditCard,
  LifeBuoy,
  SlidersHorizontal,
  Lock,
};

function Mark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn("size-8", className)} aria-hidden>
      <defs>
        <linearGradient id="rmctl-mark" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="oklch(0.78 0.15 285)" />
          <stop offset="100%" stopColor="oklch(0.62 0.17 255)" />
        </linearGradient>
      </defs>
      <rect x="1.5" y="1.5" width="29" height="29" rx="9" fill="url(#rmctl-mark)" />
      <path
        d="M9 11.5h9.5a4.5 4.5 0 0 1 0 9H13l-4 3.5v-3.5H9z"
        fill="none"
        stroke="oklch(0.16 0.03 275)"
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx="22.5" cy="21.5" r="2" fill="oklch(0.16 0.03 275)" />
    </svg>
  );
}

export function Sidebar({
  groups,
  role,
  collapsed,
  onToggleCollapse,
  mobileOpen,
  onCloseMobile,
}: {
  groups: SidebarGroup[];
  role: AdminRole;
  collapsed: boolean;
  onToggleCollapse: () => void;
  mobileOpen: boolean;
  onCloseMobile: () => void;
}) {
  const pathname = usePathname();

  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseMobile();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mobileOpen, onCloseMobile]);

  const nav = (
    <nav className="flex-1 space-y-6 overflow-y-auto px-3 py-4 scrollbar-thin" aria-label="Primary">
      {groups.map((group) => (
        <div key={group.label}>
          <p
            className={cn(
              "px-3 pb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70",
              collapsed && "text-center px-0",
            )}
          >
            {collapsed ? "•••" : group.label}
          </p>
          <ul className="space-y-0.5">
            {group.items.map((item) => {
              const Icon = ICONS[item.icon] ?? LayoutDashboard;
              const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={onCloseMobile}
                    title={collapsed ? item.title : undefined}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "group flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                      active
                        ? "bg-sidebar-accent text-sidebar-accent-foreground"
                        : "text-sidebar-foreground/75 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground",
                      collapsed && "justify-center px-0",
                    )}
                  >
                    <Icon className={cn("size-4 shrink-0", active ? "text-primary" : "text-muted-foreground group-hover:text-foreground")} aria-hidden />
                    {!collapsed && <span className="truncate">{item.title}</span>}
                    {!collapsed && active && (
                      <span className="ml-auto size-1.5 shrink-0 rounded-full bg-primary" aria-hidden />
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );

  const header = (
    <div className="flex h-14 shrink-0 items-center gap-2.5 border-b border-sidebar-border px-4">
      <Mark />
      {!collapsed && (
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold leading-tight">ReplyMate</p>
          <p className="truncate text-[11px] leading-tight text-muted-foreground">Control plane</p>
        </div>
      )}
      <button
        type="button"
        onClick={onToggleCollapse}
        className="ml-auto hidden size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground lg:grid"
        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      >
        <ChevronLeft className={cn("size-4 transition-transform", collapsed && "rotate-180")} />
      </button>
      <button
        type="button"
        onClick={onCloseMobile}
        className="ml-auto grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-foreground lg:hidden"
        aria-label="Close navigation"
      >
        <X className="size-4" />
      </button>
    </div>
  );

  const footer = !collapsed && (
    <div className="shrink-0 border-t border-sidebar-border px-4 py-3">
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        Signed in as <span className="font-medium text-foreground">{role}</span>
      </p>
      <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground/70">
        Local-first contract enforced · message sync off
      </p>
    </div>
  );

  return (
    <>
      {/* Desktop rail */}
      <aside
        className={cn(
          "sticky top-0 hidden h-dvh shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-[width] duration-200 lg:flex",
          collapsed ? "w-[68px]" : "w-64",
        )}
      >
        {header}
        {nav}
        {footer}
      </aside>

      {/* Mobile drawer */}
      <div
        className={cn(
          "fixed inset-0 z-50 lg:hidden",
          mobileOpen ? "pointer-events-auto" : "pointer-events-none",
        )}
        aria-hidden={!mobileOpen}
      >
        <div
          className={cn(
            "absolute inset-0 bg-black/60 backdrop-blur-sm transition-opacity",
            mobileOpen ? "opacity-100" : "opacity-0",
          )}
          onClick={onCloseMobile}
        />
        <aside
          className={cn(
            "absolute inset-y-0 left-0 flex w-[272px] max-w-[85vw] flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground shadow-2xl transition-transform duration-200",
            mobileOpen ? "translate-x-0" : "-translate-x-full",
          )}
        >
          {header}
          {nav}
        </aside>
      </div>

    </>
  );
}
