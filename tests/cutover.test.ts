import { describe, expect, it } from "vitest";
import { evaluateCutover, type CutoverFacts } from "@/lib/supabase/cutover";

/**
 * Cutover preflight policy — exhaustive, offline.
 *
 * The failure mode this guards is severe: flipping AUTH_PROVIDER to `supabase`
 * on a project where self-service sign-up is open would make an
 * invitation-only admin platform publicly registrable, and doing it where MFA is
 * disabled would silently remove a control local mode currently enforces.
 *
 * Every unreadable fact must yield `unknown` and block readiness. A silent pass
 * on missing data is the exact bug class this suite exists to prevent.
 */

const READY: CutoverFacts = {
  hasUrl: true,
  hasPublishableKey: true,
  hasSecretKey: true,
  projectRef: "xdcsxxwhvpiissetbrdr",
  expectedProjectRef: "xdcsxxwhvpiissetbrdr",
  settingsReadable: true,
  disableSignup: true,
  mfaTotpEnrollEnabled: true,
  mfaTotpVerifyEnabled: true,
  emailSignInEnabled: true,
  anonymousSignInEnabled: true,
  googleOAuthEnabled: false,
  authUsersReadable: true,
  totalAuthUsers: 4,
  // 0 anonymous: this fixture must be genuinely warning-free so the "all checks
  // pass" summary is testable. The anonymous-present case is covered separately
  // below, where it is asserted to warn without blocking.
  anonymousAuthUsers: 0,
  emailConfirmedUsers: 4,
  adminRows: 1,
  adminRowsWithSupabaseUserId: 1,
  ownerRows: 1,
  activeAdminRows: 1,
  controlDatabaseSeparate: true,
  encryptionKeyAvailable: true,
  adminInvitePermitted: true,
  currentProvider: "local",
};

const withFacts = (overrides: Partial<CutoverFacts>): CutoverFacts => ({ ...READY, ...overrides });
const check = (id: string, facts: CutoverFacts) =>
  evaluateCutover(facts).checks.find((c) => c.id === id)!;

describe("a fully satisfied project is ready", () => {
  it("reports ready with no blocking checks", () => {
    const verdict = evaluateCutover(READY);
    expect(verdict.ready).toBe(true);
    expect(verdict.blocking).toHaveLength(0);
    expect(verdict.summary).toMatch(/Ready to switch/i);
  });

  it("evaluates every documented precondition", () => {
    const ids = evaluateCutover(READY).checks.map((c) => c.id);
    expect(ids).toEqual([
      "credentials",
      "project-ref",
      "disable-signup",
      "mfa-parity",
      "signable-identity",
      "role-mapping",
      "owner-continuity",
      "anonymous-signin",
      "admin-invite",
      "db-separation",
      "encryption-key",
    ]);
  });

  it("gives every check an id, title, detail and status", () => {
    for (const c of evaluateCutover(READY).checks) {
      expect(c.id.length).toBeGreaterThan(0);
      expect(c.title.length).toBeGreaterThan(5);
      expect(c.detail.length).toBeGreaterThan(5);
      expect(["pass", "fail", "warn", "unknown"]).toContain(c.status);
    }
  });

  it("leaves the action empty for a passing check", () => {
    for (const c of evaluateCutover(READY).checks) {
      if (c.status === "pass") expect(c.action).toBe("");
    }
  });
});

describe("self-service sign-up is the highest-severity block", () => {
  it("blocks when disable_signup is false", () => {
    const verdict = evaluateCutover(withFacts({ disableSignup: false }));
    expect(verdict.ready).toBe(false);
    expect(check("disable-signup", withFacts({ disableSignup: false })).status).toBe("fail");
    expect(verdict.blocking.map((c) => c.id)).toContain("disable-signup");
  });

  it("names the dashboard path in the remediation", () => {
    const c = check("disable-signup", withFacts({ disableSignup: false }));
    expect(c.action).toMatch(/Sign In \/ Up/i);
    expect(c.action).toMatch(/cannot change it/i);
  });

  it("blocks when the setting could not be read", () => {
    // Unknown must never be treated as safe.
    const c = check("disable-signup", withFacts({ disableSignup: null }));
    expect(c.status).toBe("unknown");
    expect(evaluateCutover(withFacts({ disableSignup: null })).ready).toBe(false);
  });
});

describe("MFA parity is a downgrade, not a lateral move", () => {
  it("blocks when TOTP enrolment is disabled", () => {
    const facts = withFacts({ mfaTotpEnrollEnabled: false, mfaTotpVerifyEnabled: false });
    expect(check("mfa-parity", facts).status).toBe("fail");
    expect(evaluateCutover(facts).ready).toBe(false);
  });

  it("blocks when only one half is enabled", () => {
    expect(check("mfa-parity", withFacts({ mfaTotpVerifyEnabled: false })).status).toBe("fail");
    expect(check("mfa-parity", withFacts({ mfaTotpEnrollEnabled: false })).status).toBe("fail");
  });

  it("reports unknown rather than pass when GoTrue omits the keys", () => {
    const facts = withFacts({ mfaTotpEnrollEnabled: null, mfaTotpVerifyEnabled: null });
    expect(check("mfa-parity", facts).status).toBe("unknown");
    expect(evaluateCutover(facts).ready).toBe(false);
  });

  it("says plainly that local mode loses a control", () => {
    const facts = withFacts({ mfaTotpEnrollEnabled: false });
    expect(check("mfa-parity", facts).action).toMatch(/downgrade/i);
  });
});

describe("project identity is verified before anything else", () => {
  it("blocks when the ref does not match the expected project", () => {
    const facts = withFacts({ projectRef: "someotherproject" });
    expect(check("project-ref", facts).status).toBe("fail");
    expect(evaluateCutover(facts).ready).toBe(false);
  });

  it("blocks when the ref could not be resolved", () => {
    const facts = withFacts({ projectRef: null });
    expect(check("project-ref", facts).status).toBe("fail");
  });

  it("is unknown rather than pass when credentials are missing", () => {
    const facts = withFacts({ hasSecretKey: false });
    expect(check("credentials", facts).status).toBe("fail");
    expect(check("project-ref", facts).status).toBe("unknown");
  });

  it("names every missing credential", () => {
    const facts = withFacts({ hasUrl: false, hasSecretKey: false });
    const detail = check("credentials", facts).detail;
    expect(detail).toContain("SUPABASE_PROJECT_URL");
    expect(detail).toContain("SUPABASE_SECRET_KEY");
  });

  it("defaults the expected ref to the ReplyMate project", () => {
    const facts = withFacts({ expectedProjectRef: null });
    expect(check("project-ref", facts).status).toBe("pass");
  });
});

describe("someone must be able to sign in afterwards", () => {
  it("blocks when there are no auth users at all", () => {
    const facts = withFacts({ totalAuthUsers: 0, emailConfirmedUsers: 0, anonymousAuthUsers: 0 });
    expect(check("signable-identity", facts).status).toBe("fail");
  });

  it("passes on confirmed identities", () => {
    expect(check("signable-identity", READY).status).toBe("pass");
  });

  it("is unknown when the user list could not be read", () => {
    const facts = withFacts({ authUsersReadable: false, totalAuthUsers: null, emailConfirmedUsers: null });
    expect(check("signable-identity", facts).status).toBe("unknown");
    expect(evaluateCutover(facts).ready).toBe(false);
  });

  it("blocks when no admin row exists to receive the identity", () => {
    const facts = withFacts({ adminRows: 0, activeAdminRows: 0, adminRowsWithSupabaseUserId: 0 });
    expect(check("role-mapping", facts).status).toBe("fail");
    expect(evaluateCutover(facts).ready).toBe(false);
  });

  it("warns when admin rows exist but none is linked yet", () => {
    const facts = withFacts({ adminRowsWithSupabaseUserId: 0 });
    expect(check("role-mapping", facts).status).toBe("warn");
    // A warning does not by itself block, so the verdict stays switchable.
    expect(evaluateCutover(facts).blocking).toHaveLength(0);
  });

  it("blocks when no owner would survive the cutover", () => {
    const facts = withFacts({ ownerRows: 0 });
    expect(check("owner-continuity", facts).status).toBe("fail");
    expect(check("owner-continuity", facts).action).toMatch(/nobody able to administer/i);
  });
});

describe("anonymous sign-in is tolerated because the app needs it", () => {
  it("warns but does not block when anonymous identities exist", () => {
    const facts = withFacts({ anonymousSignInEnabled: true, anonymousAuthUsers: 1 });
    expect(check("anonymous-signin", facts).status).toBe("warn");
    expect(evaluateCutover(facts).blocking).toHaveLength(0);
  });

  it("explains that disabling it would break ReplyMate guest mode", () => {
    const facts = withFacts({ anonymousSignInEnabled: true, anonymousAuthUsers: 1 });
    expect(check("anonymous-signin", facts).action).toMatch(/guest mode/i);
  });

  it("passes when anonymous sign-in is off", () => {
    expect(check("anonymous-signin", withFacts({ anonymousSignInEnabled: false })).status).toBe("pass");
  });
});

describe("invitation capability fails closed by default", () => {
  it("warns when SUPABASE_ALLOW_ADMIN_INVITE is unset", () => {
    const facts = withFacts({ adminInvitePermitted: false });
    expect(check("admin-invite", facts).status).toBe("warn");
    expect(check("admin-invite", facts).detail).toMatch(/fails closed/i);
  });

  it("tells the operator to enable it only after signup is disabled", () => {
    const facts = withFacts({ adminInvitePermitted: false });
    expect(check("admin-invite", facts).action).toMatch(/once disable-signup passes/i);
  });
});

describe("platform invariants still apply in supabase mode", () => {
  it("blocks when the control-plane database is the Supabase project", () => {
    const facts = withFacts({ controlDatabaseSeparate: false });
    expect(check("db-separation", facts).status).toBe("fail");
    expect(evaluateCutover(facts).ready).toBe(false);
  });

  it("blocks when no encryption key is available", () => {
    const facts = withFacts({ encryptionKeyAvailable: false });
    expect(check("encryption-key", facts).status).toBe("fail");
    expect(evaluateCutover(facts).ready).toBe(false);
  });
});

describe("the verdict is honest about what it could not check", () => {
  it("refuses readiness when any check is unknown", () => {
    const facts = withFacts({ disableSignup: null });
    const verdict = evaluateCutover(facts);
    expect(verdict.ready).toBe(false);
    expect(verdict.summary).toMatch(/could not be evaluated/i);
  });

  it("reports warnings separately from blockers", () => {
    const facts = withFacts({ adminRowsWithSupabaseUserId: 0, adminInvitePermitted: false });
    const verdict = evaluateCutover(facts);
    expect(verdict.blocking).toHaveLength(0);
    expect(verdict.warnings.length).toBeGreaterThanOrEqual(2);
    expect(verdict.summary).toMatch(/warning/i);
  });

  it("says it cannot evaluate at all without credentials", () => {
    const facts = withFacts({ hasUrl: false, hasPublishableKey: false, hasSecretKey: false });
    expect(evaluateCutover(facts).summary).toMatch(/Cannot evaluate/i);
  });

  it("never reports ready when a blocker exists, whatever else passes", () => {
    for (const overrides of [
      { disableSignup: false },
      { mfaTotpEnrollEnabled: false },
      { projectRef: "wrong" },
      { ownerRows: 0 },
      { controlDatabaseSeparate: false },
      { encryptionKeyAvailable: false },
      { adminRows: 0, activeAdminRows: 0 },
    ] as Partial<CutoverFacts>[]) {
      expect(evaluateCutover(withFacts(overrides)).ready, JSON.stringify(overrides)).toBe(false);
    }
  });
});
