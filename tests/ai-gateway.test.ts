import { describe, expect, it } from "vitest";
import {
  GATEWAY_PROVIDERS,
  NOT_PROXIED,
  OUTPUT_CAP,
  attribute,
  effectiveOutputCap,
  parseReply,
  prepareCall,
  providerByKey,
} from "../supabase/functions/_shared/ai-gateway/catalogue.ts";
import { classifyError, classifyReplyProblem, extractMessage } from "../supabase/functions/_shared/ai-gateway/errors.ts";
import {
  createKeyResolver,
  describeKey,
  readKeyValue,
  requiredSecretNames,
  secretNamesFor,
} from "../supabase/functions/_shared/ai-gateway/keys.ts";
import { DEFAULT_LIMITS, estimateTokens, evaluateLimits, secondsUntilUtcMidnight } from "../supabase/functions/_shared/ai-gateway/limits.ts";
import { compareAppVersion, proxiedProviders, resolveRoute, type RoutePolicy } from "../supabase/functions/_shared/ai-gateway/routing.ts";

/**
 * AI gateway logic.
 *
 * These import the SAME modules the Edge Function runs, so there is no parallel
 * implementation to drift. The handler itself needs Deno and network access and
 * is therefore not exercised here — that gap is stated in TASK-005 rather than
 * papered over with a mock that proves nothing.
 */

const FAKE_KEY = "test-master-key-not-a-real-credential";

function request(overrides: Partial<Parameters<typeof prepareCall>[0]> = {}) {
  return prepareCall(
    {
      providerKey: "gemini",
      model: "gemini-2.5-flash",
      system: "You are writing my reply.",
      turns: [
        { role: "user", text: "Are we still on for Friday?" },
        { role: "assistant", text: "Yes!" },
        { role: "user", text: "Great, see you then." },
      ],
      task: "reply",
      thinking: "none",
      ...overrides,
    },
    FAKE_KEY,
  );
}

describe("catalogue fidelity to ProviderType.java", () => {
  it("proxies the eight providers a platform can hold a key for", () => {
    expect(GATEWAY_PROVIDERS.map((p) => p.key).sort()).toEqual(
      ["anthropic", "deepseek", "gemini", "grok", "kimi", "mistral", "openai", "openrouter"].sort(),
    );
  });

  it("uses the official base URLs from the Android source", () => {
    const expected: Record<string, string> = {
      gemini: "https://generativelanguage.googleapis.com",
      openai: "https://api.openai.com/v1",
      openrouter: "https://openrouter.ai/api/v1",
      anthropic: "https://api.anthropic.com",
      deepseek: "https://api.deepseek.com",
      grok: "https://api.x.ai/v1",
      kimi: "https://api.moonshot.ai/v1",
      mistral: "https://api.mistral.ai/v1",
    };
    for (const [key, url] of Object.entries(expected)) {
      expect(providerByKey(key)?.defaultBaseUrl, key).toBe(url);
    }
  });

  it("explicitly refuses to proxy ollama and openai_compat, with a reason", () => {
    expect(NOT_PROXIED.map((p) => p.key).sort()).toEqual(["ollama", "openai_compat"]);
    for (const entry of NOT_PROXIED) expect(entry.reason.length).toBeGreaterThan(20);
    expect(providerByKey("ollama")).toBeUndefined();
  });

  it("gives every proxied provider a distinct secret name", () => {
    const names = requiredSecretNames(GATEWAY_PROVIDERS.map((p) => p.key));
    expect(new Set(names).size).toBe(names.length);
    expect(names.every((name) => name.endsWith("_MASTER_KEY"))).toBe(true);
  });
});

describe("output-cap rule (P-background-8)", () => {
  it("adds nothing when thinking is off", () => {
    expect(effectiveOutputCap("none")).toBe(OUTPUT_CAP.baselineChat);
  });

  it("adds budget plus headroom for low and high", () => {
    expect(effectiveOutputCap("low")).toBe(220 + 1024 + 256);
    expect(effectiveOutputCap("high")).toBe(220 + 4096 + 256);
  });

  it("is enforced by prepareCall even when the caller asks for too little", () => {
    // This is the 1.5.6–1.5.7 starvation bug: a chat-tuned 220 cap with a paid
    // thinking budget starves the answer into an empty MAX_TOKENS reply.
    const prepared = request({ thinking: "high", maxOutputTokens: 220 });
    expect(prepared.maxOutputTokens).toBe(effectiveOutputCap("high"));
    expect(JSON.parse(prepared.body).generationConfig.maxOutputTokens).toBe(effectiveOutputCap("high"));
  });
});

describe("gemini dialect", () => {
  it("targets generateContent and sends the key in a header, never the URL", () => {
    const prepared = request();
    expect(prepared.url).toContain("/v1beta/models/gemini-2.5-flash:generateContent");
    expect(prepared.url).not.toContain(FAKE_KEY);
    expect(prepared.headers["x-goog-api-key"]).toBe(FAKE_KEY);
  });

  it("maps incoming to user and outgoing to model", () => {
    const body = JSON.parse(request().body) as { contents: Array<{ role: string }> };
    expect(body.contents.map((c) => c.role)).toEqual(["user", "model", "user"]);
  });

  it("uses thinkingBudget for 2.5 and thinkingLevel for 3.x", () => {
    const v25 = JSON.parse(request({ model: "gemini-2.5-flash", thinking: "high" }).body) as {
      generationConfig: { thinkingConfig: Record<string, unknown> };
    };
    expect(v25.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 4096 });

    const v3 = JSON.parse(request({ model: "gemini-3-pro", thinking: "high" }).body) as {
      generationConfig: { thinkingConfig: Record<string, unknown> };
    };
    expect(v3.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "high" });
  });

  it("omits thinkingConfig entirely when thinking is none", () => {
    const body = JSON.parse(request({ thinking: "none" }).body) as { generationConfig: Record<string, unknown> };
    expect(body.generationConfig.thinkingConfig).toBeUndefined();
  });

  it("NEVER requests includeThoughts, so no chain of thought can leave the provider", () => {
    for (const thinking of ["none", "low", "high"] as const) {
      expect(request({ thinking }).body).not.toContain("includeThoughts");
    }
  });

  it("parses a reply and skips thought-flagged parts defensively", () => {
    const parsed = parseReply("gemini", {
      candidates: [{ content: { parts: [{ text: "hidden", thought: true }, { text: "See you Friday!" }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 6 },
    });
    expect(parsed.text).toBe("See you Friday!");
    expect(parsed.tokensIn).toBe(120);
    expect(parsed.tokensOut).toBe(6);
    expect(parsed.truncated).toBe(false);
  });

  it("flags MAX_TOKENS as truncation, which the caller must treat as an error", () => {
    const parsed = parseReply("gemini", { candidates: [{ content: { parts: [{ text: "half" }] }, finishReason: "MAX_TOKENS" }] });
    expect(parsed.truncated).toBe(true);
  });
});

describe("anthropic dialect", () => {
  it("sends x-api-key and the version header", () => {
    const prepared = request({ providerKey: "anthropic", model: "claude-sonnet-4-5" });
    expect(prepared.url).toBe("https://api.anthropic.com/v1/messages");
    expect(prepared.headers["x-api-key"]).toBe(FAKE_KEY);
    expect(prepared.headers["anthropic-version"]).toBe("2023-06-01");
    expect(prepared.url).not.toContain(FAKE_KEY);
  });

  it("uses adaptive thinking plus output_config.effort on 4.6+/5.x", () => {
    const body = JSON.parse(request({ providerKey: "anthropic", model: "claude-5-opus", thinking: "high" }).body) as Record<string, unknown>;
    expect(body.thinking).toEqual({ type: "adaptive" });
    expect(body.output_config).toEqual({ effort: "high" });
  });

  it("uses budget_tokens on 4.5 and below, and never sends temperature", () => {
    const body = JSON.parse(request({ providerKey: "anthropic", model: "claude-haiku-4-5", thinking: "low" }).body) as Record<string, unknown>;
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 1024 });
    expect(body.output_config).toBeUndefined();
    expect(body.temperature).toBeUndefined();
  });

  it("keeps only text blocks and ignores thinking blocks entirely", () => {
    const parsed = parseReply("anthropic", {
      content: [
        { type: "thinking", thinking: "private reasoning that must never be shown or stored" },
        { type: "text", text: "See you Friday!" },
      ],
      usage: { input_tokens: 80, output_tokens: 5 },
      stop_reason: "end_turn",
    });
    expect(parsed.text).toBe("See you Friday!");
    expect(parsed.text).not.toContain("private reasoning");
    expect(parsed.truncated).toBe(false);
  });

  it("flags max_tokens as truncation", () => {
    expect(parseReply("anthropic", { content: [{ type: "text", text: "x" }], stop_reason: "max_tokens" }).truncated).toBe(true);
  });
});

describe("openai-compatible dialect and its per-provider reasoning quirks", () => {
  it("uses chat/completions with a bearer header", () => {
    const prepared = request({ providerKey: "openai", model: "gpt-4o-mini" });
    expect(prepared.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(prepared.headers.authorization).toBe(`Bearer ${FAKE_KEY}`);
  });

  it("deepseek gets thinking plus reasoning_effort", () => {
    const body = JSON.parse(request({ providerKey: "deepseek", model: "deepseek-chat", thinking: "high" }).body) as Record<string, unknown>;
    expect(body.thinking).toEqual({ type: "enabled" });
    expect(body.reasoning_effort).toBe("high");
  });

  it("kimi gets only the thinking toggle", () => {
    const body = JSON.parse(request({ providerKey: "kimi", model: "kimi-k2", thinking: "low" }).body) as Record<string, unknown>;
    expect(body.thinking).toEqual({ type: "enabled" });
    expect(body.reasoning_effort).toBeUndefined();
  });

  it("mistral-small gets reasoning_effort but magistral gets NOTHING (it 422s)", () => {
    const small = JSON.parse(request({ providerKey: "mistral", model: "mistral-small-latest", thinking: "high" }).body) as Record<string, unknown>;
    expect(small.reasoning_effort).toBe("high");
    const magistral = JSON.parse(request({ providerKey: "mistral", model: "magistral-medium", thinking: "high" }).body) as Record<string, unknown>;
    expect(magistral.reasoning_effort).toBeUndefined();
  });

  it("grok gets no reasoning knob at all — none is documented, so none is invented", () => {
    const body = JSON.parse(request({ providerKey: "grok", model: "grok-4", thinking: "high" }).body) as Record<string, unknown>;
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.reasoning).toBeUndefined();
    expect(body.thinking).toBeUndefined();
  });

  it("openrouter uses the official reasoning parameter", () => {
    const body = JSON.parse(request({ providerKey: "openrouter", model: "anthropic/claude-4", thinking: "low" }).body) as Record<string, unknown>;
    expect(body.reasoning).toEqual({ effort: "low" });
  });

  it("parses choices and flags finish_reason length as truncation", () => {
    const parsed = parseReply("openai", {
      choices: [{ message: { content: "See you Friday!" }, finish_reason: "length" }],
      usage: { prompt_tokens: 40, completion_tokens: 4 },
    });
    expect(parsed.text).toBe("See you Friday!");
    expect(parsed.truncated).toBe(true);
  });
});

describe("routing and controlled fallback", () => {
  const routes: RoutePolicy[] = [
    { task: "reply", providerKey: "gemini", model: "gemini-2.5-flash", priority: 10, thinking: "none", enabled: true },
    { task: "reply", providerKey: "anthropic", model: "claude-haiku-4-5", priority: 20, thinking: "none", enabled: true },
    { task: "reply", providerKey: "openai", model: "gpt-4o-mini", priority: 30, thinking: "none", enabled: false },
    { task: "summary", providerKey: "gemini", model: "gemini-2.5-flash", priority: 10, thinking: "low", enabled: true },
  ];

  it("picks the lowest priority number among enabled routes", () => {
    const decision = resolveRoute({ task: "reply", routes, appVersion: "1.7.2", hasKey: () => true });
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(decision.route.providerKey).toBe("gemini");
  });

  it("falls back when the first provider has no master key configured", () => {
    const decision = resolveRoute({
      task: "reply",
      routes,
      appVersion: "1.7.2",
      hasKey: (key) => key !== "gemini",
    });
    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.route.providerKey).toBe("anthropic");
      expect(decision.skipped).toContainEqual({ providerKey: "gemini", reason: "no master key configured" });
    }
  });

  it("skips disabled routes rather than failing on them", () => {
    const decision = resolveRoute({
      task: "reply",
      routes,
      appVersion: "1.7.2",
      hasKey: (key) => key === "openai",
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toMatch(/every route/i);
  });

  it("fails cleanly when a task has no enabled route, telling the client to use BYOK", () => {
    const decision = resolveRoute({ task: "extract", routes, appVersion: "1.7.2", hasKey: () => true });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toMatch(/BYOK/);
  });

  it("skips a provider the gateway does not proxy", () => {
    const withOllama: RoutePolicy[] = [
      { task: "reply", providerKey: "ollama", model: "llama3", priority: 1, thinking: "none", enabled: true },
      ...routes,
    ];
    const decision = resolveRoute({ task: "reply", routes: withOllama, appVersion: "1.7.2", hasKey: () => true });
    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.route.providerKey).toBe("gemini");
      expect(decision.skipped).toContainEqual({ providerKey: "ollama", reason: "not proxied by the gateway" });
    }
  });

  it("honours minAppVersion and records why a gated route was skipped", () => {
    const gated: RoutePolicy[] = [
      { task: "reply", providerKey: "gemini", model: "gemini-3-pro", priority: 1, thinking: "none", enabled: true, minAppVersion: "2.0.0" },
      { task: "reply", providerKey: "anthropic", model: "claude-haiku-4-5", priority: 9, thinking: "none", enabled: true },
    ];
    const old = resolveRoute({ task: "reply", routes: gated, appVersion: "1.5.9", hasKey: () => true });
    expect(old.ok).toBe(true);
    if (old.ok) {
      expect(old.route.providerKey).toBe("anthropic");
      expect(old.skipped[0].reason).toContain("1.5.9");
    }
    const fresh = resolveRoute({ task: "reply", routes: gated, appVersion: "2.1.0", hasKey: () => true });
    if (fresh.ok) expect(fresh.route.providerKey).toBe("gemini");
  });

  it("skips a gated route when the client sends no version, rather than guessing", () => {
    const gated: RoutePolicy[] = [
      { task: "reply", providerKey: "gemini", model: "m", priority: 1, thinking: "none", enabled: true, minAppVersion: "2.0.0" },
    ];
    const decision = resolveRoute({ task: "reply", routes: gated, appVersion: null, hasKey: () => true });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.skipped[0].reason).toMatch(/no app version/i);
  });

  it("compares app versions numerically, not as strings", () => {
    expect(compareAppVersion("1.5.10", "1.5.9")).toBe(1);
    expect(compareAppVersion("1.5.9", "1.5.10")).toBe(-1);
    expect(compareAppVersion("1.5.9", "1.5.9")).toBe(0);
    expect("1.5.10" < "1.5.9").toBe(true); // the bug this avoids
  });

  it("exposes the proxied provider list for a client capability probe", () => {
    const list = proxiedProviders();
    expect(list.length).toBe(GATEWAY_PROVIDERS.length);
    for (const entry of list) {
      expect(entry.key.length).toBeGreaterThan(0);
      expect(["gemini", "openai", "anthropic"]).toContain(entry.dialect);
    }
  });
});

describe("per-user limits and spend control", () => {
  it("allows a request inside every budget", () => {
    const decision = evaluateLimits({ requestsThisMinute: 0, outputTokensToday: 0, estimatedTokensThisRequest: 500 });
    expect(decision.allowed).toBe(true);
    if (decision.allowed) {
      expect(decision.remaining.requestsThisMinute).toBe(DEFAULT_LIMITS.requestsPerMinute - 1);
      expect(decision.remaining.outputTokensToday).toBe(DEFAULT_LIMITS.dailyOutputTokens - 500);
    }
  });

  it("refuses at the per-minute limit and says when to retry", () => {
    const decision = evaluateLimits({ requestsThisMinute: DEFAULT_LIMITS.requestsPerMinute, outputTokensToday: 0, estimatedTokensThisRequest: 10 });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.code).toBe("rate_limited");
      expect(decision.retryAfterSeconds).toBe(60);
    }
  });

  it("refuses when the projected daily output budget would be exceeded", () => {
    const decision = evaluateLimits({
      requestsThisMinute: 0,
      outputTokensToday: DEFAULT_LIMITS.dailyOutputTokens - 10,
      estimatedTokensThisRequest: 500,
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.code).toBe("daily_budget");
      expect(decision.retryAfterSeconds).toBeGreaterThan(0);
    }
  });

  it("refuses an oversized single request before spending anything", () => {
    const decision = evaluateLimits({ requestsThisMinute: 0, outputTokensToday: 0, estimatedTokensThisRequest: DEFAULT_LIMITS.maxTokensPerRequest + 1 });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.code).toBe("request_too_large");
  });

  it("retries ZERO times by default, because the client already backs off", () => {
    // A gateway that also retried would multiply provider spend and hide the
    // backoff signal from the app, which treats 429 as normal backpressure.
    expect(DEFAULT_LIMITS.maxRetries).toBe(0);
  });

  it("estimates tokens as chars/4, matching the app's own estimator", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("a".repeat(4001))).toBe(1001);
  });

  it("resets the daily budget at UTC midnight", () => {
    const before = secondsUntilUtcMidnight(new Date("2026-01-01T23:59:00Z"));
    expect(before).toBeLessThanOrEqual(60);
    expect(before).toBeGreaterThan(0);
    const after = secondsUntilUtcMidnight(new Date("2026-01-01T00:00:01Z"));
    expect(after).toBeGreaterThan(86_000);
  });
});

describe("error classification matches the app's own taxonomy", () => {
  it("maps 401/403 to a PLATFORM key fault, never the user's", () => {
    const classified = classifyError({ providerKey: "gemini", status: 401, body: { error: { message: "API key not valid" } } });
    expect(classified.class).toBe("auth");
    expect(classified.suggestedFix).toBe("platform_key_invalid");
    expect(classified.retryable).toBe(false);
  });

  it("treats Gemini 429 with limit:0 as model-unavailable, NOT quota exhaustion", () => {
    // The exact 0.7.0 finding: this must never be retried and never be called
    // "exhausted".
    const classified = classifyError({
      providerKey: "gemini",
      status: 429,
      body: { error: { message: "Model gemini-x is not available, limit: 0" } },
    });
    expect(classified.class).toBe("model_unavailable");
    expect(classified.retryable).toBe(false);
    expect(classified.suggestedFix).toBe("switch_model");
  });

  it("treats an ordinary 429 as retryable backpressure", () => {
    const classified = classifyError({ providerKey: "openai", status: 429, body: { error: { message: "Rate limit reached" } } });
    expect(classified.class).toBe("rate_limit");
    expect(classified.retryable).toBe(true);
  });

  it("separates a billing 429 from a rate-limit 429", () => {
    const classified = classifyError({ providerKey: "anthropic", status: 429, body: { message: "billing required" } });
    expect(classified.class).toBe("quota");
    expect(classified.retryable).toBe(false);
    expect(classified.suggestedFix).toBe("billing_required");
  });

  it("distinguishes a deprecated model from a merely missing one", () => {
    expect(classifyError({ providerKey: "gemini", status: 404, body: { error: { message: "model is deprecated and phasing out" } } }).class).toBe("model_deprecated");
    expect(classifyError({ providerKey: "gemini", status: 404, body: { error: { message: "models/xyz is not found" } } }).class).toBe("model_unavailable");
  });

  it("flags an unsupported reasoning/search parameter distinctly", () => {
    const classified = classifyError({ providerKey: "mistral", status: 400, body: { detail: "unexpected parameter reasoning_effort" } });
    expect(classified.class).toBe("bad_request");
    expect(classified.suggestedFix).toBe("strip_unsupported_param");
  });

  it("parses every error envelope shape the app speaks", () => {
    expect(extractMessage({ error: "xAI string error" })).toBe("xAI string error");
    expect(extractMessage({ error: { message: "openai nested" } })).toBe("openai nested");
    expect(extractMessage({ detail: "mistral detail" })).toBe("mistral detail");
    expect(extractMessage({ detail: [{ msg: "mistral array" }] })).toBe("mistral array");
    expect(extractMessage({ message: "anthropic message" })).toBe("anthropic message");
    expect(extractMessage({})).toMatch(/unrecognised/i);
    expect(extractMessage(undefined, "TimeoutError")).toBe("TimeoutError");
  });

  it("classifies transport failures as timeout or network, both retryable", () => {
    expect(classifyError({ providerKey: "gemini", status: null, transportError: "TimeoutError" }).class).toBe("timeout");
    expect(classifyError({ providerKey: "gemini", status: null, transportError: "fetch failed" }).class).toBe("network");
    expect(classifyError({ providerKey: "gemini", status: null, transportError: "fetch failed" }).retryable).toBe(true);
  });

  it("treats a truncated reply as an error, never as a half-saved draft", () => {
    const problem = classifyReplyProblem({ text: "See you Fri", truncated: true });
    expect(problem?.class).toBe("truncated_response");
    expect(problem?.suggestedFix).toBe("raise_output_cap");
  });

  it("treats an empty reply as an error", () => {
    expect(classifyReplyProblem({ text: "   ", truncated: false })?.class).toBe("empty_response");
  });

  it("returns null for a usable reply", () => {
    expect(classifyReplyProblem({ text: "See you Friday!", truncated: false })).toBeNull();
  });

  it("never echoes a long provider body, which could reflect user content", () => {
    const long = "x".repeat(5000);
    expect(extractMessage({ error: long }).length).toBeLessThanOrEqual(201);
  });
});

describe("attribution is accurate", () => {
  it("names the provider and model that actually served", () => {
    const attribution = attribute("anthropic", "claude-haiku-4-5");
    expect(attribution.providerLabel).toBe("Anthropic (Claude)");
    expect(attribution.model).toBe("claude-haiku-4-5");
    expect(attribution.dialect).toBe("anthropic");
    expect(attribution.served).toBe(true);
  });

  it("records when a fallback served instead of what was requested", () => {
    const attribution = attribute("anthropic", "claude-haiku-4-5", { providerKey: "gemini", model: "gemini-2.5-flash" });
    expect(attribution.served).toBe(false);
    expect(attribution.requestedProviderKey).toBe("gemini");
    expect(attribution.requestedModel).toBe("gemini-2.5-flash");
  });

  it("does not invent a label for an unknown provider", () => {
    expect(attribute("invented", "x").providerLabel).toBe("invented");
  });
});

describe("master-key handling never leaks a value", () => {
  const secrets: Record<string, string> = {
    GEMINI_MASTER_KEY: "primary-gemini-value",
    GEMINI_MASTER_KEY_NEXT: "successor-gemini-value",
    ANTHROPIC_MASTER_KEY: "primary-anthropic-value",
  };
  const resolver = createKeyResolver({
    providerKeys: ["gemini", "anthropic", "openai"],
    readSecret: (name) => secrets[name],
  });

  it("reports availability without exposing values", () => {
    expect(resolver.available("gemini")).toBe(true);
    expect(resolver.available("openai")).toBe(false);
    const report = resolver.report();
    expect(report.find((r) => r.providerKey === "gemini")).toEqual({ providerKey: "gemini", primary: true, next: true });
    expect(JSON.stringify(report)).not.toContain("primary-gemini-value");
  });

  it("prefers the primary slot by default", () => {
    expect(resolver.resolve("gemini")?.slot).toBe("primary");
  });

  it("prefers the successor slot for a provider mid-rotation", () => {
    const rotating = createKeyResolver({
      providerKeys: ["gemini"],
      readSecret: (name) => secrets[name],
      rotating: ["gemini"],
    });
    expect(rotating.resolve("gemini")?.slot).toBe("next");
  });

  it("skips a slot known to be failing auth", () => {
    const withBad = createKeyResolver({
      providerKeys: ["gemini"],
      readSecret: (name) => secrets[name],
      knownBad: [{ providerKey: "gemini", slot: "primary" }],
    });
    expect(withBad.resolve("gemini")?.slot).toBe("next");
  });

  it("returns null when every slot is bad or absent", () => {
    expect(
      createKeyResolver({
        providerKeys: ["openai"],
        readSecret: (name) => secrets[name],
      }).resolve("openai"),
    ).toBeNull();
  });

  it("names the secret rather than carrying the value in a loggable object", () => {
    const resolved = resolver.resolve("gemini");
    expect(resolved?.secretName).toBe("GEMINI_MASTER_KEY");
    expect(JSON.stringify(resolved)).not.toContain("primary-gemini-value");
  });

  it("reads the value only at the moment of the call", () => {
    const resolved = resolver.resolve("anthropic")!;
    expect(readKeyValue(resolved, (name) => secrets[name])).toBe("primary-anthropic-value");
    expect(readKeyValue(resolved, () => undefined)).toBeNull();
  });

  it("describes a key by length only", () => {
    expect(describeKey("a-secret")).toBe("set (8 chars)");
    expect(describeKey(null)).toBe("absent");
    expect(describeKey("a-secret")).not.toContain("a-secret");
  });

  it("generates stable, namespaced secret names", () => {
    expect(secretNamesFor("gemini")).toEqual({ primary: "GEMINI_MASTER_KEY", next: "GEMINI_MASTER_KEY_NEXT" });
  });
});
