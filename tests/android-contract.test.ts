import { describe, expect, it } from "vitest";
import {
  ALWAYS_REFUSED,
  CONSENT,
  CONTRACT_VERSION,
  DELIVERY,
  ENDPOINTS,
  LIMITS,
  MIN_APP_VERSION,
  clientVersionSupported,
  contractSummary,
  permittedFields,
} from "@/lib/ingest/contract";
import { EVENT_KINDS, MAX_BATCH_SIZE, MAX_PAYLOAD_BYTES, MAX_STRING_LENGTH } from "@/lib/ingest/allowlist";
import { MAX_INGEST_PER_MINUTE } from "@/lib/ingest/auth";

/**
 * The Android integration contract.
 *
 * These tests exist so the contract cannot drift from the validator that actually
 * enforces it. A prose document that disagrees with the code is worse than no
 * document, because an implementer trusts it.
 */

describe("the published limits ARE the enforced limits", () => {
  it("matches the allow-list batch cap", () => {
    expect(LIMITS.maxBatchSize).toBe(MAX_BATCH_SIZE);
  });

  it("matches the allow-list payload cap", () => {
    expect(LIMITS.maxPayloadBytes).toBe(MAX_PAYLOAD_BYTES);
  });

  it("matches the allow-list string cap", () => {
    expect(LIMITS.maxStringLength).toBe(MAX_STRING_LENGTH);
  });

  it("matches the device rate limit", () => {
    expect(LIMITS.maxEventsPerMinutePerDevice).toBe(MAX_INGEST_PER_MINUTE);
  });
});

describe("the contract covers every event kind the validator accepts", () => {
  it("lists exactly the kinds the validator permits", () => {
    const fields = permittedFields();
    expect(Object.keys(fields).sort()).toEqual([...EVENT_KINDS].sort());
  });

  it("gives every kind a non-empty field list", () => {
    for (const [kind, fields] of Object.entries(permittedFields())) {
      expect(fields.length, kind).toBeGreaterThan(0);
      for (const field of fields) expect(typeof field).toBe("string");
    }
  });
});

describe("version compatibility is evaluated, not assumed", () => {
  it("accepts the minimum version exactly", () => {
    expect(clientVersionSupported(MIN_APP_VERSION).supported).toBe(true);
  });

  it("accepts a newer version", () => {
    expect(clientVersionSupported("1.8.0").supported).toBe(true);
    expect(clientVersionSupported("2.0.0").supported).toBe(true);
  });

  it("refuses an older version with a reason naming both numbers", () => {
    const result = clientVersionSupported("1.5.9");
    expect(result.supported).toBe(false);
    expect(result.reason).toContain("1.5.9");
    expect(result.reason).toContain(MIN_APP_VERSION);
  });

  it("refuses a client that sends no version rather than assuming compatibility", () => {
    const result = clientVersionSupported(null);
    expect(result.supported).toBe(false);
    expect(result.reason).toMatch(/cannot be evaluated/i);
  });

  it("compares numerically so 1.7.10 beats 1.7.2", () => {
    expect(clientVersionSupported("1.7.10").supported).toBe(true);
    expect(clientVersionSupported("1.7.1").supported).toBe(false);
  });

  it("tolerates a pre-release suffix", () => {
    expect(clientVersionSupported("1.8.0-beta").supported).toBe(true);
  });
});

describe("offline-safe delivery is specified precisely", () => {
  it("queues before sending", () => {
    expect(DELIVERY.queueBeforeSend).toBe(true);
    expect(DELIVERY.maxQueueEntries).toBeGreaterThan(0);
    expect(DELIVERY.overflowPolicy).toBe("drop-oldest");
  });

  it("bounds retries and mirrors the app's existing backoff policy", () => {
    // SPEC §6: 0.5s x 2^n, <=3 retries, jitter. The telemetry path must not
    // invent a second convention.
    expect(DELIVERY.maxRetries).toBe(3);
    expect(DELIVERY.backoff.baseMs).toBe(500);
    expect(DELIVERY.backoff.multiplier).toBe(2);
    expect(DELIVERY.backoff.jitter).toBe(true);
    expect(DELIVERY.backoff.capMs).toBeGreaterThan(DELIVERY.backoff.baseMs);
  });

  it("never retries a payload the server refused on content grounds", () => {
    for (const status of [400, 401, 403, 422]) {
      expect(DELIVERY.nonRetryableStatuses).toContain(status);
      expect(DELIVERY.retryableStatuses).not.toContain(status);
    }
  });

  it("retries transport and throttle statuses", () => {
    for (const status of [429, 500, 502, 503, 504]) {
      expect(DELIVERY.retryableStatuses).toContain(status);
    }
  });

  it("honours Retry-After over the computed backoff", () => {
    expect(DELIVERY.honourRetryAfter).toBe(true);
  });

  it("stops the queue when consent is revoked rather than flushing it", () => {
    expect(DELIVERY.stopOnConsentRevoked).toBe(true);
  });
});

describe("consent cannot be implied", () => {
  it("is required before the first send", () => {
    expect(CONSENT.requiredBeforeFirstSend).toBe(true);
    expect(CONSENT.revocableAtAnyTime).toBe(true);
  });

  it("names the things that must never count as consent", () => {
    expect(CONSENT.neverImpliedBy).toContain("installing the app");
    expect(CONSENT.neverImpliedBy).toContain("signing in");
    expect(CONSENT.neverImpliedBy).toContain("using the notification listener");
  });

  it("drops queued events on revocation instead of flushing them", () => {
    expect(CONSENT.revocationEffect).toMatch(/dropped, not flushed/i);
  });
});

describe("the refusal list is explicit about private data", () => {
  it("names message content, contacts and keys", () => {
    const joined = ALWAYS_REFUSED.join(" ").toLowerCase();
    expect(joined).toMatch(/message bodies/);
    expect(joined).toMatch(/contact names/);
    expect(joined).toMatch(/phone numbers/);
    expect(joined).toMatch(/provider api keys/);
    expect(joined).toMatch(/byok/);
    expect(joined).toMatch(/drafts/);
    expect(joined).toMatch(/stack trace text/);
  });
});

describe("the endpoints a client must call are fully described", () => {
  it("describes ingest, config and health", () => {
    expect(ENDPOINTS.ingest.path).toBe("/api/ingest/events");
    expect(ENDPOINTS.ingest.method).toBe("POST");
    expect(ENDPOINTS.ingest.auth).toMatch(/Bearer/);
    expect(ENDPOINTS.config.path).toBe("/api/client/config");
    expect(ENDPOINTS.config.auth).toMatch(/none/);
    expect(ENDPOINTS.health.path).toBe("/api/health");
  });

  it("documents that a null release means built-in defaults, not an empty config", () => {
    expect(ENDPOINTS.config.note).toMatch(/built-in defaults/i);
  });

  it("lists 426 as a refusal status so a client can detect a version gate", () => {
    expect(ENDPOINTS.ingest.refusalStatuses).toEqual(expect.arrayContaining([400, 401, 403, 422, 426, 429]));
  });

  it("serialises into one summary an implementer can consume", () => {
    const summary = contractSummary();
    expect(summary.contractVersion).toBe(CONTRACT_VERSION);
    expect(summary.minAppVersion).toBe(MIN_APP_VERSION);
    expect(summary.eventKinds).toEqual(EVENT_KINDS);
    expect(Object.keys(summary)).toEqual(
      expect.arrayContaining(["endpoints", "limits", "delivery", "consent", "permittedFields", "alwaysRefused"]),
    );
  });
});
