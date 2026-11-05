import { describe, expect, it } from "vitest";
import {
  identityProvider,
  identityStatus,
  localIdentity,
  supabaseIdentity,
  verifyLocal,
} from "@/lib/auth/identity";
import { hashPassword } from "@/lib/auth/crypto";

/**
 * Identity strategy regression suite.
 *
 * The defect this pins: `AUTH_PROVIDER=supabase` was accepted by the environment
 * schema, rendered in the UI and documented in the README, but the login route
 * never branched on it — selecting it silently kept local password auth. A
 * configuration option that does nothing is a dead control, and a dead control on
 * the *identity provider* is a security defect, not a cosmetic one.
 */

describe("strategy selection follows the configuration", () => {
  it("returns the local strategy by default", () => {
    // vitest.config.ts sets AUTH_PROVIDER=local.
    expect(identityProvider().name).toBe("local");
    expect(identityProvider()).toBe(localIdentity);
  });

  it("reports a password store that matches the selected strategy", () => {
    expect(localIdentity.passwordStore).toBe("control-plane-database");
    expect(supabaseIdentity.passwordStore).toBe("supabase-auth");
  });

  it("reports an MFA verifier that matches the selected strategy", () => {
    expect(localIdentity.mfaVerifier).toBe("control-plane-totp");
    expect(supabaseIdentity.mfaVerifier).toBe("supabase-auth-totp");
  });

  it("reports a distinct invitation transport per strategy", () => {
    expect(localIdentity.invitationTransport).toBe("signed-link-from-this-app");
    expect(supabaseIdentity.invitationTransport).toBe("supabase-email");
  });
});

describe("local strategy", () => {
  it("is always configured — it needs no external service", () => {
    const state = localIdentity.isConfigured();
    expect(state.configured).toBe(true);
    expect(state.detail).toMatch(/scrypt/i);
  });

  it("verifies a correct password against a stored hash", async () => {
    const password = "a-genuinely-long-passphrase";
    const hash = await hashPassword(password);
    expect(await verifyLocal(password, hash)).toBe(true);
  }, 20_000);

  it("rejects a wrong password", async () => {
    const hash = await hashPassword("a-genuinely-long-passphrase");
    expect(await verifyLocal("a-different-long-passphrase", hash)).toBe(false);
  }, 20_000);

  it("rejects a null hash rather than treating it as password-less", async () => {
    // An unredeemed invitation has no hash. That must never authenticate.
    expect(await verifyLocal("anything-at-all-1234", null)).toBe(false);
  });

  it("rejects an empty hash", async () => {
    expect(await verifyLocal("anything-at-all-1234", "")).toBe(false);
  });

  it("exposes a hash function so the invite flow can store a credential", async () => {
    expect(typeof localIdentity.hash).toBe("function");
    const hash = await localIdentity.hash!("a-genuinely-long-passphrase");
    expect(hash.startsWith("scrypt$")).toBe(true);
  }, 20_000);

  it("does not send mail — the link is generated locally", async () => {
    const result = await localIdentity.invite("a@b.c", { redirectTo: "https://x.test" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.deliveryNote).toMatch(/no email is sent/i);
  });
});

describe("supabase strategy fails CLOSED when unconfigured", () => {
  it("reports itself unconfigured without URL and publishable key", () => {
    // vitest.config.ts blanks every SUPABASE_* variable so this suite is
    // hermetic: the hosting platform injects real credentials into the process
    // environment, and a test whose result depends on that is not a test.
    const state = supabaseIdentity.isConfigured();
    expect(state.configured).toBe(false);
    expect(state.detail).toMatch(/SUPABASE_PROJECT_URL/);
    expect(state.detail).toMatch(/SUPABASE_PUBLISHABLE_KEY/);
  });

  it("treats a blank credential as absent, not as configured-with-empty-string", () => {
    const previous = { ...process.env };
    process.env.SUPABASE_PROJECT_URL = "https://example.supabase.co";
    process.env.SUPABASE_PUBLISHABLE_KEY = "   ";
    process.env.SUPABASE_SECRET_KEY = "";
    try {
      const state = supabaseIdentity.isConfigured();
      expect(state.configured).toBe(false);
    } finally {
      process.env = previous;
    }
  });

  it("reports configured once real coordinates are present", () => {
    const previous = { ...process.env };
    process.env.SUPABASE_PROJECT_URL = "https://example.supabase.co";
    process.env.SUPABASE_PUBLISHABLE_KEY = "sb_publishable_test_placeholder_value";
    process.env.SUPABASE_SECRET_KEY = "sb_secret_test_placeholder_value";
    try {
      const state = supabaseIdentity.isConfigured();
      expect(state.configured).toBe(true);
      expect(state.detail).toMatch(/invitations available/i);
    } finally {
      process.env = previous;
    }
  });

  it("reports verification available but invitations refused when only the publishable key exists", () => {
    const previous = { ...process.env };
    process.env.SUPABASE_PROJECT_URL = "https://example.supabase.co";
    process.env.SUPABASE_PUBLISHABLE_KEY = "sb_publishable_test_placeholder_value";
    delete process.env.SUPABASE_SECRET_KEY;
    try {
      const state = supabaseIdentity.isConfigured();
      expect(state.configured).toBe(true);
      expect(state.detail).toMatch(/SUPABASE_SECRET_KEY/);
      expect(state.detail).toMatch(/refused/i);
    } finally {
      process.env = previous;
    }
  });

  it("falls back to the legacy NEXT_PUBLIC_ names when the new ones are absent", () => {
    const previous = { ...process.env };
    delete process.env.SUPABASE_PROJECT_URL;
    delete process.env.SUPABASE_PUBLISHABLE_KEY;
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://legacy.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "legacy-anon-placeholder";
    try {
      expect(supabaseIdentity.isConfigured().configured).toBe(true);
    } finally {
      process.env = previous;
    }
  });

  it("exposes the project ref without exposing any key", () => {
    const previous = { ...process.env };
    process.env.SUPABASE_PROJECT_URL = "https://xdcsxxwhvpiissetbrdr.supabase.co";
    process.env.SUPABASE_PUBLISHABLE_KEY = "sb_publishable_test_placeholder_value";
    try {
      const status = identityStatus();
      expect(status.projectRef).toBe("xdcsxxwhvpiissetbrdr");
      expect(JSON.stringify(status)).not.toContain("sb_publishable_test_placeholder_value");
    } finally {
      process.env = previous;
    }
  });

  it("refuses to verify rather than falling back to local hashes", async () => {
    const result = await supabaseIdentity.verify("admin@example.com", "whatever-password");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("provider_unavailable");
      expect(result.reason).toMatch(/refusing to fall back/i);
    }
  });

  it("refuses to invite without the service-role key", async () => {
    const result = await supabaseIdentity.invite("admin@example.com", { redirectTo: "https://x.test/invite" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("provider_unavailable");
  });

  it("never claims to be configured when it is not", () => {
    const status = identityStatus();
    // AUTH_PROVIDER=local in tests, so the reported provider is local and
    // configured. The point of the assertion is that the two fields agree.
    expect(status.provider).toBe("local");
    expect(status.configured).toBe(true);
    expect(status.passwordStore).toBe("control-plane-database");
  });
});

describe("identity status is truthful for the UI", () => {
  it("exposes every field the login page renders", () => {
    const status = identityStatus();
    expect(status).toEqual(
      expect.objectContaining({
        provider: expect.any(String),
        configured: expect.any(Boolean),
        detail: expect.any(String),
        passwordStore: expect.any(String),
        mfaVerifier: expect.any(String),
        invitationTransport: expect.any(String),
        bridgeConfigured: expect.any(Boolean),
      }),
    );
  });

  it("does not leak a credential through any field", () => {
    const status = identityStatus();
    const serialized = JSON.stringify(status);
    expect(serialized).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/);
    expect(serialized).not.toMatch(/sk-[A-Za-z0-9]{10,}/);
    expect(serialized).not.toMatch(/service_role/i);
  });
});
