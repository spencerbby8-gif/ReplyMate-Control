import { describe, expect, it } from "vitest";
import {
  EVENT_KINDS,
  EVENT_KIND_DOCS,
  MAX_BATCH_SIZE,
  MAX_PAYLOAD_BYTES,
  MAX_STRING_LENGTH,
  isDeniedKey,
  screenStringValue,
  validateIngestBatch,
  validateIngestEvent,
} from "@/lib/ingest/allowlist";

/**
 * Telemetry ingestion allow-list.
 *
 * The invariant under test is blunt: it must be impossible to get message
 * content, a contact identity or a credential into `ctl_device_event`, even from
 * a hostile or buggy client. These tests attack the validator directly.
 */

const VALID_PROVIDER_ERROR = {
  kind: "provider_error",
  occurredAt: new Date().toISOString(),
  payload: {
    providerKey: "gemini",
    endpointHost: "generativelanguage.googleapis.com",
    httpStatus: 429,
    errorClass: "rate_limit",
    suggestedFix: "retry_later",
    latencyMs: 812,
    model: "gemini-2.5-flash",
    appVersion: "1.5.9",
    androidApi: 33,
  },
};

const VALID_HEARTBEAT = {
  kind: "heartbeat",
  occurredAt: new Date().toISOString(),
  payload: { appVersion: "1.5.9", androidApi: 33, uptimeMinutes: 42, syncEnabled: false as const },
};

describe("valid events are accepted", () => {
  it("accepts a provider_error shaped like the app's Diagnostics block", () => {
    const result = validateIngestEvent(VALID_PROVIDER_ERROR);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.kind).toBe("provider_error");
      expect(result.payload.httpStatus).toBe(429);
      expect(result.occurredAt).toBeInstanceOf(Date);
    }
  });

  it("accepts a heartbeat", () => {
    expect(validateIngestEvent(VALID_HEARTBEAT).ok).toBe(true);
  });

  it("accepts every documented kind with a minimal valid payload", () => {
    const payloads: Record<string, unknown> = {
      provider_error: VALID_PROVIDER_ERROR.payload,
      listener_state: { granted: true, watchedAppCount: 3, rebindCount: 1, batteryOptimised: false, appVersion: "1.5.9", androidApi: 33 },
      draft_latency: { task: "reply", model: "gemini-2.5-flash", providerKey: "gemini", latencyMs: 900, tokensIn: 1200, tokensOut: 48, outcome: "generated", thinkingLevel: "none", appVersion: "1.5.9" },
      app_crash: { exceptionClass: "java.lang.IllegalStateException", frameCount: 12, topFrameMethod: "DraftService.generate", appVersion: "1.5.9", androidApi: 33 },
      heartbeat: VALID_HEARTBEAT.payload,
    };
    for (const kind of EVENT_KINDS) {
      const result = validateIngestEvent({ kind, occurredAt: null, payload: payloads[kind] });
      expect(result.ok, `${kind} should validate`).toBe(true);
    }
  });

  it("defaults occurredAt to now when the client omits it", () => {
    const before = Date.now();
    const result = validateIngestEvent({ kind: "heartbeat", payload: VALID_HEARTBEAT.payload });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.occurredAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
      expect(result.occurredAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    }
  });

  it("does not flag token COUNTS as credentials", () => {
    // Regression: the substring "token" in tokensIn/tokensOut used to trip the
    // denied-key sweep and reject every draft_latency event.
    expect(isDeniedKey("tokensIn")).toBe(false);
    expect(isDeniedKey("tokensOut")).toBe(false);
    const result = validateIngestEvent({
      kind: "draft_latency",
      payload: { task: "reply", model: null, providerKey: "gemini", latencyMs: 10, tokensIn: 5, tokensOut: 5, outcome: "generated", thinkingLevel: null, appVersion: "1.5.9" },
    });
    expect(result.ok).toBe(true);
  });
});

describe("unknown kinds are rejected, never coerced", () => {
  it.each(["message", "conversation", "custom", "PROVIDER_ERROR", "", "provider-error"])(
    "rejects kind %j",
    (kind) => {
      const result = validateIngestEvent({ kind, payload: VALID_PROVIDER_ERROR.payload });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("unknown_kind");
    },
  );

  it("names the permitted kinds in the refusal", () => {
    const result = validateIngestEvent({ kind: "nope", payload: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      for (const kind of EVENT_KINDS) expect(result.message).toContain(kind);
    }
  });
});

describe("content and identity fields are refused at any depth", () => {
  const attacks: Array<[string, Record<string, unknown>]> = [
    ["message body", { ...VALID_PROVIDER_ERROR.payload, body: "Hey are we still on for Friday?" }],
    ["message text", { ...VALID_PROVIDER_ERROR.payload, text: "Hey are we still on?" }],
    ["contact name", { ...VALID_HEARTBEAT.payload, contact: "Amara" }],
    ["sender", { ...VALID_HEARTBEAT.payload, sender: "Amara" }],
    ["remote key", { ...VALID_HEARTBEAT.payload, remote_key: "1234@s.whatsapp.net" }],
    ["notification key", { ...VALID_HEARTBEAT.payload, notif_key: "0|com.whatsapp|42" }],
    ["draft text", { ...VALID_HEARTBEAT.payload, draft: "Sure, see you then!" }],
    ["prompt snapshot", { ...VALID_HEARTBEAT.payload, prompt: "You ARE me writing..." }],
    ["transcript", { ...VALID_HEARTBEAT.payload, transcript: "voice note text" }],
    ["api key", { ...VALID_HEARTBEAT.payload, apiKey: "AIzaSyFIXTURE0000000000000000" }],
    ["bearer token", { ...VALID_HEARTBEAT.payload, token: "abc" }],
    ["nested one level", { ...VALID_HEARTBEAT.payload, wrapper: { body: "hidden content" } }],
    ["nested in an array", { ...VALID_HEARTBEAT.payload, items: [{ message: "hidden" }] }],
  ];

  it.each(attacks)("refuses %s", (_label, payload) => {
    const kind = "providerKey" in payload ? "provider_error" : "heartbeat";
    const result = validateIngestEvent({ kind, payload });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(["denied_key", "too_deep", "schema_violation", "pii_value"]).toContain(result.code);
  });

  it("reports denied_key specifically for a top-level content field", () => {
    const result = validateIngestEvent({ kind: "heartbeat", payload: { ...VALID_HEARTBEAT.payload, body: "hi" } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("denied_key");
      expect(result.message).toContain("body");
      expect(result.message).toMatch(/never message content/i);
    }
  });

  it("rejects payloads nested deeper than the limit", () => {
    const result = validateIngestEvent({
      kind: "heartbeat",
      payload: { ...VALID_HEARTBEAT.payload, a: { b: { c: { d: 1 } } } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(["too_deep", "schema_violation", "denied_key"]).toContain(result.code);
  });

  it.each([
    "body", "text", "message", "content", "contact", "name", "phone", "email",
    "draft", "reply", "prompt", "summary", "fact", "token", "secret", "apiKey",
    "uri", "url", "path", "remote_key", "notif_key", "sender", "title",
    "address", "location", "transcript", "media", "attachment", "stack", "trace",
    "subject", "raw", "json", "value",
  ])("denies the key %s", (key) => {
    expect(isDeniedKey(key)).toBe(true);
  });

  it("denies keys regardless of case or separator", () => {
    expect(isDeniedKey("MessageBody")).toBe(true);
    expect(isDeniedKey("API_KEY")).toBe(true);
    expect(isDeniedKey("api-key")).toBe(true);
  });
});

describe("value screening catches PII inside an allowed field", () => {
  it("refuses an email address in a string field", () => {
    const result = validateIngestEvent({
      kind: "provider_error",
      payload: { ...VALID_PROVIDER_ERROR.payload, endpointHost: "amara@example.com" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("pii_value");
  });

  it("refuses a WhatsApp deep link", () => {
    const result = validateIngestEvent({
      kind: "provider_error",
      payload: { ...VALID_PROVIDER_ERROR.payload, endpointHost: "https://wa.me/2348012345678" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("pii_value");
  });

  it("refuses a URL carrying a query string (where a key would live)", () => {
    expect(screenStringValue("https://api.example.com/v1?key=abc123")).toBe("url-with-query");
  });

  it("refuses an embedded credential", () => {
    expect(screenStringValue("Bearer AIzaSyFIXTURE0000000000000000")).toBe("google-api-key");
    expect(screenStringValue("sk-FIXTURENOTREAL00000000")).toBe("openai-key");
    expect(screenStringValue("ghp_FIXTURETOKEN0000000000000NOTREAL")).toBe("github-token");
    expect(screenStringValue("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0")).toBe("jwt");
  });

  it("refuses a long hex digest", () => {
    expect(screenStringValue("a".repeat(64))).toBe("long-hex");
  });

  it("refuses an international phone number", () => {
    expect(screenStringValue("+234 801 234 5678")).toBe("international-phone");
  });

  it("accepts ordinary diagnostic strings", () => {
    for (const value of [
      "generativelanguage.googleapis.com",
      "api.anthropic.com",
      "gemini-2.5-flash",
      "claude-sonnet-4-5",
      "1.5.9",
      "java.lang.IllegalStateException",
      "localhost",
    ]) {
      expect(screenStringValue(value), `${value} should be clean`).toBeNull();
    }
  });
});

describe("schema violations are refused, not repaired", () => {
  it("rejects an unexpected field even when every known field is valid", () => {
    const result = validateIngestEvent({
      kind: "heartbeat",
      payload: { ...VALID_HEARTBEAT.payload, extraField: 1 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("schema_violation");
  });

  it("rejects a missing required field", () => {
    const { appVersion: _drop, ...rest } = VALID_HEARTBEAT.payload;
    const result = validateIngestEvent({ kind: "heartbeat", payload: rest });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("schema_violation");
  });

  it("rejects a value outside its enum", () => {
    const result = validateIngestEvent({
      kind: "provider_error",
      payload: { ...VALID_PROVIDER_ERROR.payload, errorClass: "something-invented" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("schema_violation");
  });

  it("rejects an out-of-range number", () => {
    const result = validateIngestEvent({
      kind: "provider_error",
      payload: { ...VALID_PROVIDER_ERROR.payload, httpStatus: 99999 },
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a negative latency", () => {
    const result = validateIngestEvent({
      kind: "provider_error",
      payload: { ...VALID_PROVIDER_ERROR.payload, latencyMs: -1 },
    });
    expect(result.ok).toBe(false);
  });

  it("rejects an over-long string", () => {
    const result = validateIngestEvent({
      kind: "app_crash",
      payload: { exceptionClass: "x".repeat(MAX_STRING_LENGTH + 400), frameCount: 1, topFrameMethod: null, appVersion: "1.5.9", androidApi: null },
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a non-object payload", () => {
    for (const payload of [null, "text", 42, [{ appVersion: "1.5.9" }]]) {
      const result = validateIngestEvent({ kind: "heartbeat", payload });
      expect(result.ok).toBe(false);
    }
  });

  it("rejects an oversized payload BEFORE parsing it against the schema", () => {
    // The byte cap is a cheap early refusal: a hostile client cannot make the
    // validator walk a megabyte of JSON just to be told "unknown field".
    const result = validateIngestEvent({
      kind: "heartbeat",
      payload: { ...VALID_HEARTBEAT.payload, smuggling: "z".repeat(MAX_PAYLOAD_BYTES * 3) },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("too_large");
      expect(result.message).toContain(String(MAX_PAYLOAD_BYTES));
    }
  });

  it("keeps the byte cap above any legitimately valid payload", () => {
    // Every kind must be able to express its largest legal value inside the cap,
    // otherwise the cap would silently reject valid telemetry.
    const largest = validateIngestEvent({
      kind: "app_crash",
      payload: { exceptionClass: "x".repeat(120), frameCount: 1000, topFrameMethod: "y".repeat(80), appVersion: "z".repeat(24), androidApi: 99 },
    });
    expect(largest.ok).toBe(true);
    expect(JSON.stringify(VALID_PROVIDER_ERROR.payload).length).toBeLessThan(MAX_PAYLOAD_BYTES);
    expect(MAX_STRING_LENGTH).toBeGreaterThan(0);
  });
});

describe("the sync self-assertion is enforced", () => {
  it("refuses a heartbeat claiming sync is enabled", () => {
    const result = validateIngestEvent({
      kind: "heartbeat",
      payload: { ...VALID_HEARTBEAT.payload, syncEnabled: true },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("sync_enabled");
      expect(result.message).toMatch(/local-first/i);
    }
  });

  it("types syncEnabled so only false can ever be sent", () => {
    // The schema declares z.literal(false): a client cannot express any other value.
    const result = validateIngestEvent({
      kind: "heartbeat",
      payload: { ...VALID_HEARTBEAT.payload, syncEnabled: "false" },
    });
    expect(result.ok).toBe(false);
  });
});

describe("timestamps are clamped to a sane window", () => {
  it("rejects a far-future timestamp", () => {
    const result = validateIngestEvent({
      kind: "heartbeat",
      occurredAt: new Date(Date.now() + 365 * 86_400_000).toISOString(),
      payload: VALID_HEARTBEAT.payload,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("bad_timestamp");
  });

  it("rejects an ancient timestamp", () => {
    const result = validateIngestEvent({
      kind: "heartbeat",
      occurredAt: "1990-01-01T00:00:00Z",
      payload: VALID_HEARTBEAT.payload,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("bad_timestamp");
  });

  it("rejects an unparseable timestamp", () => {
    const result = validateIngestEvent({
      kind: "heartbeat",
      occurredAt: "not-a-date",
      payload: VALID_HEARTBEAT.payload,
    });
    expect(result.ok).toBe(false);
  });

  it("accepts a small amount of client clock skew", () => {
    const result = validateIngestEvent({
      kind: "heartbeat",
      occurredAt: new Date(Date.now() + 60_000).toISOString(),
      payload: VALID_HEARTBEAT.payload,
    });
    expect(result.ok).toBe(true);
  });
});

describe("batch validation", () => {
  it("accepts a batch of valid events", () => {
    const result = validateIngestBatch([VALID_HEARTBEAT, VALID_PROVIDER_ERROR]);
    expect(result.accepted).toHaveLength(2);
    expect(result.rejected).toHaveLength(0);
    expect(result.ok).toBe(true);
  });

  it("reports per-item rejections without hiding the valid ones", () => {
    const result = validateIngestBatch([
      VALID_HEARTBEAT,
      { kind: "heartbeat", payload: { ...VALID_HEARTBEAT.payload, body: "smuggled" } },
      VALID_PROVIDER_ERROR,
    ]);
    expect(result.accepted).toHaveLength(2);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].index).toBe(1);
    expect(result.rejected[0].code).toBe("denied_key");
    expect(result.ok).toBe(false);
  });

  it("rejects a non-array body", () => {
    const result = validateIngestBatch({ events: [VALID_HEARTBEAT] });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/array/i);
  });

  it("rejects an empty batch", () => {
    expect(validateIngestBatch([]).ok).toBe(false);
  });

  it("rejects an oversized batch", () => {
    const result = validateIngestBatch(Array.from({ length: MAX_BATCH_SIZE + 1 }, () => VALID_HEARTBEAT));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/cap/i);
  });
});

describe("the contract is documented for every kind", () => {
  it("has a purpose and field list per kind", () => {
    for (const kind of EVENT_KINDS) {
      expect(EVENT_KIND_DOCS[kind].purpose.length).toBeGreaterThan(20);
      expect(EVENT_KIND_DOCS[kind].fields.length).toBeGreaterThan(0);
    }
  });

  it("documents that no kind carries message text", () => {
    const allFields = EVENT_KINDS.flatMap((kind) => EVENT_KIND_DOCS[kind].fields);
    for (const field of allFields) {
      expect(isDeniedKey(field), `${field} must not be a denied key`).toBe(false);
    }
  });
});

import { defaultProbeTargets, isLoopback } from "@/lib/monitoring/probes";

describe("loopback probe classification", () => {
  it("recognises every loopback spelling", () => {
    expect(isLoopback("http://localhost:11434/v1")).toBe(true);
    expect(isLoopback("http://127.0.0.1:11434/v1")).toBe(true);
    expect(isLoopback("http://[::1]:11434/v1")).toBe(true);
    expect(isLoopback("http://LOCALHOST:11434/v1")).toBe(true);
  });

  it("does not classify a real host as loopback", () => {
    expect(isLoopback("https://api.openai.com/v1")).toBe(false);
    expect(isLoopback("https://generativelanguage.googleapis.com")).toBe(false);
  });

  it("returns false for an unparseable URL instead of throwing", () => {
    expect(isLoopback("not a url")).toBe(false);
    expect(isLoopback("")).toBe(false);
  });

  it("flags exactly the Ollama target in the default suite", () => {
    const targets = defaultProbeTargets();
    const loopbacks = targets.filter((t) => t.loopback);
    expect(loopbacks.map((t) => t.target)).toEqual(["provider ollama"]);
  });

  it("keeps the loopback target in the suite rather than dropping it", () => {
    // The probe still runs and still reports the real result; the flag only lets
    // the UI explain it. Silently removing the target would hide a genuine
    // misconfiguration on a machine that SHOULD have a local daemon.
    const targets = defaultProbeTargets();
    expect(targets.some((t) => t.target === "provider ollama")).toBe(true);
  });
});
