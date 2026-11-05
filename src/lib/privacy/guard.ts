/**
 * ReplyMate Control — PRIVACY GUARD.
 *
 * ReplyMate is local-first: the phone is the source of truth, message sync is
 * OFF (`SYNC_ENABLED = false`, pinned by `SupabaseConfigTest` in the Android
 * repo) and provider API keys never leave the device Keystore.
 *
 * This module is the hard boundary that keeps the admin platform inside that
 * contract. It is allow-list based: anything not explicitly permitted is
 * refused, and refusal is thrown rather than silently returning nothing.
 */

export const PRIVACY_RULES = {
  messageSyncEnabled: false,
  messageBodiesReadable: false,
  memoryFactsReadable: false,
  providerKeysStoredServerSide: false,
  endUserPiiExportable: false,
} as const;

/** ReplyMate cloud tables. Deny-by-default. */
const DENY_BODY: ReadonlySet<string> = new Set([
  "message",
  "memory_fact",
  "contact_summary",
  "draft",
  "style_profile",
  "app_kv",
  "contact",
  "contact_channel",
]);

/**
 * Allow-list: aggregate / non-content reads the control plane may perform
 * against the ReplyMate Supabase project, plus the exact columns permitted.
 * `provider_def.key_ref` is excluded — even a vault label is not needed here.
 */
const ALLOW: Readonly<
  Record<string, { columns: readonly string[]; aggregateOnly: boolean; reason: string }>
> = {
  usage_event: {
    columns: ["ts", "model", "kind", "tokens_in", "tokens_out"],
    aggregateOnly: true,
    reason: "Token/request telemetry has no message content; drives the Usage page.",
  },
  provider_def: {
    columns: ["type", "base_url", "model_name", "is_active", "created_at"],
    aggregateOnly: true,
    reason: "Provider/model distribution. key_ref and any secret material excluded.",
  },
  rm_schema_migrations: {
    columns: ["version", "label", "applied_at"],
    aggregateOnly: false,
    reason: "Schema ledger — proves the cloud foundation version without user data.",
  },
};

export type PrivacyDecision =
  | { allowed: true; table: string; columns: readonly string[]; aggregateOnly: boolean; reason: string }
  | { allowed: false; table: string; reason: string };

export function checkTableAccess(table: string): PrivacyDecision {
  const normalized = table.trim().toLowerCase().replace(/^public\./, "");

  if (DENY_BODY.has(normalized)) {
    return {
      allowed: false,
      table: normalized,
      reason: `Denied by the local-first contract: "${normalized}" holds ReplyMate end-user content. The control plane never reads it. See docs/PRIVACY.md.`,
    };
  }

  const entry = ALLOW[normalized];
  if (!entry) {
    return {
      allowed: false,
      table: normalized,
      reason: `Denied: "${normalized}" is not on the control-plane allow-list. Add it explicitly (with a reason) in src/lib/privacy/guard.ts before use.`,
    };
  }

  return {
    allowed: true,
    table: normalized,
    columns: entry.columns,
    aggregateOnly: entry.aggregateOnly,
    reason: entry.reason,
  };
}

/** Validates a hand-written SQL fragment against the allow-list. */
export function assertSafeSelect(table: string, columns: readonly string[]): void {
  const decision = checkTableAccess(table);
  if (!decision.allowed) throw new PrivacyViolation(decision.reason);

  const offending = columns.filter((c) => !decision.columns.includes(c.trim().toLowerCase()));
  if (offending.length > 0) {
    throw new PrivacyViolation(
      `Denied columns on ${decision.table}: ${offending.join(", ")}. Permitted: ${decision.columns.join(", ")}.`,
    );
  }
  if (decision.aggregateOnly && columns.length > 0) {
    const bare = columns.filter((c) => !/^(count|sum|min|max|avg|date_trunc|date_bucket)\(/i.test(c.trim()));
    const groupable = new Set(["ts", "model", "kind", "type", "base_url", "is_active", "version", "label", "applied_at", "tokens_in", "tokens_out", "model_name"]);
    const leaked = bare.filter((c) => !groupable.has(c.trim().toLowerCase()));
    if (leaked.length > 0) {
      throw new PrivacyViolation(
        `Table ${decision.table} is aggregate-only; raw selection of ${leaked.join(", ")} is denied.`,
      );
    }
  }
}

export class PrivacyViolation extends Error {
  readonly code = "PRIVACY_VIOLATION";
  constructor(message: string) {
    super(message);
    this.name = "PrivacyViolation";
  }
}

export function isPrivacyViolation(error: unknown): error is PrivacyViolation {
  return error instanceof PrivacyViolation;
}

/** Human-readable inventory for the Privacy page. No secrets, ever. */
export function privacyInventory() {
  return {
    rules: PRIVACY_RULES,
    allowed: Object.entries(ALLOW).map(([table, entry]) => ({
      table,
      columns: [...entry.columns],
      aggregateOnly: entry.aggregateOnly,
      reason: entry.reason,
    })),
    denied: [...DENY_BODY].sort().map((table) => ({
      table,
      reason: "Holds ReplyMate end-user content. Never readable from this platform.",
    })),
  };
}
