import { z } from "zod";

/**
 * Allow-listed telemetry ingestion.
 *
 * This is the ONLY door through which anything reaches `ctl_device_event`, and it
 * is built to make a privacy breach structurally impossible rather than unlikely:
 *
 *   1. **Closed kind set.** An event must name one of five kinds. Unknown kinds
 *      are rejected, not coerced.
 *   2. **Exact field schema per kind.** `z.strictObject` — an unexpected field is
 *      a rejection, not a passthrough. There is no free-form payload column.
 *   3. **Recursive denied-key sweep.** Even inside a permitted numeric wrapper, a
 *      key shaped like content or identity is rejected at any depth.
 *   4. **Value screening.** Strings are checked for phone-number, email, URL and
 *      secret shapes. A provider *error class* is allowed; a provider *error
 *      body* is not, because bodies echo request material.
 *   5. **Bounded everything.** String lengths, numeric ranges, payload size and
 *      batch size all have hard caps.
 *
 * What the app may legitimately report is modelled on ReplyMate's own Diagnostics
 * blocks (added in 0.7.0): provider, endpoint, model, status, provider-said,
 * ReplyMate-read, suggested fix. Those were designed to be shareable and contain
 * no message text. Nothing here invents a richer channel than that.
 */

// ---------------------------------------------------------------------------
// Denied keys — content and identity shapes, at any depth
// ---------------------------------------------------------------------------

const DENIED_KEY =
  /(body|text|message|content|contact|name|phone|email|draft|reply|prompt|summary|fact|token|secret|api[_-]?key|uri|url|path|remote[_-]?key|notif[_-]?key|sender|title|address|location|transcript|media|attachment|stack|trace|subject|label|note|comment|description|payload|raw|json|value)/i;

/**
 * Keys that are legitimately needed and would otherwise be caught by the sweep
 * above. Each one is justified: they are enums or counters, never free text.
 */
const DENIED_KEY_OVERRIDES = new Set([
  "kind", // the event discriminator itself
  "errorClass", // a closed enum, not a message
  "suggestedFix", // a closed enum, not free text
  "appVersion", // semver
  // Token COUNTS are telemetry; token TEXT is not. Without these two the sweep
  // would reject every draft_latency event on the substring "token".
  "tokensIn",
  "tokensOut",
]);

export function isDeniedKey(key: string): boolean {
  if (DENIED_KEY_OVERRIDES.has(key)) return false;
  return DENIED_KEY.test(key);
}

// ---------------------------------------------------------------------------
// Value screening
// ---------------------------------------------------------------------------

const PII_VALUE_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: "email", pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  { name: "international-phone", pattern: /\+\d[\d\s().-]{8,}\d/ },
  { name: "local-phone", pattern: /\b0\d{2,3}[\s-]?\d{3}[\s-]?\d{3,4}\b/ },
  { name: "url-with-query", pattern: /https?:\/\/[^\s]+\?[^\s]+/i },
  { name: "wa-or-tg-deeplink", pattern: /\b(?:wa\.me|t\.me|tg:\/\/|whatsapp:|https:\/\/chat\.)/i },
  { name: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{20,}/ },
  { name: "openai-key", pattern: /\bsk-[A-Za-z0-9_-]{16,}/ },
  { name: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  { name: "long-base32", pattern: /\b[A-Z2-7]{24,}={0,6}\b/ },
  { name: "bearer-token", pattern: /\bbearer\s+[A-Za-z0-9._-]{10,}/i },
  { name: "long-hex", pattern: /\b[a-f0-9]{40,}\b/i },
];

export function screenStringValue(value: string): string | null {
  for (const { name, pattern } of PII_VALUE_PATTERNS) {
    if (pattern.test(value)) return name;
  }
  return null;
}

export const MAX_STRING_LENGTH = 64;
export const MAX_PAYLOAD_BYTES = 2048;
export const MAX_BATCH_SIZE = 25;
export const MAX_DEPTH = 2;

// ---------------------------------------------------------------------------
// Per-kind schemas — closed field sets
// ---------------------------------------------------------------------------

const boundedString = (max = MAX_STRING_LENGTH) => z.string().min(1).max(max);

const ERROR_CLASS = [
  "auth",
  "quota",
  "rate_limit",
  "model_unavailable",
  "model_deprecated",
  "bad_request",
  "server_error",
  "network",
  "timeout",
  "truncated_response",
  "unknown",
] as const;

const SUGGESTED_FIX = [
  "check_key",
  "billing_required",
  "switch_model",
  "retry_later",
  "reduce_context",
  "update_app",
  "none",
] as const;

const TASK_KIND = ["reply", "background", "summary", "extract", "style"] as const;

export const EVENT_SCHEMAS = {
  /** A provider call failed. Mirrors the app's Diagnostics block, minus any body. */
  provider_error: z.strictObject({
    providerKey: boundedString(32),
    endpointHost: boundedString(120),
    httpStatus: z.number().int().min(0).max(599).nullable(),
    errorClass: z.enum(ERROR_CLASS),
    suggestedFix: z.enum(SUGGESTED_FIX),
    latencyMs: z.number().int().min(0).max(600_000).nullable(),
    model: boundedString(64).nullable(),
    appVersion: boundedString(24),
    androidApi: z.number().int().min(1).max(99).nullable(),
  }),

  /** Notification-listener health. Counts and booleans only. */
  listener_state: z.strictObject({
    granted: z.boolean(),
    watchedAppCount: z.number().int().min(0).max(100),
    rebindCount: z.number().int().min(0).max(10_000),
    batteryOptimised: z.boolean().nullable(),
    appVersion: boundedString(24),
    androidApi: z.number().int().min(1).max(99).nullable(),
  }),

  /** Generation performance. Token COUNTS are telemetry; token TEXT is not. */
  draft_latency: z.strictObject({
    task: z.enum(TASK_KIND),
    model: boundedString(64).nullable(),
    providerKey: boundedString(32),
    latencyMs: z.number().int().min(0).max(600_000),
    tokensIn: z.number().int().min(0).max(2_000_000),
    tokensOut: z.number().int().min(0).max(2_000_000),
    outcome: z.enum(["generated", "empty", "truncated", "error", "skipped"]),
    thinkingLevel: z.enum(["none", "low", "high"]).nullable(),
    appVersion: boundedString(24),
  }),

  /** A crash. The exception CLASS and frame count — never the stack text. */
  app_crash: z.strictObject({
    exceptionClass: boundedString(120),
    frameCount: z.number().int().min(0).max(1000),
    topFrameMethod: boundedString(80).nullable(),
    appVersion: boundedString(24),
    androidApi: z.number().int().min(1).max(99).nullable(),
  }),

  /** Liveness. The smallest possible signal. */
  heartbeat: z.strictObject({
    appVersion: boundedString(24),
    androidApi: z.number().int().min(1).max(99).nullable(),
    uptimeMinutes: z.number().int().min(0).max(10_000_000),
    // Deliberately z.boolean(), not z.literal(false): a device that reports
    // true must be refused with the specific `sync_enabled` code below, not with
    // a generic schema error that hides a product-level emergency.
    syncEnabled: z.boolean(),
  }),
} as const;

export type EventKind = keyof typeof EVENT_SCHEMAS;
export const EVENT_KINDS = Object.keys(EVENT_SCHEMAS) as EventKind[];

/** What each kind is for, shown on the Devices page so the contract is visible. */
export const EVENT_KIND_DOCS: Record<EventKind, { purpose: string; fields: string[] }> = {
  provider_error: {
    purpose: "Why a provider call failed, in the shape the app's own Diagnostics block already produces.",
    fields: Object.keys(EVENT_SCHEMAS.provider_error.shape),
  },
  listener_state: {
    purpose: "Whether the notification listener is connected, and how often it had to rebind.",
    fields: Object.keys(EVENT_SCHEMAS.listener_state.shape),
  },
  draft_latency: {
    purpose: "How long generation took and how many tokens it used. Counts, never text.",
    fields: Object.keys(EVENT_SCHEMAS.draft_latency.shape),
  },
  app_crash: {
    purpose: "Crash classification. The exception class and frame count, never the stack trace text.",
    fields: Object.keys(EVENT_SCHEMAS.app_crash.shape),
  },
  heartbeat: {
    purpose: "Liveness, plus an assertion that sync is still off on the reporting device.",
    fields: Object.keys(EVENT_SCHEMAS.heartbeat.shape),
  },
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type IngestEventInput = { kind: string; occurredAt?: string | number | null; payload: unknown };

export type IngestValidation =
  | { ok: true; kind: EventKind; payload: Record<string, unknown>; occurredAt: Date }
  | { ok: false; code: IngestErrorCode; message: string; kind?: string };

export type IngestErrorCode =
  | "unknown_kind"
  | "denied_key"
  | "pii_value"
  | "schema_violation"
  | "too_large"
  | "too_deep"
  | "bad_timestamp"
  | "sync_enabled";

/** Clock-skew window for a client-reported timestamp. */
const MAX_FUTURE_MS = 5 * 60_000;
const MAX_PAST_MS = 30 * 86_400_000;

function sweepKeys(value: unknown, depth: number): string | null {
  if (depth > MAX_DEPTH) return "too_deep";
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = sweepKeys(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (isDeniedKey(key)) return `denied_key:${key}`;
      const found = sweepKeys(child, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function sweepStringValues(value: unknown, depth: number): string | null {
  if (depth > MAX_DEPTH) return null;
  if (typeof value === "string") return screenStringValue(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = sweepStringValues(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) {
      const found = sweepStringValues(child, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function resolveTimestamp(raw: string | number | null | undefined): Date | null {
  const now = Date.now();
  if (raw === null || raw === undefined) return new Date(now);
  const ms = typeof raw === "number" ? raw : Date.parse(raw);
  if (!Number.isFinite(ms)) return null;
  if (ms > now + MAX_FUTURE_MS) return null;
  if (ms < now - MAX_PAST_MS) return null;
  return new Date(ms);
}

export function validateIngestEvent(input: IngestEventInput): IngestValidation {
  const kind = input.kind;

  if (!EVENT_KINDS.includes(kind as EventKind)) {
    return {
      ok: false,
      code: "unknown_kind",
      kind,
      message: `Unknown event kind "${kind}". Permitted: ${EVENT_KINDS.join(", ")}.`,
    };
  }

  if (typeof input.payload !== "object" || input.payload === null || Array.isArray(input.payload)) {
    return { ok: false, code: "schema_violation", kind, message: "Payload must be a JSON object." };
  }

  const serialized = JSON.stringify(input.payload);
  if (serialized.length > MAX_PAYLOAD_BYTES) {
    return {
      ok: false,
      code: "too_large",
      kind,
      message: `Payload is ${serialized.length} bytes; the cap is ${MAX_PAYLOAD_BYTES}.`,
    };
  }

  // Denied-key sweep runs BEFORE schema validation, so a rejected field is
  // reported as the privacy violation it is rather than as a generic type error.
  const keyProblem = sweepKeys(input.payload, 0);
  if (keyProblem === "too_deep") {
    return { ok: false, code: "too_deep", kind, message: `Payload nests deeper than ${MAX_DEPTH} levels.` };
  }
  if (keyProblem) {
    const offending = keyProblem.replace("denied_key:", "");
    return {
      ok: false,
      code: "denied_key",
      kind,
      message: `Field "${offending}" is not accepted. Telemetry carries diagnostics, never message content or contact identity.`,
    };
  }

  const pii = sweepStringValues(input.payload, 0);
  if (pii) {
    return {
      ok: false,
      code: "pii_value",
      kind,
      message: `A string value matched the "${pii}" pattern and was refused.`,
    };
  }

  const schema = EVENT_SCHEMAS[kind as EventKind];
  const parsed = schema.safeParse(input.payload);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 4).map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
    return { ok: false, code: "schema_violation", kind, message: issues.join("; ") };
  }

  // The heartbeat carries a self-assertion that sync is still off. A device
  // reporting sync ENABLED is a product-level emergency, not telemetry.
  if (kind === "heartbeat" && (parsed.data as { syncEnabled: boolean }).syncEnabled !== false) {
    return {
      ok: false,
      code: "sync_enabled",
      kind,
      message: "Device reported syncEnabled=true. ReplyMate is local-first; this is refused and must be investigated.",
    };
  }

  const occurredAt = resolveTimestamp(input.occurredAt);
  if (!occurredAt) {
    return {
      ok: false,
      code: "bad_timestamp",
      kind,
      message: `occurredAt must be within ${MAX_PAST_MS / 86_400_000} days in the past and ${MAX_FUTURE_MS / 60_000} minutes in the future.`,
    };
  }

  return { ok: true, kind: kind as EventKind, payload: parsed.data as Record<string, unknown>, occurredAt };
}

/** Validates a batch, returning per-item results so one bad event cannot hide the rest. */
export function validateIngestBatch(events: unknown): {
  ok: boolean;
  accepted: Array<{ kind: EventKind; payload: Record<string, unknown>; occurredAt: Date }>;
  rejected: Array<{ index: number; code: IngestErrorCode; message: string }>;
  error?: string;
} {
  if (!Array.isArray(events)) {
    return { ok: false, accepted: [], rejected: [], error: "Body must contain an array of events." };
  }
  if (events.length === 0) {
    return { ok: false, accepted: [], rejected: [], error: "Batch is empty." };
  }
  if (events.length > MAX_BATCH_SIZE) {
    return {
      ok: false,
      accepted: [],
      rejected: [],
      error: `Batch has ${events.length} events; the cap is ${MAX_BATCH_SIZE}.`,
    };
  }

  const accepted: Array<{ kind: EventKind; payload: Record<string, unknown>; occurredAt: Date }> = [];
  const rejected: Array<{ index: number; code: IngestErrorCode; message: string }> = [];

  events.forEach((raw, index) => {
    const result = validateIngestEvent(raw as IngestEventInput);
    if (result.ok) {
      accepted.push({ kind: result.kind, payload: result.payload, occurredAt: result.occurredAt });
    } else {
      rejected.push({ index, code: result.code, message: result.message });
    }
  });

  return { ok: rejected.length === 0, accepted, rejected };
}
