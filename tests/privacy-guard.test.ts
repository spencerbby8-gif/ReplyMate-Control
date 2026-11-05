import { describe, expect, it } from "vitest";
import {
  PRIVACY_RULES,
  PrivacyViolation,
  assertSafeSelect,
  checkTableAccess,
  isPrivacyViolation,
  privacyInventory,
} from "@/lib/privacy/guard";

/**
 * The local-first contract, expressed as executable assertions.
 *
 * ReplyMate stores everything on the device, keeps SYNC_ENABLED=false (pinned by
 * SupabaseConfigTest in the Android repo) and keeps provider keys in the Android
 * Keystore. If any of these tests fail, the admin platform has grown a path to
 * end-user content and must not ship.
 */

const CONTENT_TABLES = [
  "message",
  "memory_fact",
  "contact_summary",
  "draft",
  "style_profile",
  "app_kv",
  "contact",
  "contact_channel",
];

describe("privacy guard — deny list", () => {
  it.each(CONTENT_TABLES)("denies the content table %s", (table) => {
    const decision = checkTableAccess(table);
    expect(decision.allowed).toBe(false);
  });

  it("denies content tables even when schema-qualified", () => {
    expect(checkTableAccess("public.message").allowed).toBe(false);
    expect(checkTableAccess("PUBLIC.MESSAGE").allowed).toBe(false);
  });

  it("throws a PrivacyViolation rather than returning empty", () => {
    expect(() => assertSafeSelect("message", ["body"])).toThrow(PrivacyViolation);
  });

  it("classifies the violation so the API can return 451", () => {
    try {
      assertSafeSelect("draft", ["reply_text"]);
      throw new Error("expected a throw");
    } catch (error) {
      expect(isPrivacyViolation(error)).toBe(true);
      expect((error as PrivacyViolation).code).toBe("PRIVACY_VIOLATION");
    }
  });
});

describe("privacy guard — allow list", () => {
  it("denies any table that is not explicitly permitted", () => {
    expect(checkTableAccess("some_new_table").allowed).toBe(false);
    expect(checkTableAccess("auth_users").allowed).toBe(false);
    expect(checkTableAccess("").allowed).toBe(false);
  });

  it("permits usage_event with only its non-content columns", () => {
    const decision = checkTableAccess("usage_event");
    expect(decision.allowed).toBe(true);
    if (!decision.allowed) return;
    expect(decision.aggregateOnly).toBe(true);
    expect(decision.columns).toEqual(["ts", "model", "kind", "tokens_in", "tokens_out"]);
    expect(decision.columns).not.toContain("body");
  });

  it("excludes provider_def.key_ref — even a vault label is not needed", () => {
    const decision = checkTableAccess("provider_def");
    expect(decision.allowed).toBe(true);
    if (!decision.allowed) return;
    expect(decision.columns).not.toContain("key_ref");
    expect(() => assertSafeSelect("provider_def", ["type", "key_ref"])).toThrow(PrivacyViolation);
  });

  it("permits the schema migration ledger as row-level data", () => {
    const decision = checkTableAccess("rm_schema_migrations");
    expect(decision.allowed).toBe(true);
    if (!decision.allowed) return;
    expect(decision.aggregateOnly).toBe(false);
    expect(decision.columns).toEqual(["version", "label", "applied_at"]);
  });

  it("rejects columns outside the permitted projection", () => {
    expect(() => assertSafeSelect("usage_event", ["model", "user_id"])).toThrow(PrivacyViolation);
  });

  it("accepts a projection made only of permitted columns", () => {
    expect(() => assertSafeSelect("rm_schema_migrations", ["version", "label", "applied_at"])).not.toThrow();
  });
});

describe("privacy guard — invariants", () => {
  it("keeps message sync off", () => {
    expect(PRIVACY_RULES.messageSyncEnabled).toBe(false);
  });

  it("keeps message bodies and memory facts unreadable", () => {
    expect(PRIVACY_RULES.messageBodiesReadable).toBe(false);
    expect(PRIVACY_RULES.memoryFactsReadable).toBe(false);
  });

  it("stores no provider key server side", () => {
    expect(PRIVACY_RULES.providerKeysStoredServerSide).toBe(false);
  });

  it("does not export end-user PII", () => {
    expect(PRIVACY_RULES.endUserPiiExportable).toBe(false);
  });

  it("exposes an inventory where every allowed table carries a justification", () => {
    const inventory = privacyInventory();
    expect(inventory.allowed.length).toBeGreaterThan(0);
    for (const entry of inventory.allowed) {
      expect(entry.reason.length).toBeGreaterThan(20);
      expect(entry.columns.length).toBeGreaterThan(0);
    }
    expect(inventory.denied.map((d) => d.table).sort()).toEqual([...CONTENT_TABLES].sort());
  });
});
