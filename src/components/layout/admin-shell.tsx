"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  ChevronDown,
  LogOut,
  Menu,
  Moon,
  ShieldAlert,
  Sun,
  WifiOff,
  type LucideIcon,
} from "lucide-react";
import { Sidebar, type SidebarGroup } from "@/components/layout/sidebar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Dot } from "@/components/shared/status-badge";
import { cn, findNavItemTitle } from "@/lib/utils";
import type { AdminRole } from "@/db/schema";

export type ShellUser = {
  id: string;
  email: string;
  displayName: string | null;
  role: AdminRole;
  mfaEnrolled: boolean;
  mfaRequired: boolean;
};

export type ShellEnvironment = {
  authProvider: "local" | "supabase";
  supabaseConfigured: boolean;
  nodeEnv: string;
  aiOpsLlmActive: boolean;
};

/**
 * Theme is external state (a class on <html> plus a localStorage preference), so
 * it is read through `useSyncExternalStore` rather than mirrored into React
 * state. The server snapshot is "dark", which matches the server-rendered
 * `<html class="dark">`, so there is no hydration mismatch; a stored light
 * preference is applied to the DOM after hydration and announced through the
 * subscription.
 */
const THEME_EVENT = "rmctl-theme-change";

function readTheme(): "dark" | "light" {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

function subscribeTheme(onChange: () => void) {
  window.addEventListener(THEME_EVENT, onChange);
  return () => window.removeEventListener(THEME_EVENT, onChange);
}

function ThemeToggle() {
  const theme = useSyncExternalStore(subscribeTheme, readTheme, () => "dark" as const);

  useEffect(() => {
    const stored = window.localStorage.getItem("rmctl-theme");
    if (stored === "light" && document.documentElement.classList.contains("dark")) {
      document.documentElement.classList.remove("dark");
      window.dispatchEvent(new Event(THEME_EVENT));
    }
  }, []);

  const toggle = () => {
    const next = readTheme() === "dark" ? "light" : "dark";
    document.documentElement.classList.toggle("dark", next === "dark");
    window.localStorage.setItem("rmctl-theme", next);
    window.dispatchEvent(new Event(THEME_EVENT));
  };

  const Icon: LucideIcon = theme === "dark" ? Sun : Moon;
  return (
    <button
      type="button"
      onClick={toggle}
      className="grid size-9 place-items-center rounded-md border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
      title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
    >
      <Icon className="size-4" />
    </button>
  );
}

function ConnectionPill({ environment }: { environment: ShellEnvironment }) {
  const live = environment.supabaseConfigured;
  return (
    <div className="hidden items-center gap-2 rounded-md border px-2.5 py-1.5 md:flex">
      {live ? <Dot tone="success" pulse /> : <WifiOff className="size-3.5 text-muted-foreground" aria-hidden />}
      <span className="text-[11px] font-medium text-muted-foreground">
        {live ? "Supabase bridge live" : "Supabase bridge closed"}
      </span>
      <span className="text-[11px] text-muted-foreground/60">·</span>
      <span className="font-mono text-[11px] text-muted-foreground">auth: {environment.authProvider}</span>
    </div>
  );
}

export function AdminShell({
  groups,
  user,
  environment,
  children,
}: {
  groups: SidebarGroup[];
  user: ShellUser;
  environment: ShellEnvironment;
  children: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const router = useRouter();
  // Read-only use of the pathname for the breadcrumb. The drawer closes itself —
  // every nav Link calls onCloseMobile and Escape is handled inside the Sidebar —
  // so no pathname-driven state reset is needed.
  const pathname = usePathname();
  const current = findNavItemTitle(pathname);

  async function signOut() {
    setSigningOut(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
      router.replace("/login");
      router.refresh();
    } catch {
      setSigningOut(false);
    }
  }

  const mfaGap = user.mfaRequired === false && user.mfaEnrolled === false;

  return (
    <div className="flex min-h-dvh bg-background">
      <Sidebar
        groups={groups}
        role={user.role}
        collapsed={collapsed}
        onToggleCollapse={() => setCollapsed((v) => !v)}
        mobileOpen={mobileOpen}
        onCloseMobile={() => setMobileOpen(false)}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-3 border-b bg-background/85 px-4 backdrop-blur-md sm:px-6">
          <button
            type="button"
            onClick={() => setMobileOpen(true)}
            className="grid size-9 place-items-center rounded-md border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground lg:hidden"
            aria-label="Open navigation"
          >
            <Menu className="size-4" />
          </button>

          <nav aria-label="Breadcrumb" className="min-w-0 flex-1">
            <ol className="flex items-center gap-2 text-sm">
              <li className="text-muted-foreground">
                <Link href="/dashboard" className="transition-colors hover:text-foreground">
                  Control
                </Link>
              </li>
              <li aria-hidden className="text-muted-foreground/50">
                /
              </li>
              <li className="truncate font-medium" aria-current="page">
                {current}
              </li>
            </ol>
          </nav>

          <ConnectionPill environment={environment} />

          {environment.nodeEnv !== "production" ? (
            <Badge variant="warning" className="hidden font-mono text-[10px] sm:inline-flex">
              {environment.nodeEnv}
            </Badge>
          ) : null}

          <ThemeToggle />

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex items-center gap-2 rounded-md border py-1.5 pr-2 pl-2.5 transition-colors hover:bg-accent"
                aria-label="Account menu"
              >
                <span className="grid size-6 place-items-center rounded-full bg-primary/15 text-[11px] font-semibold text-primary">
                  {(user.displayName ?? user.email).slice(0, 1).toUpperCase()}
                </span>
                <span className="hidden max-w-[160px] truncate text-sm font-medium sm:block">
                  {user.displayName ?? user.email}
                </span>
                <ChevronDown className="size-3.5 text-muted-foreground" aria-hidden />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <DropdownMenuLabel>
                <span className="block truncate text-sm font-medium">{user.email}</span>
                <span className="mt-0.5 block text-xs font-normal text-muted-foreground">
                  Role: {user.role} · MFA: {user.mfaEnrolled ? "enrolled" : "not enrolled"}
                </span>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem asChild>
                <Link href="/security">Security settings</Link>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link href="/audit">My audit trail</Link>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={signOut} disabled={signingOut}>
                <LogOut />
                {signingOut ? "Signing out…" : "Sign out"}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </header>

        {mfaGap ? (
          <div className="flex items-center gap-3 border-b border-warning/30 bg-warning/10 px-4 py-2.5 sm:px-6">
            <ShieldAlert className="size-4 shrink-0 text-warning" aria-hidden />
            <p className="flex-1 text-xs leading-relaxed text-warning">
              Multi-factor authentication is not enrolled for this account. Owner policy requires TOTP MFA
              for every administrator.
            </p>
            <Button asChild size="sm" variant="outline" className={cn("shrink-0 border-warning/40 text-warning")}>
              <Link href="/security#mfa">Enrol now</Link>
            </Button>
          </div>
        ) : null}

        <main className="flex-1 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
          <div className="mx-auto w-full max-w-[1400px] space-y-6">{children}</div>
        </main>

        <footer className="border-t px-4 py-4 text-[11px] leading-relaxed text-muted-foreground sm:px-6 lg:px-8">
          <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
            <p>
              ReplyMate Control · separate administrative platform. No ReplyMate message content is stored
              or displayed here.
            </p>
            <p className="font-mono">
              sync_enabled=false · byok_keys=on-device-only
            </p>
          </div>
        </footer>
      </div>
    </div>
  );
}
