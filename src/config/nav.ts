import type { AdminRole } from "@/db/schema";

/**
 * Navigation registry — one source of truth for the sidebar, the route guard
 * and the permission matrix. Adding a page means adding an entry here.
 */

export type NavGroup = {
  label: string;
  items: NavItem[];
};

export type NavItem = {
  title: string;
  href: string;
  /** lucide icon name, resolved in components/layout/sidebar.tsx */
  icon: string;
  description: string;
  /** Roles allowed to see AND load the route. Enforced server-side. */
  roles: AdminRole[];
  capability: Capability;
};

export const capabilities = [
  "dashboard:view",
  "users:view",
  "users:manage",
  "devices:view",
  "devices:manage",
  "providers:view",
  "providers:manage",
  "routing:view",
  "routing:manage",
  "usage:view",
  "subscriptions:view",
  "subscriptions:manage",
  "config:view",
  "config:manage",
  "flags:view",
  "flags:manage",
  "releases:view",
  "releases:manage",
  "monitoring:view",
  "monitoring:run",
  "support:view",
  "support:manage",
  "aiops:use",
  "audit:view",
  "security:view",
  "security:manage",
  "privacy:view",
] as const;

export type Capability = (typeof capabilities)[number];

const ALL: AdminRole[] = ["owner", "admin", "operator", "support", "viewer"];
const MANAGE: AdminRole[] = ["owner", "admin"];
const OPERATE: AdminRole[] = ["owner", "admin", "operator"];

export const navGroups: NavGroup[] = [
  {
    label: "Overview",
    items: [
      {
        title: "Dashboard",
        href: "/dashboard",
        icon: "LayoutDashboard",
        description: "Control-plane health, posture and recent activity.",
        roles: ALL,
        capability: "dashboard:view",
      },
      {
        title: "Monitoring",
        href: "/monitoring",
        icon: "Activity",
        description: "Live probes against provider endpoints and dependencies.",
        roles: ALL,
        capability: "monitoring:view",
      },
    ],
  },
  {
    label: "Access",
    items: [
      {
        title: "Users",
        href: "/users",
        icon: "Users",
        description: "Invitation-only admin accounts and server-side roles.",
        roles: MANAGE,
        capability: "users:view",
      },
      {
        title: "Security",
        href: "/security",
        icon: "ShieldCheck",
        description: "MFA enrolment, active sessions and outstanding invites.",
        roles: MANAGE,
        capability: "security:view",
      },
      {
        title: "Audit log",
        href: "/audit",
        icon: "ScrollText",
        description: "Append-only record of every privileged action.",
        roles: OPERATE,
        capability: "audit:view",
      },
    ],
  },
  {
    label: "Intelligence",
    items: [
      {
        title: "AI providers",
        href: "/ai-providers",
        icon: "Cpu",
        description: "Provider catalogue, dialects and capability bindings.",
        roles: ALL,
        capability: "providers:view",
      },
      {
        title: "Model routing",
        href: "/model-routing",
        icon: "GitBranch",
        description: "Task-to-model policies the client resolves at runtime.",
        roles: ALL,
        capability: "routing:view",
      },
      {
        title: "Usage",
        href: "/usage",
        icon: "BarChart3",
        description: "Aggregate token and request telemetry. Never message text.",
        roles: ALL,
        capability: "usage:view",
      },
      {
        title: "AI operations",
        href: "/ai-ops",
        icon: "Sparkles",
        description: "Assistant that runs real tools against this control plane.",
        roles: OPERATE,
        capability: "aiops:use",
      },
    ],
  },
  {
    label: "Product",
    items: [
      {
        title: "Feature flags",
        href: "/feature-flags",
        icon: "Flag",
        description: "Rollout state for gated client behaviour.",
        roles: ALL,
        capability: "flags:view",
      },
      {
        title: "Releases",
        href: "/releases",
        icon: "Package",
        description: "APK release ledger for the Android client.",
        roles: ALL,
        capability: "releases:view",
      },
      {
        title: "Devices",
        href: "/devices",
        icon: "Smartphone",
        description: "Opt-in device diagnostics. Requires explicit consent.",
        roles: OPERATE,
        capability: "devices:view",
      },
      {
        title: "Subscriptions",
        href: "/subscriptions",
        icon: "CreditCard",
        description: "Plan catalogue and entitlement state.",
        roles: ALL,
        capability: "subscriptions:view",
      },
      {
        title: "Support",
        href: "/support",
        icon: "LifeBuoy",
        description: "Inbound requests and triage queue.",
        roles: ALL,
        capability: "support:view",
      },
    ],
  },
  {
    label: "Platform",
    items: [
      {
        title: "Configuration",
        href: "/configuration",
        icon: "SlidersHorizontal",
        description: "Remote configuration keys served to the client.",
        roles: ALL,
        capability: "config:view",
      },
      {
        title: "Privacy",
        href: "/privacy",
        icon: "Lock",
        description: "The local-first contract this platform is bound by.",
        roles: ALL,
        capability: "privacy:view",
      },
    ],
  },
];

export const navItems: NavItem[] = navGroups.flatMap((g) => g.items);

export function findNavByHref(href: string): NavItem | undefined {
  return navItems.find((i) => i.href === href);
}
