import { EVENT_KINDS, EVENT_KIND_DOCS, MAX_BATCH_SIZE, MAX_PAYLOAD_BYTES, MAX_STRING_LENGTH } from "./allowlist";
import { MAX_INGEST_PER_MINUTE } from "./auth";

/**
 * The Android ↔ Control integration contract, as data.
 *
 * A prose document and an implementation drift apart; a single machine-readable
 * source cannot. `docs/ANDROID-CONTRACT.md` is generated from these values, and
 * `tests/android-contract.test.ts` fails if the two disagree or if a limit here
 * stops matching the validator that actually enforces it.
 *
 * This module describes what a FUTURE client build must implement. No shipped
 * ReplyMate version sends telemetry yet, and nothing here modifies the Android
 * repository.
 */

export const CONTRACT_VERSION = 1;

/** Minimum app version that may use each endpoint. */
export const MIN_APP_VERSION = "1.7.2";

export const ENDPOINTS = {
  ingest: {
    method: "POST",
    path: "/api/ingest/events",
    auth: "Bearer <device ingest key>",
    contentType: "application/json",
    bodyShape: '{ "events": [ { "kind": "...", "occurredAt": "ISO-8601", "payload": { ... } } ] }',
    successStatuses: [200, 207],
    refusalStatuses: [400, 401, 403, 422, 426, 429],
  },
  config: {
    method: "GET",
    path: "/api/client/config",
    auth: "none (published, non-sensitive values only)",
    query: "?appVersion=1.7.2",
    successStatuses: [200],
    note: "release:null means use the built-in defaults compiled into the app.",
  },
  health: {
    method: "GET",
    path: "/api/health",
    auth: "none",
    successStatuses: [200, 503],
    note: "Liveness and presence-only configuration posture. Contains no secret value.",
  },
} as const;

export const LIMITS = {
  maxBatchSize: MAX_BATCH_SIZE,
  maxPayloadBytes: MAX_PAYLOAD_BYTES,
  maxStringLength: MAX_STRING_LENGTH,
  maxEventsPerMinutePerDevice: MAX_INGEST_PER_MINUTE,
  maxNestingDepth: 2,
} as const;

/**
 * Offline-safe delivery and bounded retries.
 *
 * Modelled on the app's existing resilience policy (SPEC §6: exponential backoff
 * 0.5s × 2ⁿ, ≤3 retries, jitter; offline → queue + banner) so the telemetry path
 * behaves like the generation path instead of inventing a second convention.
 */
export const DELIVERY = {
  /** Persist to the local queue first; a send is always a retry of stored data. */
  queueBeforeSend: true,
  maxQueueEntries: 500,
  /** Oldest entries are dropped first when the queue is full. */
  overflowPolicy: "drop-oldest",
  maxRetries: 3,
  backoff: { baseMs: 500, multiplier: 2, jitter: true, capMs: 8000 },
  /** Statuses that must NOT be retried: the payload itself was refused. */
  nonRetryableStatuses: [400, 401, 403, 422],
  /** Statuses that may be retried after backoff. */
  retryableStatuses: [408, 425, 429, 500, 502, 503, 504],
  /** A 429 carries Retry-After, which must be honoured over the computed backoff. */
  honourRetryAfter: true,
  /** Never retry into a fresh consent state; revocation stops the queue. */
  stopOnConsentRevoked: true,
} as const;

export const CONSENT = {
  requiredBeforeFirstSend: true,
  recordedServerSide: "consent_recorded_at is NOT NULL, so a row cannot exist without it",
  revocableAtAnyTime: true,
  revocationEffect: "Device marked revoked; every ingest key stops authenticating; queued events are dropped, not flushed.",
  neverImpliedBy: ["installing the app", "signing in", "using the notification listener"],
} as const;

/** Fields the client may send, per kind — the authoritative field list. */
export function permittedFields(): Record<string, string[]> {
  return Object.fromEntries(EVENT_KINDS.map((kind) => [kind, EVENT_KIND_DOCS[kind].fields]));
}

/** Fields that are always refused, at any depth, in any kind. */
export const ALWAYS_REFUSED = [
  "message bodies and notification text",
  "conversation history and thread contents",
  "contact names, display names, phone numbers and remote conversation keys",
  "drafts, prompt snapshots and style samples",
  "memory facts and rolling summaries",
  "media URIs, MIME payloads and attachments",
  "provider API keys, vault references and any BYOK material",
  "stack trace text (the exception CLASS and frame count are permitted)",
  "device advertising identifiers and precise location",
] as const;

/**
 * Version compatibility rule.
 *
 * A client older than MIN_APP_VERSION is refused at the endpoint rather than
 * silently mis-parsed, because an older build cannot know the allow-list and
 * would send fields that no longer exist.
 */
export function clientVersionSupported(appVersion: string | null): {
  supported: boolean;
  reason: string;
} {
  if (!appVersion) {
    return {
      supported: false,
      reason: "No app version was sent. Version gating cannot be evaluated, so the request is refused rather than assumed compatible.",
    };
  }
  const parse = (value: string) => value.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const actual = parse(appVersion);
  const required = parse(MIN_APP_VERSION);
  for (let index = 0; index < Math.max(actual.length, required.length); index += 1) {
    const diff = (actual[index] ?? 0) - (required[index] ?? 0);
    if (diff !== 0) {
      return diff > 0
        ? { supported: true, reason: `${appVersion} >= ${MIN_APP_VERSION}` }
        : { supported: false, reason: `${appVersion} < required ${MIN_APP_VERSION}` };
    }
  }
  return { supported: true, reason: `${appVersion} == ${MIN_APP_VERSION}` };
}

/** Everything a client implementer needs, in one serialisable object. */
export function contractSummary() {
  return {
    contractVersion: CONTRACT_VERSION,
    minAppVersion: MIN_APP_VERSION,
    endpoints: ENDPOINTS,
    limits: LIMITS,
    delivery: DELIVERY,
    consent: CONSENT,
    eventKinds: EVENT_KINDS,
    permittedFields: permittedFields(),
    alwaysRefused: ALWAYS_REFUSED,
  };
}
