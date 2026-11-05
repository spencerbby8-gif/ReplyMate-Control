/**
 * AI gateway — provider catalogue and adapters.
 *
 * Shared between the Supabase Edge Function (`supabase/functions/replymate-ai`)
 * and the offline test suite. Pure TypeScript with **no Deno-only APIs**, so
 * `vitest` can import and test it directly; the Edge Function is a thin adapter
 * over this module rather than a second copy of the same logic.
 *
 * Every value is transcribed from the ReplyMate Android repository, not invented:
 *   - keys, labels, base URLs, dialects: src/com/replymate/core/model/ProviderType.java
 *   - search / reasoning / thinking wire shapes: docs/provider-capability-map.md
 *   - output-cap rule: the P-background-8 amendment (1.5.8) in that same file
 */

export type ApiStyle = "gemini" | "openai" | "anthropic";

export type GatewayProvider = {
  key: string;
  label: string;
  apiStyle: ApiStyle;
  defaultBaseUrl: string;
  /** Secret name in the Edge Function's environment that holds the master key. */
  keySecretName: string;
  /** Providers whose key the user supplies (BYOK) are never proxied by us. */
  byokOnly: boolean;
  reasoning: "native" | "family_split" | "fallback" | "none";
  search: "native" | "family_split" | "fallback" | "none";
};

/**
 * Only providers the platform intends to hold a master key for.
 *
 * `ollama` is local to the user's device and `openai_compat` is an arbitrary
 * endpoint — neither can be proxied, and pretending otherwise would be a lie
 * about capability. BYOK remains available for every provider in the app itself.
 */
export const GATEWAY_PROVIDERS: GatewayProvider[] = [
  {
    key: "gemini",
    label: "Google Gemini",
    apiStyle: "gemini",
    defaultBaseUrl: "https://generativelanguage.googleapis.com",
    keySecretName: "GEMINI_MASTER_KEY",
    byokOnly: false,
    reasoning: "native",
    search: "native",
  },
  {
    key: "anthropic",
    label: "Anthropic (Claude)",
    apiStyle: "anthropic",
    defaultBaseUrl: "https://api.anthropic.com",
    keySecretName: "ANTHROPIC_MASTER_KEY",
    byokOnly: false,
    reasoning: "family_split",
    search: "native",
  },
  {
    key: "openai",
    label: "OpenAI",
    apiStyle: "openai",
    defaultBaseUrl: "https://api.openai.com/v1",
    keySecretName: "OPENAI_MASTER_KEY",
    byokOnly: false,
    reasoning: "native",
    search: "native",
  },
  {
    key: "openrouter",
    label: "OpenRouter",
    apiStyle: "openai",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    keySecretName: "OPENROUTER_MASTER_KEY",
    byokOnly: false,
    reasoning: "native",
    search: "native",
  },
  {
    key: "deepseek",
    label: "DeepSeek",
    apiStyle: "openai",
    defaultBaseUrl: "https://api.deepseek.com",
    keySecretName: "DEEPSEEK_MASTER_KEY",
    byokOnly: false,
    reasoning: "native",
    search: "fallback",
  },
  {
    key: "grok",
    label: "Grok (xAI)",
    apiStyle: "openai",
    defaultBaseUrl: "https://api.x.ai/v1",
    keySecretName: "GROK_MASTER_KEY",
    byokOnly: false,
    reasoning: "native",
    search: "native",
  },
  {
    key: "kimi",
    label: "Kimi (Moonshot)",
    apiStyle: "openai",
    defaultBaseUrl: "https://api.moonshot.ai/v1",
    keySecretName: "KIMI_MASTER_KEY",
    byokOnly: false,
    reasoning: "native",
    search: "native",
  },
  {
    key: "mistral",
    label: "Mistral",
    apiStyle: "openai",
    defaultBaseUrl: "https://api.mistral.ai/v1",
    keySecretName: "MISTRAL_MASTER_KEY",
    byokOnly: false,
    reasoning: "family_split",
    search: "fallback",
  },
];

/** Providers the app supports that the gateway deliberately does NOT proxy. */
export const NOT_PROXIED = [
  { key: "ollama", reason: "Runs on the user's own device; there is nothing to proxy." },
  { key: "openai_compat", reason: "An arbitrary user-chosen endpoint; the platform cannot hold a key for it." },
] as const;

export function providerByKey(key: string): GatewayProvider | undefined {
  return GATEWAY_PROVIDERS.find((provider) => provider.key === key);
}

// ---------------------------------------------------------------------------
// Output-cap rule (P-background-8 amendment, 1.5.8)
// ---------------------------------------------------------------------------

export const OUTPUT_CAP = {
  baselineChat: 220,
  thinkingBudgets: { none: 0, low: 1024, high: 4096 } as Record<string, number>,
  replyHeadroom: 256,
} as const;

export type ThinkingLevel = "none" | "low" | "high";

/**
 * Providers count thinking INSIDE the output cap. A dialect that attaches a paid
 * thinking control must enlarge the cap by the thinking budget plus reply
 * headroom, or the answer is starved into an empty / MAX_TOKENS reply — the bug
 * that silently killed background drafts on 1.5.6–1.5.7.
 */
export function effectiveOutputCap(thinking: ThinkingLevel, baseline = OUTPUT_CAP.baselineChat): number {
  const budget = OUTPUT_CAP.thinkingBudgets[thinking] ?? 0;
  return baseline + budget + (thinking === "none" ? 0 : OUTPUT_CAP.replyHeadroom);
}

// ---------------------------------------------------------------------------
// Request construction per dialect
// ---------------------------------------------------------------------------

export type GatewayRequest = {
  providerKey: string;
  model: string;
  system: string;
  turns: Array<{ role: "user" | "assistant"; text: string }>;
  task: string;
  thinking: ThinkingLevel;
  maxOutputTokens?: number;
  timeoutMs?: number;
};

export type PreparedCall = {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string;
  maxOutputTokens: number;
  timeoutMs: number;
};

export const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Builds the wire request for a dialect.
 *
 * The API key is passed in by the caller and is inserted into headers only — it
 * is never placed in the URL, never logged, and never returned in `PreparedCall`
 * outside the header map the caller already owns.
 */
export function prepareCall(request: GatewayRequest, apiKey: string): PreparedCall {
  const provider = providerByKey(request.providerKey);
  if (!provider) throw new Error(`Gateway does not proxy provider "${request.providerKey}".`);

  const maxOutputTokens = Math.max(
    request.maxOutputTokens ?? 0,
    effectiveOutputCap(request.thinking),
  );
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (provider.apiStyle === "gemini") {
    const generationConfig: Record<string, unknown> = {
      maxOutputTokens,
      candidateCount: 1,
    };
    // Gemini 2.5 uses thinkingBudget; 3.x uses thinkingLevel. Both are attached
    // only when a level is requested. includeThoughts is NEVER requested, so no
    // chain of thought leaves the provider.
    if (request.thinking !== "none") {
      const isGemini3 = /^gemini-3/i.test(request.model);
      generationConfig.thinkingConfig = isGemini3
        ? { thinkingLevel: request.thinking }
        : { thinkingBudget: OUTPUT_CAP.thinkingBudgets[request.thinking] };
    }
    return {
      url: `${provider.defaultBaseUrl}/v1beta/models/${encodeURIComponent(request.model)}:generateContent`,
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: request.system }] },
        contents: request.turns.map((turn) => ({
          role: turn.role === "assistant" ? "model" : "user",
          parts: [{ text: turn.text }],
        })),
        generationConfig,
      }),
      maxOutputTokens,
      timeoutMs,
    };
  }

  if (provider.apiStyle === "anthropic") {
    const body: Record<string, unknown> = {
      model: request.model,
      max_tokens: maxOutputTokens,
      system: request.system,
      messages: request.turns.map((turn) => ({ role: turn.role, content: turn.text })),
    };
    // Family split, per the capability map: 4.6+/5.x take adaptive thinking plus
    // output_config.effort; <=4.5 take budget_tokens and MUST omit temperature.
    const isModern = /^claude-(?:[5-9]|4\.[6-9])/i.test(request.model);
    if (request.thinking !== "none") {
      if (isModern) {
        body.thinking = { type: "adaptive" };
        body.output_config = { effort: request.thinking === "high" ? "high" : "low" };
      } else {
        body.thinking = { type: "enabled", budget_tokens: OUTPUT_CAP.thinkingBudgets[request.thinking] };
      }
    }
    return {
      url: `${provider.defaultBaseUrl}/v1/messages`,
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
      maxOutputTokens,
      timeoutMs,
    };
  }

  // OpenAI-compatible chat/completions dialect.
  const body: Record<string, unknown> = {
    model: request.model,
    max_tokens: maxOutputTokens,
    messages: [
      { role: "system", content: request.system },
      ...request.turns.map((turn) => ({ role: turn.role, content: turn.text })),
    ],
  };
  // Reasoning parameter shapes differ per provider; only attach what the
  // capability map documents, and never for providers that 422 on it.
  if (request.thinking !== "none") {
    const effort = request.thinking === "high" ? "high" : "low";
    if (provider.key === "deepseek") {
      body.thinking = { type: "enabled" };
      body.reasoning_effort = effort;
    } else if (provider.key === "kimi") {
      // Search is incompatible with thinking on K2.5/K2.6; the gateway does not
      // attach search, so thinking may be enabled.
      body.thinking = { type: "enabled" };
    } else if (provider.key === "mistral") {
      if (/^mistral-small/i.test(request.model)) body.reasoning_effort = effort;
      // magistral-* is always-on and 422s on the parameter: send nothing.
    } else if (provider.key === "openrouter") {
      body.reasoning = { effort };
    } else if (provider.key !== "grok") {
      // grok-4.x reason always-on with no documented per-request knob: send
      // nothing rather than inventing a parameter.
      body.reasoning_effort = effort;
    }
  }
  return {
    url: `${provider.defaultBaseUrl}/chat/completions`,
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    maxOutputTokens,
    timeoutMs,
  };
}

// ---------------------------------------------------------------------------
// Response parsing and attribution
// ---------------------------------------------------------------------------

export type Attribution = {
  providerKey: string;
  providerLabel: string;
  model: string;
  dialect: ApiStyle;
  /** True when the provider actually served the reply (vs a fallback). */
  served: boolean;
  /** Set when a fallback provider served instead of the requested one. */
  requestedProviderKey?: string;
  requestedModel?: string;
};

export type ParsedReply = {
  text: string;
  tokensIn: number;
  tokensOut: number;
  finishReason: string | null;
  /** True when the provider truncated the answer, which must be an error. */
  truncated: boolean;
};

export function parseReply(providerKey: string, payload: unknown): ParsedReply {
  const provider = providerByKey(providerKey);
  if (!provider) throw new Error(`Unknown provider "${providerKey}".`);
  const record = (payload ?? {}) as Record<string, unknown>;

  if (provider.apiStyle === "gemini") {
    const candidates = (record.candidates ?? []) as Array<{
      content?: { parts?: Array<{ text?: string; thought?: boolean }> };
      finishReason?: string;
    }>;
    const parts = candidates[0]?.content?.parts ?? [];
    // Defensive: parts flagged as thoughts are skipped, and includeThoughts was
    // never requested, so a chain of thought cannot leak into a reply.
    const text = parts
      .filter((part) => !part.thought)
      .map((part) => part.text ?? "")
      .join("");
    const usage = (record.usageMetadata ?? {}) as Record<string, number>;
    const finishReason = candidates[0]?.finishReason ?? null;
    return {
      text,
      tokensIn: Number(usage.promptTokenCount ?? 0),
      tokensOut: Number(usage.candidatesTokenCount ?? 0),
      finishReason,
      truncated: finishReason === "MAX_TOKENS" || finishReason === "LENGTH",
    };
  }

  if (provider.apiStyle === "anthropic") {
    const content = (record.content ?? []) as Array<{ type: string; text?: string; thinking?: string }>;
    // Only text blocks become replies; thinking blocks are ignored entirely and
    // are never shown or stored.
    const text = content
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("");
    const usage = (record.usage ?? {}) as Record<string, number>;
    const stopReason = (record.stop_reason as string | null) ?? null;
    return {
      text,
      tokensIn: Number(usage.input_tokens ?? 0),
      tokensOut: Number(usage.output_tokens ?? 0),
      finishReason: stopReason,
      truncated: stopReason === "max_tokens",
    };
  }

  const choices = (record.choices ?? []) as Array<{
    message?: { content?: string };
    finish_reason?: string;
  }>;
  const usage = (record.usage ?? {}) as Record<string, number>;
  const finishReason = choices[0]?.finish_reason ?? null;
  return {
    text: choices[0]?.message?.content ?? "",
    tokensIn: Number(usage.prompt_tokens ?? 0),
    tokensOut: Number(usage.completion_tokens ?? 0),
    finishReason,
    truncated: finishReason === "length",
  };
}

export function attribute(
  servedProviderKey: string,
  model: string,
  requested?: { providerKey: string; model: string },
): Attribution {
  const provider = providerByKey(servedProviderKey);
  const served = !requested || (requested.providerKey === servedProviderKey && requested.model === model);
  return {
    providerKey: servedProviderKey,
    providerLabel: provider?.label ?? servedProviderKey,
    model,
    dialect: provider?.apiStyle ?? "openai",
    served,
    ...(served
      ? {}
      : { requestedProviderKey: requested?.providerKey, requestedModel: requested?.model }),
  };
}
