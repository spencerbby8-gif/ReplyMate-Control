import { describe, expect, it } from "vitest";
import {
  NOT_VAULTABLE,
  ROTATING_SECRET_NAME,
  VAULT_PROVIDERS,
  isVaultProvider,
  secretNameFor,
} from "@/lib/vault/provider-keys";
import { MANAGEMENT_PERMISSIONS, PERMISSIONS_NOT_REQUESTED, BOOTSTRAP_VARIABLES, MANAGEMENT_SCOPES } from "@/config/vault-requirements";

/**
 * Provider master-key vault.
 *
 * The invariant under test is absolute: a provider key value must have nowhere to
 * live inside this platform. These tests attack that from every angle — the
 * schema, the secret naming contract shared with the Edge Function, the
 * permission surface actually requested, and the policy rules that keep BYOK and
 * platform AI separate.
 */

describe("secret naming matches the Edge Function contract exactly", () => {
  it("produces {PROVIDER}_MASTER_KEY for the primary slot", () => {
    // supabase/functions/_shared/ai-gateway/keys.ts: secretNamesFor()
    expect(secretNameFor("gemini", "primary")).toBe("GEMINI_MASTER_KEY");
    expect(secretNameFor("anthropic", "primary")).toBe("ANTHROPIC_MASTER_KEY");
    expect(secretNameFor("openai_compat", "primary")).toBe("OPENAI_COMPAT_MASTER_KEY");
  });

  it("produces {PROVIDER}_MASTER_KEY_NEXT for the rotation slot", () => {
    expect(secretNameFor("gemini", "next")).toBe("GEMINI_MASTER_KEY_NEXT");
    expect(secretNameFor("mistral", "next")).toBe("MISTRAL_MASTER_KEY_NEXT");
  });

  it("names the rotating-provider secret the gateway reads", () => {
    // index.ts reads Deno.env.get("GATEWAY_ROTATING_PROVIDERS")
    expect(ROTATING_SECRET_NAME).toBe("GATEWAY_ROTATING_PROVIDERS");
  });

  it("uppercases without introducing a mapping layer", () => {
    for (const provider of VAULT_PROVIDERS) {
      expect(secretNameFor(provider, "primary")).toBe(`${provider.toUpperCase()}_MASTER_KEY`);
      expect(secretNameFor(provider, "next")).toBe(`${provider.toUpperCase()}_MASTER_KEY_NEXT`);
    }
  });
});

describe("the vaultable provider set is exactly what the gateway proxies", () => {
  it("lists the eight proxied providers", () => {
    expect([...VAULT_PROVIDERS].sort()).toEqual(
      ["anthropic", "deepseek", "gemini", "grok", "kimi", "mistral", "openai", "openrouter"].sort(),
    );
  });

  it("excludes the two providers the gateway deliberately does not proxy", () => {
    expect(NOT_VAULTABLE.map((entry) => entry.key).sort()).toEqual(["ollama", "openai_compat"]);
    for (const entry of NOT_VAULTABLE) {
      expect(isVaultProvider(entry.key)).toBe(false);
      expect(entry.reason.length).toBeGreaterThan(20);
    }
  });

  it("gives a real reason for each exclusion, not a placeholder", () => {
    expect(NOT_VAULTABLE.find((e) => e.key === "ollama")?.reason).toMatch(/user's own device/i);
    expect(NOT_VAULTABLE.find((e) => e.key === "openai_compat")?.reason).toMatch(/cannot hold a key/i);
  });

  it("rejects unknown providers", () => {
    expect(isVaultProvider("made_up")).toBe(false);
    expect(isVaultProvider("")).toBe(false);
    expect(isVaultProvider("GEMINI")).toBe(false); // case-sensitive: keys are lowercase
  });

  it("has no overlap between vaultable and excluded sets", () => {
    const excluded = new Set(NOT_VAULTABLE.map((entry) => entry.key));
    for (const provider of VAULT_PROVIDERS) expect(excluded.has(provider)).toBe(false);
  });
});

describe("the metadata schema has no place to put a secret", () => {
  it("defines columns that are all non-secret by construction", async () => {
    const { ctlProviderKey } = await import("@/db/schema");
    const columns = Object.keys(ctlProviderKey);
    // Every column name, asserted so a future migration that adds `value` or
    // `ciphertext` fails this test rather than silently creating a secret store.
    // `enableRLS` is a drizzle table-config flag, not a column. Asserted
    // explicitly so the list stays honest about what it contains.
    expect(columns.sort()).toEqual(
      [
        "createdAt", "disabledAt", "enableRLS", "id", "lastVerifiedAt",
        "lastVerifiedOutcome", "note", "providerKey", "remoteDigest", "rotatedFrom",
        "secretName", "setBy", "slot", "status", "updatedAt", "valueFingerprint",
        "valueLength",
      ].sort(),
    );
  });

  it("has no column named like a secret container", async () => {
    const { ctlProviderKey } = await import("@/db/schema");
    // Broad on purpose: any column whose name mentions a value, key, secret,
    // token, credential, password or ciphertext is suspect. The narrow set of
    // legitimate names is an explicit allowlist, so adding a column that could
    // hold a secret fails here and forces a conscious decision.
    const forbidden = /(value|key|secret|cipher|plain|material|blob|token|credential|password|payload)/i;
    const descriptive = new Set([
      "valueFingerprint", // HMAC digest — identifies a value without containing it
      "valueLength",      // character count — enough to spot a truncated paste
      "providerKey",      // provider IDENTIFIER, e.g. "gemini"
      "secretName",       // the Edge Function secret NAME, which is not a secret
    ]);

    for (const column of Object.keys(ctlProviderKey)) {
      if (descriptive.has(column)) continue;
      expect(forbidden.test(column), `column "${column}" could hold a secret value`).toBe(false);
    }

    // Prove the pattern actually catches offenders, so this test cannot pass
    // vacuously. The first version of this check used a narrower regex that let
    // `keyValue` through — this loop is what caught that.
    for (const bad of [
      "value", "keyValue", "ciphertext", "encryptedKey", "plaintext", "apiKey",
      "secretBlob", "masterKey", "tokenValue", "credential", "password", "keyMaterial",
    ]) {
      expect(forbidden.test(bad), `${bad} must be caught`).toBe(true);
      expect(descriptive.has(bad), `${bad} must not be allowlisted`).toBe(false);
    }
  });

  it("stores a fingerprint and a length, which is all change-detection needs", async () => {
    const { ctlProviderKey } = await import("@/db/schema");
    expect(Object.keys(ctlProviderKey)).toContain("valueFingerprint");
    expect(Object.keys(ctlProviderKey)).toContain("valueLength");
  });

  it("tracks who set a key and what it replaced", async () => {
    const { ctlProviderKey } = await import("@/db/schema");
    const columns = Object.keys(ctlProviderKey);
    expect(columns).toContain("setBy");
    expect(columns).toContain("rotatedFrom");
    expect(columns).toContain("disabledAt");
  });
});

describe("fingerprints identify a key without revealing it", () => {
  it("is deterministic and 16 hex characters", async () => {
    const { secretValueFingerprint } = await import("@/lib/supabase/management");
    const fingerprint = secretValueFingerprint("a-provider-key-value");
    expect(fingerprint).toMatch(/^[a-f0-9]{16}$/);
    expect(secretValueFingerprint("a-provider-key-value")).toBe(fingerprint);
  });

  it("differs for different values", async () => {
    const { secretValueFingerprint } = await import("@/lib/supabase/management");
    expect(secretValueFingerprint("key-a")).not.toBe(secretValueFingerprint("key-b"));
  });

  it("does not contain the value or a recognisable fragment of it", async () => {
    const { secretValueFingerprint } = await import("@/lib/supabase/management");
    const value = "AIzaSyDISTINCTIVEFRAGMENT0000000";
    const fingerprint = secretValueFingerprint(value);
    expect(fingerprint).not.toContain(value);
    expect(fingerprint).not.toContain("DISTINCTIVE");
    expect(value).not.toContain(fingerprint);
  });

  it("is keyed, so a database dump cannot be matched by brute force", async () => {
    const { secretValueFingerprint } = await import("@/lib/supabase/management");
    const { createHash } = await import("node:crypto");
    const value = "a-short-key";
    expect(secretValueFingerprint(value)).not.toBe(
      createHash("sha256").update(value).digest("hex").slice(0, 16),
    );
  });
});

describe("requested permissions are the minimum", () => {
  it("requests exactly the four permissions routine key management needs", () => {
    const required = MANAGEMENT_PERMISSIONS.filter((permission) => permission.required).map((p) => p.name);
    expect(required).toEqual([
      "edge_functions_secrets_read",
      "edge_functions_secrets_write",
      "edge_functions_secrets_write",
      "edge_functions_read",
    ]);
  });

  it("marks deployment permission as optional and separable", () => {
    const deploy = MANAGEMENT_PERMISSIONS.find((p) => p.name === "edge_functions_write");
    expect(deploy?.required).toBe(false);
    expect(deploy?.usedFor).toMatch(/separate token/i);
  });

  it("names the endpoint each permission unlocks", () => {
    for (const permission of MANAGEMENT_PERMISSIONS) {
      expect(permission.endpoint).toMatch(/^(GET|POST|DELETE|PATCH) \/v1\/projects\/\{ref\}\//);
      expect(permission.usedFor.length).toBeGreaterThan(30);
    }
  });

  it("documents the legacy scopes too", () => {
    expect(MANAGEMENT_SCOPES).toContain("secrets:read");
    expect(MANAGEMENT_SCOPES).toContain("secrets:write");
    expect(MANAGEMENT_SCOPES).toContain("edge_functions:read");
  });

  it("explicitly refuses broad permissions, with a reason for each", () => {
    const dangerous = ["projects:write", "database:write", "auth_signing_keys_read / _write", "organization_*"];
    for (const name of dangerous) {
      const entry = PERMISSIONS_NOT_REQUESTED.find((p) => p.name === name);
      expect(entry, `${name} should be listed as not requested`).toBeDefined();
      expect(entry!.reason.length).toBeGreaterThan(20);
    }
  });

  it("does not request anything that could rotate the project's own keys", () => {
    const requested = MANAGEMENT_PERMISSIONS.map((p) => p.name);
    expect(requested.some((name) => name.includes("api_gateway_keys"))).toBe(false);
    expect(requested.some((name) => name.includes("signing_keys"))).toBe(false);
  });
});

describe("bootstrap variables are enumerated", () => {
  it("names the single new credential TASK-012 needs", () => {
    const token = BOOTSTRAP_VARIABLES.find((v) => v.name === "SUPABASE_ACCESS_TOKEN");
    expect(token?.required).toBe(true);
    expect(token?.oneTime).toBe(true);
    expect(token?.source).toMatch(/Access tokens/i);
  });

  it("distinguishes variables already configured from ones the owner must add", () => {
    const alreadyThere = ["SUPABASE_PROJECT_URL", "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SECRET_KEY", "SUPABASE_TRANSACTION_POOLER"];
    for (const name of alreadyThere) {
      const entry = BOOTSTRAP_VARIABLES.find((v) => v.name === name);
      expect(entry, `${name} should be listed`).toBeDefined();
      expect(entry!.source).toMatch(/Already configured/);
    }
    const newOnes = BOOTSTRAP_VARIABLES.filter((v) => v.required && !v.source.match(/Already configured/));
    expect(newOnes.map((v) => v.name)).toEqual(["SUPABASE_ACCESS_TOKEN", "CONTROL_ENC_KEY"]);
  });

  it("gives every variable a purpose and a source", () => {
    for (const variable of BOOTSTRAP_VARIABLES) {
      expect(variable.purpose.length).toBeGreaterThan(20);
      expect(variable.source.length).toBeGreaterThan(5);
    }
  });

  it("states that CONTROL_ENC_KEY has a durable fallback and why to set it anyway", () => {
    const entry = BOOTSTRAP_VARIABLES.find((v) => v.name === "CONTROL_ENC_KEY");
    expect(entry?.purpose).toMatch(/keyfile/);
    expect(entry?.purpose).toMatch(/redeploy/);
  });

  it("flags AUTH_PROVIDER as blocked on the cutover preflight", () => {
    const entry = BOOTSTRAP_VARIABLES.find((v) => v.name === "AUTH_PROVIDER");
    expect(entry?.required).toBe(false);
    expect(entry?.purpose).toMatch(/preflight/i);
  });
});

describe("BYOK and platform AI stay separate", () => {
  it("lists BYOK as always allowed in the policy table", async () => {
    const { ctlProviderPolicy } = await import("@/db/schema");
    expect(Object.keys(ctlProviderPolicy)).toContain("byokAllowed");
    expect(Object.keys(ctlProviderPolicy)).toContain("platformEnabled");
  });

  it("models a spend cap so platform AI cannot be enabled unbounded", async () => {
    const { ctlProviderPolicy } = await import("@/db/schema");
    expect(Object.keys(ctlProviderPolicy)).toContain("dailySpendCapMicroUsd");
  });

  it("excludes the two BYOK-only providers from the vault, preserving today's behaviour", () => {
    // ollama and openai_compat have no platform key by construction, so a user's
    // own local/custom endpoint can never be shadowed by a platform key.
    expect(isVaultProvider("ollama")).toBe(false);
    expect(isVaultProvider("openai_compat")).toBe(false);
  });
});
