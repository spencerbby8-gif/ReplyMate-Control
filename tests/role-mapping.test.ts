import { describe, expect, it } from "vitest";
import {
  ROLE_MAPPING_POLICY,
  UNTRUSTED_CLAIMS,
  isAnonymousIdentity,
  requireRoleRow,
} from "@/lib/auth/role-mapping";
import type { AdminRole } from "@/db/schema";

/**
 * Supabase identity → control-plane role mapping.
 *
 * The live audit (TASK-002) found `disable_signup = false` and `anonymous_users`
 * enabled on the production project, with 3 of 4 existing users anonymous. So a
 * Supabase session proves authentication and nothing else. These tests pin the
 * rule that authorization comes only from `ctl_admin`.
 */

const UUID = "05714b90-9dbc-49c1-ae37-2cb7a949f03d";
const ACTIVE = { role: "owner" as AdminRole, status: "active" as const };

describe("a verified Supabase identity is not, by itself, an administrator", () => {
  it("refuses when there is no ctl_admin row", () => {
    const decision = requireRoleRow({
      supabaseUserId: UUID,
      isAnonymous: false,
      adminRow: null,
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.code).toBe("no_admin_row");
      expect(decision.reason).toMatch(/authentication, not authorization/i);
    }
  });

  it("refuses an anonymous identity even if an admin row somehow exists", () => {
    const decision = requireRoleRow({ supabaseUserId: UUID, isAnonymous: true, adminRow: ACTIVE });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.code).toBe("anonymous_identity");
  });

  it("refuses when Supabase returned no user id", () => {
    const decision = requireRoleRow({ supabaseUserId: null, isAnonymous: false, adminRow: ACTIVE });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.code).toBe("no_supabase_user");
  });

  it.each(["invited", "suspended"] as const)("refuses a row with status %s", (status) => {
    const decision = requireRoleRow({
      supabaseUserId: UUID,
      isAnonymous: false,
      adminRow: { role: "owner", status },
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.code).toBe("not_active");
  });
});

describe("a matching active row grants exactly the stored role", () => {
  it.each(["owner", "admin", "operator", "support", "viewer"] as AdminRole[])("maps %s", (role) => {
    const decision = requireRoleRow({
      supabaseUserId: UUID,
      isAnonymous: false,
      adminRow: { role, status: "active" },
    });
    expect(decision.allowed).toBe(true);
    if (decision.allowed) {
      expect(decision.role).toBe(role);
      expect(decision.source).toBe("control-plane-database");
      expect(decision.supabaseUserId).toBe(UUID);
    }
  });

  it("never returns a role that did not come from the database row", () => {
    const decision = requireRoleRow({
      supabaseUserId: UUID,
      isAnonymous: false,
      adminRow: { role: "viewer", status: "active" },
    });
    // A viewer row must not be upgraded, whatever the IdP said.
    if (decision.allowed) expect(decision.role).toBe("viewer");
  });
});

describe("anonymous detection", () => {
  it("flags the explicit is_anonymous boolean", () => {
    expect(isAnonymousIdentity({ is_anonymous: true, email: "a@b.c" })).toBe(true);
  });

  it("flags the anonymous provider in app_metadata", () => {
    expect(isAnonymousIdentity({ email: "a@b.c", app_metadata: { provider: "anonymous" } })).toBe(true);
  });

  it("flags an empty-string email, which is what the live project actually contains", () => {
    // TASK-002 observed users with email === "" and no provider recorded.
    expect(isAnonymousIdentity({ email: "" })).toBe(true);
    expect(isAnonymousIdentity({ email: "   " })).toBe(true);
  });

  it("flags a missing email", () => {
    expect(isAnonymousIdentity({})).toBe(true);
    expect(isAnonymousIdentity({ email: null })).toBe(true);
  });

  it("does not flag a real email identity", () => {
    expect(isAnonymousIdentity({ email: "admin@company.com", is_anonymous: false })).toBe(false);
  });
});

describe("the policy is explicit about which claims are untrusted", () => {
  it("lists every claim that must never be read as authorization", () => {
    for (const claim of ["role", "aud", "app_metadata.role", "user_metadata.role", "is_anonymous"]) {
      expect(UNTRUSTED_CLAIMS).toContain(claim);
    }
  });

  it("publishes the rule set for the UI", () => {
    expect(ROLE_MAPPING_POLICY.length).toBeGreaterThanOrEqual(5);
    expect(ROLE_MAPPING_POLICY.join(" ")).toMatch(/is ever read as authorization/i);
    expect(ROLE_MAPPING_POLICY.join(" ")).toMatch(/ctl_admin/i);
  });
});
