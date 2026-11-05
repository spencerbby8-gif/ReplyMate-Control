/**
 * Domain catalogue for ReplyMate Control.
 *
 * Every value here is transcribed from the ReplyMate Android repository — not
 * invented:
 *  - providers/base URLs/dialects: `src/com/replymate/core/model/ProviderType.java`
 *  - search + reasoning capability: `docs/provider-capability-map.md`
 *  - task kinds: `docs/BLUEPRINT.md` §4 `UsageKind` + §5.6 background jobs
 *  - release ledger shape: `releases/RELEASES.md`
 *
 * If the Android app changes a value, this file must change with it (tracked by
 * `tests/catalog.test.ts`, which fails when a provider key is missing).
 */

export const SOURCE_REPO = "spencerbby8-gif/ReplyMate";
export const SOURCE_FILES = {
  providerType: "src/com/replymate/core/model/ProviderType.java",
  capabilityMap: "docs/provider-capability-map.md",
  blueprint: "docs/BLUEPRINT.md",
  spec: "docs/SPEC.md",
  supabaseReadme: "docs/supabase/README.md",
  releases: "releases/RELEASES.md",
} as const;

/** Known-good Supabase project for the app data plane (public by design). */
export const REPLYMATE_SUPABASE_PROJECT_URL = "https://xdcsxxwhvpiissetbrdr.supabase.co";
/** Cloud migrations recorded as applied in docs/supabase/README.md. */
export const REPLYMATE_APPLIED_MIGRATIONS = [1, 2, 3, 4] as const;

export type ApiStyle = "gemini" | "openai" | "anthropic";

export type CatalogProvider = {
  key: string;
  displayName: string;
  apiStyle: ApiStyle;
  /** Wire dialects the app actually speaks for this provider. */
  dialects: string[];
  defaultBaseUrl: string;
  needsKey: boolean;
  searchSupport: "native" | "family_split" | "fallback" | "none";
  reasoningSupport: "native" | "family_split" | "fallback" | "none";
  /** True when the key is stored only in the Android Keystore (BYOK). Always true. */
  byokOnly: true;
  capabilityNote: string;
};

export const PROVIDER_CATALOGUE: CatalogProvider[] = [
  {
    key: "gemini",
    displayName: "Google Gemini",
    apiStyle: "gemini",
    dialects: ["generateContent"],
    defaultBaseUrl: "https://generativelanguage.googleapis.com",
    needsKey: true,
    searchSupport: "native",
    reasoningSupport: "native",
    byokOnly: true,
    capabilityNote:
      "google_search tool on generateContent; thinkingConfig thinkingLevel (3.x) or thinkingBudget (2.5). includeThoughts is never requested.",
  },
  {
    key: "openai",
    displayName: "OpenAI",
    apiStyle: "openai",
    dialects: ["chat/completions", "responses"],
    defaultBaseUrl: "https://api.openai.com/v1",
    needsKey: true,
    searchSupport: "native",
    reasoningSupport: "native",
    byokOnly: true,
    capabilityNote:
      "Web search only on the Responses dialect (tools:[{type:web_search}]); reasoning_effort maps 1:1.",
  },
  {
    key: "openrouter",
    displayName: "OpenRouter",
    apiStyle: "openai",
    dialects: ["chat/completions", "responses"],
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    needsKey: true,
    searchSupport: "native",
    reasoningSupport: "native",
    byokOnly: true,
    capabilityNote:
      "openrouter:web_search tool (max_results/max_total_results); reasoning:{effort} model-routed. Exa/Parallel used as the retrieval backend.",
  },
  {
    key: "anthropic",
    displayName: "Anthropic (Claude)",
    apiStyle: "anthropic",
    dialects: ["messages"],
    defaultBaseUrl: "https://api.anthropic.com",
    needsKey: true,
    searchSupport: "native",
    reasoningSupport: "family_split",
    byokOnly: true,
    capabilityNote:
      "web_search_20250305 server tool with max_uses. Thinking is family-split: 4.6+/5.x use adaptive + output_config.effort; ≤4.5 use budget_tokens and require temperature omitted/1. thinking blocks are never shown or stored.",
  },
  {
    key: "deepseek",
    displayName: "DeepSeek",
    apiStyle: "openai",
    dialects: ["chat/completions"],
    defaultBaseUrl: "https://api.deepseek.com",
    needsKey: true,
    searchSupport: "fallback",
    reasoningSupport: "native",
    byokOnly: true,
    capabilityNote:
      "No official search tool in chat/completions — retrieval runs before generation. reasoning_content is never logged, stored or replayed.",
  },
  {
    key: "grok",
    displayName: "Grok (xAI)",
    apiStyle: "openai",
    dialects: ["chat/completions", "responses"],
    defaultBaseUrl: "https://api.x.ai/v1",
    needsKey: true,
    searchSupport: "native",
    reasoningSupport: "native",
    byokOnly: true,
    capabilityNote:
      "Responses dialect with tools:[{type:web_search}]. Legacy search_parameters Live Search is retired (410 Gone since 2026-01-12). grok-4.x reason always-on; no per-request effort knob exists, so nothing is sent.",
  },
  {
    key: "kimi",
    displayName: "Kimi (Moonshot)",
    apiStyle: "openai",
    dialects: ["chat/completions"],
    defaultBaseUrl: "https://api.moonshot.ai/v1",
    needsKey: true,
    searchSupport: "native",
    reasoningSupport: "native",
    byokOnly: true,
    capabilityNote:
      "builtin_function $web_search with the official echo loop (≤3 rounds). Search is incompatible with thinking on K2.5/K2.6 — thinking is disabled whenever search is attached. kimi-k3 always reasons.",
  },
  {
    key: "mistral",
    displayName: "Mistral",
    apiStyle: "openai",
    dialects: ["chat/completions"],
    defaultBaseUrl: "https://api.mistral.ai/v1",
    needsKey: true,
    searchSupport: "fallback",
    reasoningSupport: "family_split",
    byokOnly: true,
    capabilityNote:
      "web_search built-ins are Conversations/Agents-API only — NOT supported on /v1/chat/completions, so retrieval runs before generation. reasoning_effort works on mistral-small-*; magistral-* is always-on and 422s on the param.",
  },
  {
    key: "ollama",
    displayName: "Ollama (local)",
    apiStyle: "openai",
    dialects: ["chat/completions"],
    defaultBaseUrl: "http://localhost:11434/v1",
    needsKey: false,
    searchSupport: "fallback",
    reasoningSupport: "none",
    byokOnly: true,
    capabilityNote:
      "Local daemon has no search. Hosted ollama.com/api/web_search needs a separate cloud key and is deliberately NOT wired (second credential + privacy boundary). No reasoning control is sent.",
  },
  {
    key: "openai_compat",
    displayName: "Other (OpenAI-compatible)",
    apiStyle: "openai",
    dialects: ["chat/completions"],
    defaultBaseUrl: "",
    needsKey: true,
    searchSupport: "fallback",
    reasoningSupport: "none",
    byokOnly: true,
    capabilityNote:
      "Arbitrary endpoint. Capabilities are unknown by construction, so the transport reports FALLBACK / NONE and never assumes support.",
  },
];

export function providerByKey(key: string): CatalogProvider | undefined {
  return PROVIDER_CATALOGUE.find((p) => p.key === key);
}

/** Fallback retrieval backend used where searchSupport = "fallback". */
export const FALLBACK_SEARCH = {
  name: "Wikimedia REST (key-less)",
  endpoints: [
    "https://en.wikipedia.org/api/rest_v1/page/summary/{title}",
    "https://en.wiktionary.org/w/api.php?action=query&prop=extracts",
  ],
  honesty:
    "Encyclopedic, not tick-by-tick live. Good for slang/terms/people/places/stable facts; weak for live scores and prices. When it cannot verify, the reply must not invent.",
  transport: { perCallTimeoutMs: 2500, hardTimeoutMs: 4000, totalBudgetMs: 9000 },
} as const;

/** Generation task kinds the routing table can target. */
export const TASK_CATALOGUE = [
  { key: "reply", label: "Reply draft", description: "Foreground draft generation (J2 step 3)." },
  { key: "background", label: "Background draft", description: "Debounced, hash-deduped background generation." },
  { key: "summary", label: "Rolling summary", description: "Memory layer M2 — per-contact compressed history." },
  { key: "extract", label: "Fact extraction", description: "Memory layer M3 — durable facts with dedupe." },
  { key: "style", label: "Style derivation", description: "Memory layer M5 — derives style rules from samples." },
  { key: "assistant", label: "Ops assistant", description: "Control-plane AI operations assistant only." },
] as const;

export type TaskKey = (typeof TASK_CATALOGUE)[number]["key"];

/** Output-token cap rule pinned by the P-background-8 amendment (1.5.8). */
export const OUTPUT_CAP_RULE = {
  description:
    "Providers count thinking INSIDE the output cap. Any dialect that attaches a paid thinking/reasoning control must enlarge maxOutputTokens by the thinking budget + reply headroom, or background drafts starve into empty/MAX_TOKENS replies.",
  baselineChatCap: 220,
  thinkingBudgets: { none: 0, low: 1024, high: 4096 },
  replyHeadroom: 256,
  source: "docs/provider-capability-map.md — P-background-8 amendment",
} as const;

/** Effective output cap for a route, per the rule above. */
export function effectiveOutputCap(
  thinking: keyof typeof OUTPUT_CAP_RULE.thinkingBudgets,
  baseline: number = OUTPUT_CAP_RULE.baselineChatCap,
): number {
  return baseline + OUTPUT_CAP_RULE.thinkingBudgets[thinking] + (thinking === "none" ? 0 : OUTPUT_CAP_RULE.replyHeadroom);
}

/** Watched messaging apps (P3 widened channel set + docs/supabase 0002). */
export const CHANNELS = [
  "whatsapp",
  "telegram",
  "discord",
  "signal",
  "messenger",
  "instagram",
  "x",
  "tiktok",
  "slack",
  "manual",
] as const;

export const MIN_SUPPORTED_ANDROID_API = 24;
export const TARGET_ANDROID_API = 34;
