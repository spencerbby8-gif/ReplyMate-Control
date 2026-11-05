import { describe, expect, it } from "vitest";
import {
  CHANNELS,
  FALLBACK_SEARCH,
  OUTPUT_CAP_RULE,
  PROVIDER_CATALOGUE,
  TASK_CATALOGUE,
  effectiveOutputCap,
  providerByKey,
} from "@/config/catalog";

/**
 * The catalogue must stay a faithful transcription of the Android client.
 * Expected values come from src/com/replymate/core/model/ProviderType.java and
 * docs/provider-capability-map.md in spencerbby8-gif/ReplyMate.
 */

const EXPECTED_PROVIDERS: Record<string, { label: string; baseUrl: string; style: string; needsKey: boolean }> = {
  gemini: { label: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com", style: "gemini", needsKey: true },
  openai: { label: "OpenAI", baseUrl: "https://api.openai.com/v1", style: "openai", needsKey: true },
  openrouter: { label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", style: "openai", needsKey: true },
  anthropic: { label: "Anthropic (Claude)", baseUrl: "https://api.anthropic.com", style: "anthropic", needsKey: true },
  deepseek: { label: "DeepSeek", baseUrl: "https://api.deepseek.com", style: "openai", needsKey: true },
  grok: { label: "Grok (xAI)", baseUrl: "https://api.x.ai/v1", style: "openai", needsKey: true },
  kimi: { label: "Kimi (Moonshot)", baseUrl: "https://api.moonshot.ai/v1", style: "openai", needsKey: true },
  mistral: { label: "Mistral", baseUrl: "https://api.mistral.ai/v1", style: "openai", needsKey: true },
  ollama: { label: "Ollama (local)", baseUrl: "http://localhost:11434/v1", style: "openai", needsKey: false },
  openai_compat: { label: "Other (OpenAI-compatible)", baseUrl: "", style: "openai", needsKey: true },
};

describe("provider catalogue matches ProviderType.java", () => {
  it("lists exactly the ten providers the client implements", () => {
    expect(PROVIDER_CATALOGUE.map((p) => p.key).sort()).toEqual(Object.keys(EXPECTED_PROVIDERS).sort());
  });

  it.each(Object.entries(EXPECTED_PROVIDERS))("describes %s faithfully", (key, expected) => {
    const provider = providerByKey(key);
    expect(provider, `${key} missing from the catalogue`).toBeDefined();
    expect(provider?.displayName).toBe(expected.label);
    expect(provider?.defaultBaseUrl).toBe(expected.baseUrl);
    expect(provider?.apiStyle).toBe(expected.style);
    expect(provider?.needsKey).toBe(expected.needsKey);
  });

  it("marks every provider BYOK — keys never live on a server", () => {
    for (const provider of PROVIDER_CATALOGUE) {
      expect(provider.byokOnly).toBe(true);
    }
  });

  it("speaks only the three documented dialects", () => {
    const allowed = new Set(["generateContent", "chat/completions", "messages", "responses"]);
    for (const provider of PROVIDER_CATALOGUE) {
      for (const dialect of provider.dialects) {
        expect(allowed.has(dialect), `${provider.key} claims unknown dialect ${dialect}`).toBe(true);
      }
    }
  });

  it("records Anthropic and Mistral reasoning as family-split, per the capability map", () => {
    expect(providerByKey("anthropic")?.reasoningSupport).toBe("family_split");
    expect(providerByKey("mistral")?.reasoningSupport).toBe("family_split");
  });

  it("records DeepSeek, Mistral, Ollama and openai_compat search as fallback or none", () => {
    expect(providerByKey("deepseek")?.searchSupport).toBe("fallback");
    expect(providerByKey("mistral")?.searchSupport).toBe("fallback");
    expect(providerByKey("ollama")?.searchSupport).toBe("fallback");
    expect(providerByKey("openai_compat")?.searchSupport).toBe("fallback");
  });

  it("never claims a capability the transport reports as NONE", () => {
    expect(providerByKey("ollama")?.reasoningSupport).toBe("none");
    expect(providerByKey("openai_compat")?.reasoningSupport).toBe("none");
  });

  it("carries a capability note citing real behaviour for every provider", () => {
    for (const provider of PROVIDER_CATALOGUE) {
      expect(provider.capabilityNote.length, `${provider.key} has no capability note`).toBeGreaterThan(40);
    }
  });

  it("returns undefined for an unknown provider instead of defaulting", () => {
    expect(providerByKey("does-not-exist")).toBeUndefined();
  });
});

describe("output cap rule (P-background-8 amendment)", () => {
  it("adds nothing when thinking is off", () => {
    expect(effectiveOutputCap("none")).toBe(OUTPUT_CAP_RULE.baselineChatCap);
  });

  it("adds the thinking budget plus reply headroom for low", () => {
    expect(effectiveOutputCap("low")).toBe(220 + 1024 + 256);
  });

  it("adds the thinking budget plus reply headroom for high", () => {
    expect(effectiveOutputCap("high")).toBe(220 + 4096 + 256);
  });

  it("is monotonic in the thinking level", () => {
    expect(effectiveOutputCap("none")).toBeLessThan(effectiveOutputCap("low"));
    expect(effectiveOutputCap("low")).toBeLessThan(effectiveOutputCap("high"));
  });

  it("respects a custom baseline", () => {
    expect(effectiveOutputCap("low", 512)).toBe(512 + 1024 + 256);
  });

  it("documents the failure mode it prevents", () => {
    expect(OUTPUT_CAP_RULE.description).toMatch(/inside the output cap/i);
    expect(OUTPUT_CAP_RULE.source).toContain("provider-capability-map.md");
  });
});

describe("task catalogue", () => {
  it("covers every generation task the client performs", () => {
    expect(TASK_CATALOGUE.map((t) => t.key).sort()).toEqual(
      ["assistant", "background", "extract", "reply", "style", "summary"].sort(),
    );
  });

  it("has a unique key, label and description per task", () => {
    const keys = TASK_CATALOGUE.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const task of TASK_CATALOGUE) {
      expect(task.label.length).toBeGreaterThan(2);
      expect(task.description.length).toBeGreaterThan(10);
    }
  });
});

describe("fallback retrieval backend", () => {
  it("is key-less Wikimedia REST only", () => {
    expect(FALLBACK_SEARCH.endpoints).toHaveLength(2);
    for (const endpoint of FALLBACK_SEARCH.endpoints) {
      expect(endpoint.startsWith("https://en.wikipedia.org/") || endpoint.startsWith("https://en.wiktionary.org/")).toBe(true);
    }
  });

  it("declares itself encyclopedic rather than live", () => {
    expect(FALLBACK_SEARCH.honesty).toMatch(/encyclopedic/i);
    expect(FALLBACK_SEARCH.honesty).toMatch(/not invent/i);
  });

  it("carries the tight transport that protects background drafts", () => {
    expect(FALLBACK_SEARCH.transport.perCallTimeoutMs).toBe(2500);
    expect(FALLBACK_SEARCH.transport.hardTimeoutMs).toBe(4000);
    expect(FALLBACK_SEARCH.transport.totalBudgetMs).toBe(9000);
  });
});

describe("channel set (cloud migration 0002 parity)", () => {
  it("includes the original two plus the widened P3 set", () => {
    for (const channel of ["whatsapp", "telegram", "discord", "signal", "messenger", "instagram", "x", "tiktok", "slack", "manual"]) {
      expect(CHANNELS).toContain(channel);
    }
  });
});
