import { describe, expect, it } from "vitest";
import {
  ESCALATION_POLICY,
  authorizeAdminChange,
  type AdminChangeSubject,
} from "@/lib/authz/escalation";
import type { AdminRole } from "@/db/schema";

/**
 * Administrator escalation matrix.
 *
 * Table-driven on purpose: every row is a real decision the product must get
 * right, and the function under test is the SAME one the `admin:update` executor
 * calls, so the tests cannot drift from the API.
 */

const OWNER = "own-1";
const ADMIN = "adm-1";
const OPERATOR = "op-1";
const SUPPORT = "sup-1";
const VIEWER = "view-1";

const ACTORS: Record<string, { id: string; role: AdminRole }> = {
  owner: { id: OWNER, role: "owner" },
  admin: { id: ADMIN, role: "admin" },
  operator: { id: OPERATOR, role: "operator" },
  support: { id: SUPPORT, role: "support" },
  viewer: { id: VIEWER, role: "viewer" },
};

function subject(id: string, role: AdminRole, status: "invited" | "active" | "suspended" = "active"): AdminChangeSubject {
  return { id, role, status };
}

describe("self-protection", () => {
  it("an owner may not suspend themselves", () => {
    const decision = authorizeAdminChange(ACTORS.owner, subject(OWNER, "owner"), { status: "suspended" });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.code).toBe("self_action");
      expect(decision.selfAction).toBe(true);
    }
  });

  it("an admin may not suspend themselves", () => {
    const decision = authorizeAdminChange(ACTORS.admin, subject(ADMIN, "admin"), { status: "suspended" });
    expect(decision.allowed).toBe(false);
  });

  it("an owner may not demote themselves", () => {
    const decision = authorizeAdminChange(ACTORS.owner, subject(OWNER, "owner"), { role: "viewer" });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.code).toBe("self_action");
  });

  it("an account may reactivate itself", () => {
    const decision = authorizeAdminChange(ACTORS.admin, subject(ADMIN, "admin", "suspended"), { status: "active" });
    expect(decision.allowed).toBe(true);
  });

  it("an account may require MFA on itself", () => {
    const decision = authorizeAdminChange(ACTORS.admin, subject(ADMIN, "admin"), { mfaRequired: true });
    expect(decision.allowed).toBe(true);
  });
});

describe("rank over the target", () => {
  const cases: Array<[string, AdminRole, AdminRole, boolean, string]> = [
    ["owner changes admin", "owner", "admin", true, "strictly above"],
    ["owner changes operator", "owner", "operator", true, "strictly above"],
    ["owner changes viewer", "owner", "viewer", true, "strictly above"],
    ["admin changes operator", "admin", "operator", true, "strictly above"],
    ["admin changes support", "admin", "support", true, "strictly above"],
    ["operator changes support", "operator", "support", true, "strictly above"],
    ["admin changes admin", "admin", "admin", false, "equal rank"],
    ["operator changes operator", "operator", "operator", false, "equal rank"],
    ["support changes viewer", "support", "viewer", true, "support rank 2 outranks viewer rank 1; users:manage is owner-only, so this is defence in depth"],
    ["viewer changes viewer", "viewer", "viewer", false, "equal rank"],
    ["operator changes admin", "operator", "admin", false, "below rank"],
    ["support changes owner", "support", "owner", false, "far below rank"],
  ];

  it.each(cases)("%s -> %s", (_label, actorRole, targetRole, allowed, _why) => {
    const actor = ACTORS[actorRole];
    const target = subject(`target-${targetRole}`, targetRole);
    const decision = authorizeAdminChange(actor, target, { status: "suspended" });
    expect(decision.allowed, `${actorRole} suspending ${targetRole}`).toBe(allowed);
  });
});

describe("owner accounts are not modifiable by another owner", () => {
  it("refuses a second owner editing the first", () => {
    const decision = authorizeAdminChange(ACTORS.owner, subject("owner-2", "owner"), { status: "suspended" });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.code).toBe("owner_only");
      expect(decision.touchesOwner).toBe(true);
    }
  });

  it("refuses an admin editing an owner", () => {
    const decision = authorizeAdminChange(ACTORS.admin, subject("owner-2", "owner"), { mfaRequired: true });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.code).toBe("owner_only");
  });
});

describe("rank over the role being granted", () => {
  const grants: Array<[string, AdminRole, AdminRole, boolean]> = [
    ["owner grants owner", "owner", "owner", false],
    ["owner grants admin", "owner", "admin", true],
    ["owner grants operator", "owner", "operator", true],
    ["owner grants viewer", "owner", "viewer", true],
    ["admin grants admin", "admin", "admin", false],
    ["admin grants operator", "admin", "operator", true],
    ["admin grants support", "admin", "support", true],
    ["operator grants operator", "operator", "operator", false],
    ["operator grants support", "operator", "support", true],
    ["support grants viewer", "support", "viewer", true],
    ["viewer grants viewer", "viewer", "viewer", false],
  ];

  it.each(grants)("%s", (_label, actorRole, grantedRole, allowed) => {
    const actor = ACTORS[actorRole];
    // Target is strictly below the actor so the rank-over-target rule passes and
    // only the grant rule is under test.
    const targetRole: AdminRole = actorRole === "owner" ? "admin" : actorRole === "admin" ? "operator" : "viewer";
    const decision = authorizeAdminChange(actor, subject("t-1", targetRole), { role: grantedRole });
    expect(decision.allowed, `${actorRole} granting ${grantedRole}`).toBe(allowed);
  });

  it("refuses to grant owner to anyone but an owner", () => {
    for (const role of ["admin", "operator", "support", "viewer"] as AdminRole[]) {
      const decision = authorizeAdminChange(ACTORS[role], subject("t-1", "viewer"), { role: "owner" });
      expect(decision.allowed, `${role} granting owner`).toBe(false);
      if (!decision.allowed) expect(decision.code).toBe("owner_only");
    }
  });

  it("treats a no-op role change as permitted (not an escalation)", () => {
    const decision = authorizeAdminChange(ACTORS.admin, subject("t-1", "operator"), { role: "operator" });
    expect(decision.allowed).toBe(true);
  });
});

describe("malformed requests", () => {
  it("refuses an empty change set", () => {
    const decision = authorizeAdminChange(ACTORS.owner, subject(ADMIN, "admin"), {});
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.code).toBe("no_change");
  });
});

describe("policy is published for the UI", () => {
  it("states every rule the code enforces", () => {
    expect(ESCALATION_POLICY.length).toBeGreaterThanOrEqual(5);
    expect(ESCALATION_POLICY.join(" ")).toMatch(/cannot suspend your own/i);
    expect(ESCALATION_POLICY.join(" ")).toMatch(/strictly below/i);
    expect(ESCALATION_POLICY.join(" ")).toMatch(/owner/i);
    expect(ESCALATION_POLICY.join(" ")).toMatch(/revokes all of its sessions/i);
  });
});
