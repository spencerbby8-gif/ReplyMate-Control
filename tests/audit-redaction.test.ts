import { describe, expect, it } from "vitest";
import {
  CONTENT_REMOVED,
  REDACTED,
  diffForAudit,
  isSecretLikeKey,
  isSecretLikeValue,
  redactValue,
} from "@/lib/audit/redact";

/**
 * Nothing credential-shaped may reach ctl_audit_log.detail, and no content-shaped
 * field may either — the control plane has no business recording ReplyMate
 * end-user content in the first place.
 */

describe("key classification", () => {
  it.each([
    "password",
    "passwordHash",
    "secret",
    "mfaSecretEnc",
    "token",
    "tokenHash",
    "apiKey",
    "api_key",
    "authorization",
    "cookie",
    "sessionToken",
    "otpCode",
    "totp",
    "pin",
    "privateKey",
    "salt",
    "signature",
  ])("treats %s as secret-like", (key) => {
    expect(isSecretLikeKey(key)).toBe(true);
  });

  it.each(["key", "providerKey", "planKey", "flagKey", "entityId"])("allows the identifier %s through", (key) => {
    expect(isSecretLikeKey(key)).toBe(false);
  });

  it.each(["email", "role", "status", "action", "versionName", "rolloutPercent"])(
    "does not flag the ordinary field %s",
    (key) => {
      expect(isSecretLikeKey(key)).toBe(false);
    },
  );
});

describe("value classification", () => {
  it.each([
    "sk-proj-FIXTURE0000NOTREAL0000",
    "AIzaSyFIXTURE0000NOTREAL0000000000",
    "ghp_FIXTURETOKEN0000000000000NOTREAL",
    "gho_FIXTURETOKEN0000000000000NOTREAL",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig",
    "xoxb-FIXTURE-0000000000-notreal",
    "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
    "postgresql://fixture:notarealpassword@localhost:5432/fixtures",
  ])("recognises %s as a secret", (value) => {
    expect(isSecretLikeValue(value)).toBe(true);
  });

  it.each(["gemini-2.5-flash", "1.5.9", "available", "spencerbby8-gif/ReplyMate"])(
    "does not flag the ordinary value %s",
    (value) => {
      expect(isSecretLikeValue(value)).toBe(false);
    },
  );
});

describe("redaction", () => {
  it("replaces secret-like keys regardless of their value", () => {
    const out = redactValue({ password: "hunter2hunter2", email: "a@b.c" }) as Record<string, unknown>;
    expect(out.password).toBe(REDACTED);
    expect(out.email).toBe("a@b.c");
  });

  it("replaces secret-like values even under an innocent key", () => {
    const out = redactValue({ note: "ghp_FIXTURETOKEN0000000000000NOTREAL" }) as Record<string, unknown>;
    expect(out.note).toBe(REDACTED);
  });

  it("drops content-shaped string fields", () => {
    const out = redactValue({ body: "Hey, are we still on for Friday?", subject: "Reply failed" }) as Record<
      string,
      unknown
    >;
    expect(out.body).toBe(CONTENT_REMOVED);
    expect(out.subject).toBe("Reply failed");
  });

  it("recurses into nested objects and arrays", () => {
    const out = redactValue({
      change: { before: { apiKey: "AIzaSyFIXTURE0000NOTREAL0000000000" }, after: { apiKey: "x" } },
      list: [{ token: "abc" }, { role: "admin" }],
    }) as unknown as Record<string, { before: Record<string, unknown>; after: Record<string, unknown> }>;
    expect(out.change.before.apiKey).toBe(REDACTED);
    expect(out.change.after.apiKey).toBe(REDACTED);
  });

  it("redacts inside arrays too", () => {
    const out = redactValue({ rows: [{ token: "abc" }, { role: "admin" }] }) as {
      rows: Array<Record<string, unknown>>;
    };
    expect(out.rows[0].token).toBe(REDACTED);
    expect(out.rows[1].role).toBe("admin");
  });

  it("truncates long strings and caps array length", () => {
    const long = redactValue("x".repeat(5000)) as string;
    expect(long.length).toBeLessThanOrEqual(241);
    const arr = redactValue(Array.from({ length: 500 }, (_, i) => i)) as number[];
    expect(arr.length).toBe(50);
  });

  it("stops at the depth limit instead of recursing forever", () => {
    let deep: Record<string, unknown> = { leaf: "value" };
    for (let i = 0; i < 20; i += 1) deep = { nested: deep };
    const out = redactValue(deep) as Record<string, unknown>;
    expect(JSON.stringify(out)).toContain("[truncated-depth]");
  });

  it("preserves scalars, booleans and dates", () => {
    expect(redactValue(42)).toBe(42);
    expect(redactValue(true)).toBe(true);
    expect(redactValue(null)).toBe(null);
    const date = new Date("2026-01-01T00:00:00Z");
    expect(redactValue(date)).toBe(date.toISOString());
  });
});

describe("audit diffs", () => {
  it("records only changed keys", () => {
    const diff = diffForAudit(
      { role: "viewer", email: "a@b.c", updatedAt: "2026-01-01" },
      { role: "operator", email: "a@b.c", updatedAt: "2026-01-02" },
    );
    expect(Object.keys(diff)).toEqual(["role"]);
    expect(diff.role).toEqual({ from: "viewer", to: "operator" });
  });

  it("ignores timestamp churn", () => {
    const diff = diffForAudit(
      { createdAt: "a", updatedAt: "b", status: "active" },
      { createdAt: "c", updatedAt: "d", status: "active" },
    );
    expect(diff).toEqual({});
  });

  it("redacts both sides of a secret-shaped change", () => {
    const diff = diffForAudit({ apiKey: "old" }, { apiKey: "new" });
    expect(diff.apiKey).toEqual({ from: REDACTED, to: REDACTED });
  });

  it("drops content from both sides of a diff", () => {
    const diff = diffForAudit({ body: "hello there" }, { body: "goodbye" });
    expect(diff.body).toEqual({ from: CONTENT_REMOVED, to: CONTENT_REMOVED });
  });

  it("returns an empty diff when either side is missing", () => {
    expect(diffForAudit(null, { a: 1 })).toEqual({});
    expect(diffForAudit({ a: 1 }, undefined)).toEqual({});
  });
});
