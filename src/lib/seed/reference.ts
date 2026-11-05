import { db } from "@/db";
import { ctlConfigItem, ctlFeatureFlag, ctlPlan } from "@/db/schema";
import { CHANNELS, OUTPUT_CAP_RULE, FALLBACK_SEARCH, MIN_SUPPORTED_ANDROID_API, TARGET_ANDROID_API } from "@/config/catalog";

/**
 * Reference configuration seeded into the control plane.
 *
 * Every row is transcribed from the ReplyMate repository (docs/BLUEPRINT.md,
 * docs/SPEC.md, docs/provider-capability-map.md, docs/supabase/README.md). It
 * is the *documented* contract of the shipped Android app — not invented
 * sample data. Rows that describe something the client does not read yet are
 * marked `clientWired: false` / `locked: true` so the UI can say so honestly.
 */

const FLAGS: Array<{
  key: string;
  name: string;
  description: string;
  status: "off" | "shadow" | "canary" | "on";
  rolloutPercent: number;
  clientWired: boolean;
  minAppVersion: string | null;
}> = [
  {
    key: "background_drafts",
    name: "Background draft generation",
    description:
      "Watched-chat pings trigger debounced, hash-deduped generation through the same DraftService (P-background, 1.4.0).",
    status: "on",
    rolloutPercent: 100,
    clientWired: true,
    minAppVersion: "1.4.0",
  },
  {
    key: "direct_send_remote_input",
    name: "Direct send via RemoteInput",
    description:
      "SPEC F21 — gated, opt-in per contact. Explicitly a COULD/v2 item; never auto-sends, one tap = one confirmation.",
    status: "off",
    rolloutPercent: 0,
    clientWired: false,
    minAppVersion: null,
  },
  {
    key: "group_chat_drafts",
    name: "Group-chat draft awareness",
    description:
      "SPEC F15 — default suggest-only with extra confirmation. Group policy today is generate-on-tap only.",
    status: "shadow",
    rolloutPercent: 0,
    clientWired: true,
    minAppVersion: "0.9.0",
  },
  {
    key: "fallback_web_search",
    name: "Encyclopedic fallback retrieval",
    description:
      `${FALLBACK_SEARCH.name}. ${FALLBACK_SEARCH.honesty}`,
    status: "on",
    rolloutPercent: 100,
    clientWired: true,
    minAppVersion: "1.5.6",
  },
  {
    key: "message_sync",
    name: "Cloud message sync",
    description:
      "PERMANENTLY OFF. ReplyMate is local-first; SYNC_ENABLED=false is pinned by SupabaseConfigTest in the Android repo. This flag exists so the prohibition is visible and cannot be enabled from here.",
    status: "off",
    rolloutPercent: 0,
    clientWired: true,
    minAppVersion: "0.3.0",
  },
  {
    key: "semantic_memory_recall",
    name: "Embedding-based memory recall",
    description: "SPEC F23 — postponed so v1 stays cheap and deterministic (recency + pinned + importance).",
    status: "off",
    rolloutPercent: 0,
    clientWired: false,
    minAppVersion: null,
  },
  {
    key: "passkey_sign_in",
    name: "Passkey sign-in (app)",
    description:
      "Recorded as honest-deferred in 1.2.0: needs Credential Manager and is experimental on the target API range.",
    status: "off",
    rolloutPercent: 0,
    clientWired: false,
    minAppVersion: null,
  },
];

const CONFIG: Array<{
  key: string;
  category: string;
  valueType: "string" | "number" | "boolean" | "json";
  value: unknown;
  description: string;
  locked: boolean;
  sensitive: boolean;
}> = [
  {
    key: "privacy.sync_enabled",
    category: "privacy",
    valueType: "boolean",
    value: false,
    description:
      "Mirrors SupabaseConfig.SYNC_ENABLED in the Android app. Locked: the control plane may never turn message sync on.",
    locked: true,
    sensitive: false,
  },
  {
    key: "privacy.provider_keys_stored_server_side",
    category: "privacy",
    valueType: "boolean",
    value: false,
    description: "Provider API keys live only in the Android Keystore (rm_master, AES/GCM). Locked.",
    locked: true,
    sensitive: false,
  },
  {
    key: "privacy.control_plane_may_read_message_bodies",
    category: "privacy",
    valueType: "boolean",
    value: false,
    description: "Enforced in code by src/lib/privacy/guard.ts. Locked.",
    locked: true,
    sensitive: false,
  },
  {
    key: "generation.context_cap_tokens",
    category: "generation",
    valueType: "number",
    value: 8000,
    description: "Hard input context cap. TokenBudgeter drops oldest thread turns first, then trims facts, never style rules.",
    locked: false,
    sensitive: false,
  },
  {
    key: "generation.thread_turn_limit",
    category: "generation",
    valueType: "number",
    value: 30,
    description: "Last N messages mapped into the prompt, oldest-first (BLUEPRINT §5.3).",
    locked: false,
    sensitive: false,
  },
  {
    key: "generation.output_cap_baseline",
    category: "generation",
    valueType: "number",
    value: OUTPUT_CAP_RULE.baselineChatCap,
    description: OUTPUT_CAP_RULE.description,
    locked: false,
    sensitive: false,
  },
  {
    key: "generation.thinking_budgets",
    category: "generation",
    valueType: "json",
    value: OUTPUT_CAP_RULE.thinkingBudgets,
    description: "Thinking budget per level. Providers count thinking INSIDE the output cap (P-background-8 amendment).",
    locked: false,
    sensitive: false,
  },
  {
    key: "resilience.retry_backoff",
    category: "resilience",
    valueType: "json",
    value: { baseMs: 500, multiplier: 2, maxRetries: 3, jitter: true },
    description: "429/5xx exponential backoff. 429 is treated as normal backpressure, never as failure (SPEC §6).",
    locked: false,
    sensitive: false,
  },
  {
    key: "resilience.fallback_search_transport",
    category: "resilience",
    valueType: "json",
    value: FALLBACK_SEARCH.transport,
    description: "Tight transport for the encyclopedic fallback so a slow lookup can never park a background draft.",
    locked: false,
    sensitive: false,
  },
  {
    key: "memory.fact_cap_per_prompt",
    category: "memory",
    valueType: "number",
    value: 30,
    description: "Pinned/high-importance facts included per prompt (SPEC §6 step 2).",
    locked: false,
    sensitive: false,
  },
  {
    key: "memory.summary_regeneration_threshold_tokens",
    category: "memory",
    valueType: "number",
    value: 2000,
    description: "Rolling summary regenerates when the uncovered span exceeds this (SPEC §6).",
    locked: false,
    sensitive: false,
  },
  {
    key: "memory.fact_extraction_interval_messages",
    category: "memory",
    valueType: "number",
    value: 10,
    description: "Every K new messages per contact triggers the extraction job, behind memory_enabled.",
    locked: false,
    sensitive: false,
  },
  {
    key: "prompt.draft_auto_purge_days",
    category: "privacy",
    valueType: "number",
    value: 7,
    description: "Prompt snapshots in draft.prompt_snapshot auto-purge after 7 days (BLUEPRINT §6.4).",
    locked: false,
    sensitive: false,
  },
  {
    key: "client.watched_channels",
    category: "client",
    valueType: "json",
    value: [...CHANNELS],
    description: "Channel set widened by cloud migration 0002 for P3 parity.",
    locked: false,
    sensitive: false,
  },
  {
    key: "client.min_android_api",
    category: "client",
    valueType: "number",
    value: MIN_SUPPORTED_ANDROID_API,
    description: "Locked decision #3. Consequence: BiometricPrompt is API 28+, so 24–27 use device-credential fallback.",
    locked: true,
    sensitive: false,
  },
  {
    key: "client.target_android_api",
    category: "client",
    valueType: "number",
    value: TARGET_ANDROID_API,
    description: "Locked decision #3.",
    locked: true,
    sensitive: false,
  },
  {
    key: "client.lock_idle_timeout_minutes",
    category: "security",
    valueType: "number",
    value: 2,
    description: "App lock after N minutes background idle (BLUEPRINT §6.2).",
    locked: false,
    sensitive: false,
  },
  {
    key: "cloud.supabase_project_url",
    category: "cloud",
    valueType: "string",
    value: "https://xdcsxxwhvpiissetbrdr.supabase.co",
    description: "Public by design — the database is guarded by RLS, not by key secrecy (docs/supabase/README.md).",
    locked: true,
    sensitive: false,
  },
  {
    key: "cloud.applied_migration_versions",
    category: "cloud",
    valueType: "json",
    value: [1, 2, 3, 4],
    description: "Ledger of migrations recorded as applied to the live database. This platform never applies migrations.",
    locked: true,
    sensitive: false,
  },
];

const PLANS: Array<{
  key: string;
  name: string;
  priceMinor: number;
  currency: string;
  interval: "month" | "year" | "once";
  features: string[];
  active: boolean;
}> = [
  {
    key: "free",
    name: "Free",
    priceMinor: 0,
    currency: "NGN",
    interval: "month",
    features: [
      "Unlimited manual-mode drafts",
      "Notification listener for watched apps",
      "BYOK provider keys (your own AI Studio / OpenAI / Claude key)",
      "Per-contact isolated memory",
      "Local-first storage, no cloud sync",
    ],
    active: true,
  },
  {
    key: "premium",
    name: "Premium",
    priceMinor: 0,
    currency: "NGN",
    interval: "month",
    features: [
      "Everything in Free",
      "Encrypted local backup + per-contact JSON export (SPEC F17)",
      "Cost dashboard with daily free-tier budget guard (SPEC F19)",
      "Chat-history import to bootstrap memory (SPEC F25)",
    ],
    active: false,
  },
];

export async function seedFeatureFlags(): Promise<number> {
  let written = 0;
  for (const flag of FLAGS) {
    await db
      .insert(ctlFeatureFlag)
      .values(flag)
      .onConflictDoUpdate({
        target: ctlFeatureFlag.key,
        set: {
          name: flag.name,
          description: flag.description,
          clientWired: flag.clientWired,
          minAppVersion: flag.minAppVersion,
          updatedAt: new Date(),
        },
      });
    written += 1;
  }
  return written;
}

export async function seedConfiguration(): Promise<number> {
  let written = 0;
  for (const item of CONFIG) {
    await db
      .insert(ctlConfigItem)
      .values({
        key: item.key,
        category: item.category,
        valueType: item.valueType,
        value: item.value,
        description: item.description,
        locked: item.locked,
        sensitive: item.sensitive,
      })
      .onConflictDoUpdate({
        target: ctlConfigItem.key,
        set: {
          category: item.category,
          valueType: item.valueType,
          description: item.description,
          locked: item.locked,
          sensitive: item.sensitive,
          updatedAt: new Date(),
        },
      });
    written += 1;
  }
  return written;
}

export async function seedPlans(): Promise<number> {
  let written = 0;
  for (const plan of PLANS) {
    await db
      .insert(ctlPlan)
      .values(plan)
      .onConflictDoUpdate({
        target: ctlPlan.key,
        set: {
          name: plan.name,
          features: plan.features,
          updatedAt: new Date(),
        },
      });
    written += 1;
  }
  return written;
}
