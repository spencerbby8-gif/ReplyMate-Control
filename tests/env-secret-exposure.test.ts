import { describe, expect, it } from "vitest";
import { assertNoSecretInPublicVars, envReport } from "@/config/env";

/**
 * A secret behind a `NEXT_PUBLIC_*` name is inlined into the browser bundle at
 * build time and published to every visitor. The mistake is invisible in review
 * and the application still runs, so it is enforced at module import instead.
 *
 * These tests pin the boundary between what MUST be refused and what is public
 * by design — getting either side wrong is a real defect.
 */

const ANON_JWT = `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ role: "anon" })).toString("base64")}.sig`;
const SERVICE_JWT = `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ role: "service_role" })).toString("base64")}.sig`;

describe("correct configurations are accepted", () => {
  it("accepts a publishable URL and publishable key", () => {
    expect(() =>
      assertNoSecretInPublicVars({
        NEXT_PUBLIC_SUPABASE_URL: "https://xdcsxxwhvpiissetbrdr.supabase.co",
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_abcdef0123456789",
      }),
    ).not.toThrow();
  });

  it("accepts a legacy anon-role JWT, which is public by design", () => {
    // The ReplyMate Android app embeds the anon key; docs/supabase/README.md
    // states the database is guarded by RLS, not by key secrecy.
    expect(() => assertNoSecretInPublicVars({ NEXT_PUBLIC_SUPABASE_ANON_KEY: ANON_JWT })).not.toThrow();
  });

  it("accepts secrets held in non-prefixed variables", () => {
    expect(() =>
      assertNoSecretInPublicVars({
        SUPABASE_SECRET_KEY: "sb_secret_AbCdEfGhIjKlMnOpQrStUvWxYz",
        SUPABASE_TRANSACTION_POOLER: "postgresql://fixture:notarealpassword@invalid.example:6543/postgres",
        DATABASE_URL: "postgresql://fixture:notarealpassword@invalid.example:5432/app_db",
      }),
    ).not.toThrow();
  });

  it("accepts an empty or absent environment", () => {
    expect(() => assertNoSecretInPublicVars({})).not.toThrow();
    expect(() => assertNoSecretInPublicVars({ NEXT_PUBLIC_SITE_NAME: "" })).not.toThrow();
  });
});

describe("secret material behind NEXT_PUBLIC_ is refused", () => {
  it.each([
    ["current Supabase secret key", { NEXT_PUBLIC_SB: "sb_secret_AbCdEfGhIjKlMnOpQrStUvWxYz" }],
    ["OpenAI-shaped key", { NEXT_PUBLIC_AI: "sk-FIXTURENOTREAL000000000000" }],
    ["Supabase management token", { NEXT_PUBLIC_MGMT: "sbp_FIXTURENOTREAL00000000" }],
    ["GitHub token", { NEXT_PUBLIC_GH: "ghp_FIXTURETOKEN0000000000000NOTREAL" }],
    ["Slack token", { NEXT_PUBLIC_SLACK: "xoxb-FIXTURE-0000000000-notreal" }],
  ])("refuses a %s", (_label, vars) => {
    expect(() => assertNoSecretInPublicVars(vars)).toThrow(/NEXT_PUBLIC_\*/);
  });

  it("refuses a service_role JWT even though the anon JWT is allowed", () => {
    expect(() => assertNoSecretInPublicVars({ NEXT_PUBLIC_SUPABASE_ANON_KEY: SERVICE_JWT })).toThrow(
      /service_role/,
    );
  });

  it("decodes the role claim rather than rejecting every JWT", () => {
    expect(() => assertNoSecretInPublicVars({ NEXT_PUBLIC_K: ANON_JWT })).not.toThrow();
    expect(() => assertNoSecretInPublicVars({ NEXT_PUBLIC_K: SERVICE_JWT })).toThrow();
  });

  it("survives a malformed JWT without throwing the wrong error", () => {
    expect(() => assertNoSecretInPublicVars({ NEXT_PUBLIC_K: "eyJ.notbase64!!!" })).not.toThrow();
    expect(() => assertNoSecretInPublicVars({ NEXT_PUBLIC_K: "eyJhbGci" })).not.toThrow();
  });
});

describe("the failure message is actionable and leaks nothing", () => {
  it("names every offending variable, not just the first", () => {
    try {
      assertNoSecretInPublicVars({
        NEXT_PUBLIC_A: "sb_secret_AbCdEfGhIjKlMnOpQrStUvWxYz",
        NEXT_PUBLIC_B: "sbp_FIXTURENOTREAL00000000",
        NEXT_PUBLIC_SAFE: "https://xdcsxxwhvpiissetbrdr.supabase.co",
      });
      throw new Error("expected a throw");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("NEXT_PUBLIC_A");
      expect(message).toContain("NEXT_PUBLIC_B");
      expect(message).not.toContain("NEXT_PUBLIC_SAFE");
    }
  });

  it("never prints the secret value", () => {
    const secret = "sb_secret_AbCdEfGhIjKlMnOpQrStUvWxYz";
    try {
      assertNoSecretInPublicVars({ NEXT_PUBLIC_LEAK: secret });
      throw new Error("expected a throw");
    } catch (error) {
      expect((error as Error).message).not.toContain(secret);
      expect((error as Error).message).not.toContain("AbCdEfGh");
    }
  });

  it("de-duplicates a variable reported twice", () => {
    try {
      assertNoSecretInPublicVars({ NEXT_PUBLIC_A: "sb_secret_AbCdEfGhIjKlMnOpQrStUvWxYz" });
      throw new Error("expected a throw");
    } catch (error) {
      const message = (error as Error).message;
      expect(message.split("NEXT_PUBLIC_A").length - 1).toBe(1);
    }
  });

  it("says what to do instead", () => {
    try {
      assertNoSecretInPublicVars({ NEXT_PUBLIC_A: "sb_secret_AbCdEfGhIjKlMnOpQrStUvWxYz" });
      throw new Error("expected a throw");
    } catch (error) {
      expect((error as Error).message).toMatch(/non-prefixed variable/);
    }
  });
});

describe("the live environment report exposes presence only", () => {
  it("contains no secret value in any field", () => {
    const serialized = JSON.stringify(envReport());
    expect(serialized).not.toMatch(/sb_secret_[A-Za-z0-9]/);
    expect(serialized).not.toMatch(/sb_publishable_[A-Za-z0-9]{8}/);
    expect(serialized).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/);
    expect(serialized).not.toMatch(/postgres(ql)?:\/\/[^"]*:[^"]*@/);
  });

  it("reports found variables by NAME only", () => {
    const report = envReport();
    const names = (report.supabase as { variablesPresent?: string[] }).variablesPresent ?? [];
    for (const name of names) {
      expect(name).toMatch(/^(SUPABASE_|NEXT_PUBLIC_SUPABASE_)/);
      expect(name).not.toMatch(/=/);
    }
  });

  it("identifies the key format without revealing the key", () => {
    const report = envReport();
    expect(["publishable-secret", "anon-service_role", "none", undefined]).toContain(
      (report.supabase as { keyFormat?: string }).keyFormat,
    );
  });
});
