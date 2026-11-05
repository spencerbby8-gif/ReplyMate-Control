import { describe, expect, it } from "vitest";
import { atLeast, can, capabilitiesFor, describeRole, isRole, outranks, roleRank } from "@/lib/authz/permissions";
import { capabilities, navGroups, navItems } from "@/config/nav";
import { adminRole, type AdminRole } from "@/db/schema";

const ALL_ROLES = adminRole as readonly AdminRole[];

describe("role precedence", () => {
  it("orders owner > admin > operator > support > viewer", () => {
    expect(roleRank.owner).toBeGreaterThan(roleRank.admin);
    expect(roleRank.admin).toBeGreaterThan(roleRank.operator);
    expect(roleRank.operator).toBeGreaterThan(roleRank.support);
    expect(roleRank.support).toBeGreaterThan(roleRank.viewer);
  });

  it("outranks is strict, atLeast is inclusive", () => {
    expect(outranks("owner", "admin")).toBe(true);
    expect(outranks("admin", "admin")).toBe(false);
    expect(atLeast("admin", "admin")).toBe(true);
    expect(atLeast("viewer", "operator")).toBe(false);
  });
});

describe("capability matrix", () => {
  it("gives the owner every capability", () => {
    expect(capabilitiesFor("owner").sort()).toEqual([...capabilities].sort());
  });

  it("withholds administrator lifecycle management from admin", () => {
    expect(can("admin", "users:manage")).toBe(false);
    expect(can("admin", "security:manage")).toBe(false);
    expect(can("owner", "users:manage")).toBe(true);
  });

  it("withholds every write capability from viewer", () => {
    for (const capability of capabilities) {
      if (capability.endsWith(":manage") || capability.endsWith(":run")) {
        expect(can("viewer", capability), `viewer should not hold ${capability}`).toBe(false);
      }
    }
  });

  it("lets support manage tickets but not flags or routing", () => {
    expect(can("support", "support:manage")).toBe(true);
    expect(can("support", "flags:manage")).toBe(false);
    expect(can("support", "routing:manage")).toBe(false);
    expect(can("support", "audit:view")).toBe(false);
  });

  it("lets operator manage flags, routing and releases", () => {
    expect(can("operator", "flags:manage")).toBe(true);
    expect(can("operator", "routing:manage")).toBe(true);
    expect(can("operator", "releases:manage")).toBe(true);
    expect(can("operator", "monitoring:run")).toBe(true);
  });

  it("denies everything for a null or unknown role", () => {
    expect(can(null, "dashboard:view")).toBe(false);
    expect(can(undefined, "dashboard:view")).toBe(false);
  });

  it("describes every role", () => {
    for (const role of ALL_ROLES) {
      expect(describeRole(role).length).toBeGreaterThan(10);
    }
  });

  it("validates role strings", () => {
    expect(isRole("owner")).toBe(true);
    expect(isRole("superuser")).toBe(false);
    expect(isRole("")).toBe(false);
  });
});

describe("navigation registry", () => {
  it("has a unique href and capability per item", () => {
    const hrefs = navItems.map((item) => item.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    const caps = navItems.map((item) => item.capability);
    expect(new Set(caps).size).toBe(caps.length);
  });

  it("covers every surface the product requires", () => {
    const expected = [
      "/dashboard",
      "/users",
      "/security",
      "/audit",
      "/ai-providers",
      "/model-routing",
      "/usage",
      "/ai-ops",
      "/feature-flags",
      "/releases",
      "/devices",
      "/subscriptions",
      "/support",
      "/configuration",
      "/monitoring",
      "/privacy",
    ];
    for (const href of expected) {
      expect(navItems.some((item) => item.href === href), `missing nav entry ${href}`).toBe(true);
    }
  });

  it("gives every role at least one visible page", () => {
    for (const role of ALL_ROLES) {
      const visible = navItems.filter((item) => item.roles.includes(role));
      expect(visible.length, `${role} would see an empty sidebar`).toBeGreaterThan(0);
    }
  });

  it("keeps every group non-empty", () => {
    for (const group of navGroups) {
      expect(group.items.length).toBeGreaterThan(0);
    }
  });

  it("only references capabilities that exist", () => {
    for (const item of navItems) {
      expect(capabilities).toContain(item.capability);
    }
  });

  it("keeps icon names resolvable by the sidebar", () => {
    const known = new Set([
      "LayoutDashboard", "Activity", "Users", "ShieldCheck", "ScrollText", "Cpu",
      "GitBranch", "BarChart3", "Sparkles", "Flag", "Package", "Smartphone",
      "CreditCard", "LifeBuoy", "SlidersHorizontal", "Lock",
    ]);
    for (const item of navItems) {
      expect(known.has(item.icon), `unmapped icon ${item.icon}`).toBe(true);
    }
  });
});
