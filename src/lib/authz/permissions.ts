import { capabilities, type Capability } from "@/config/nav";
import { adminRole, type AdminRole } from "@/db/schema";

/**
 * Server-side authorization matrix.
 *
 * This is the ONLY place a role decision is made. UI hiding is cosmetic; every
 * route handler and server component re-checks through `can()` /
 * `assertCapability()`. Roles are ordered owner > admin > operator > support > viewer.
 */

/**
 * `admin` is deliberately NOT the owner: administrator lifecycle management
 * (inviting, suspending, re-rotating admins) and platform security policy are
 * owner-only. Everything else is shared.
 */
const OWNER_ONLY: ReadonlySet<Capability> = new Set<Capability>([
  "users:manage",
  "security:manage",
]);

const matrix: Record<AdminRole, ReadonlySet<Capability>> = {
  owner: new Set(capabilities),
  admin: new Set(capabilities.filter((c) => !OWNER_ONLY.has(c))),
  operator: new Set<Capability>([
    "dashboard:view",
    "devices:view",
    "devices:manage",
    "providers:view",
    "providers:manage",
    "routing:view",
    "routing:manage",
    "usage:view",
    "config:view",
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
    "privacy:view",
    "subscriptions:view",
  ]),
  support: new Set<Capability>([
    "dashboard:view",
    "support:view",
    "support:manage",
    "releases:view",
    "providers:view",
    "routing:view",
    "usage:view",
    "flags:view",
    "monitoring:view",
    "subscriptions:view",
    "config:view",
    "privacy:view",
    "devices:view",
  ]),
  viewer: new Set<Capability>([
    "dashboard:view",
    "providers:view",
    "routing:view",
    "usage:view",
    "releases:view",
    "flags:view",
    "monitoring:view",
    "subscriptions:view",
    "config:view",
    "support:view",
    "privacy:view",
  ]),
};

export function can(role: AdminRole | null | undefined, capability: Capability): boolean {
  if (!role) return false;
  return matrix[role]?.has(capability) ?? false;
}

export function capabilitiesFor(role: AdminRole): Capability[] {
  return capabilities.filter((c) => matrix[role]?.has(c));
}

export function isRole(value: string): value is AdminRole {
  return (adminRole as readonly string[]).includes(value);
}

/** Role precedence — used to stop an admin creating/altering someone above them. */
export const roleRank: Record<AdminRole, number> = {
  owner: 5,
  admin: 4,
  operator: 3,
  support: 2,
  viewer: 1,
};

export function outranks(actor: AdminRole, target: AdminRole): boolean {
  return roleRank[actor] > roleRank[target];
}

export function atLeast(actor: AdminRole, minimum: AdminRole): boolean {
  return roleRank[actor] >= roleRank[minimum];
}

export function describeRole(role: AdminRole): string {
  switch (role) {
    case "owner":
      return "Owner — unrestricted, including administrator lifecycle.";
    case "admin":
      return "Admin — full operational control over configuration and routing.";
    case "operator":
      return "Operator — manages releases, flags, providers and support.";
    case "support":
      return "Support — triages tickets and reads operational state.";
    case "viewer":
      return "Viewer — read-only across operational dashboards.";
  }
}
