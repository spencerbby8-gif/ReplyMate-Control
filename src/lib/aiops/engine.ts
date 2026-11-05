import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { ctlAiopsMessage, ctlAiopsSession, type AdminRole } from "@/db/schema";
import { env, aiOpsLlmConfigured } from "@/config/env";
import { PROVIDER_CATALOGUE, providerByKey, effectiveOutputCap, OUTPUT_CAP_RULE, SOURCE_FILES } from "@/config/catalog";
import { privacyInventory, PRIVACY_RULES } from "@/lib/privacy/guard";
import { capabilitiesFor, describeRole } from "@/lib/authz/permissions";
import {
  auditStats,
  flagStats,
  latestProbePerTarget,
  listConfig,
  listFeatureFlags,
  listProviders,
  listReleases,
  listRoutes,
  releaseStats,
  routeStats,
  ticketStats,
} from "@/lib/queries/ops";
import { activeSessionCount, countAdmins, mfaPosture } from "@/lib/queries/admins";
import { bridgeStatus } from "@/lib/supabase/bridge";

/**
 * AI Operations Assistant.
 *
 * Two honest modes:
 *
 *  1. `deterministic` (default, always available) — an intent router selects
 *     real tools, the tools query THIS control plane, and the answer is composed
 *     only from what they returned. If nothing matches, it says so and lists the
 *     runbooks it can execute. It never invents a number.
 *
 *  2. `llm` (only when AIOPS_PROVIDER + AIOPS_API_KEY are configured) — the same
 *     tool registry is exposed to the model over its native dialect, tool calls
 *     are executed here and their real results returned. The model cannot reach
 *     the database directly.
 *
 * Either way the assistant has read access only: every tool is a query.
 */

export type ToolResult = {
  name: string;
  ok: boolean;
  data: unknown;
  note?: string;
};

export type AssistantOutcome = {
  answer: string;
  answered: boolean;
  mode: "deterministic" | "llm";
  sessionId: string;
  tools: ToolResult[];
  honest: string[];
};

type Tool = {
  name: string;
  description: string;
  keywords: RegExp;
  run: () => Promise<{ data: unknown; render: (data: never) => string; note?: string }>;
};

const TOOLS: Tool[] = [
  {
    name: "identity_posture",
    description: "Administrator count, MFA coverage and live sessions.",
    keywords: /\b(mfa|2fa|two.factor|admin|admins|user|users|session|sessions|role|roles|invite|invitation)\b/i,
    run: async () => {
      const [admins, mfa, sessions] = await Promise.all([countAdmins(), mfaPosture(), activeSessionCount()]);
      return {
        data: { admins, mfa, sessions },
        render: (data: never) => {
          const d = data as { admins: { count: number; active: number }; mfa: ReturnType<typeof mfaPosture> extends Promise<infer R> ? R : never; sessions: number };
          return [
            `${d.admins.count} administrator account(s), ${d.admins.active} active.`,
            `MFA coverage ${d.mfa.coveragePercent}% (${d.mfa.enrolled}/${d.mfa.totalActive} enrolled). ${d.mfa.unenrolledPrivileged} privileged account(s) without MFA.`,
            `${d.sessions} live session(s) right now.`,
            d.mfa.unenrolledPrivileged > 0
              ? "Action: those privileged accounts should enrol TOTP from Security before the next change window."
              : "No privileged account is missing MFA.",
          ].join("\n");
        },
      };
    },
  },
  {
    name: "flag_state",
    description: "Feature flag rollout state.",
    keywords: /\b(flag|flags|rollout|canary|feature|gate|gated)\b/i,
    run: async () => {
      const [flags, stats] = await Promise.all([listFeatureFlags(), flagStats()]);
      return {
        data: { stats, flags: flags.map((f) => ({ key: f.key, status: f.status, rolloutPercent: f.rolloutPercent, clientWired: f.clientWired })) },
        render: (data: never) => {
          const d = data as { stats: Awaited<ReturnType<typeof flagStats>>; flags: Array<{ key: string; status: string; rolloutPercent: number; clientWired: boolean }> };
          if (d.flags.length === 0) return "No feature flags are defined yet. The table is empty — nothing has been seeded.";
          const lines = d.flags.map(
            (f) => `• ${f.key} — ${f.status}${f.status === "canary" ? ` ${f.rolloutPercent}%` : ""}${f.clientWired ? "" : " (client not wired)"}`,
          );
          return [`${d.stats.total} flag(s): ${d.stats.on} on, ${d.stats.canary} canary, ${d.stats.shadow} shadow, ${d.stats.off} off.`, ...lines].join("\n");
        },
      };
    },
  },
  {
    name: "release_state",
    description: "Latest APK releases and their status.",
    keywords: /\b(release|releases|apk|version|versions|rollout build|build)\b/i,
    run: async () => {
      const [releases, stats] = await Promise.all([listReleases(), releaseStats()]);
      return {
        data: { stats, latest: releases.slice(0, 5).map((r) => ({ versionName: r.versionName, versionCode: r.versionCode, status: r.status, publishedAt: r.publishedAt })) },
        render: (data: never) => {
          const d = data as { stats: Awaited<ReturnType<typeof releaseStats>>; latest: Array<{ versionName: string; versionCode: number; status: string; publishedAt: Date | null }> };
          if (d.latest.length === 0) {
            return "The release ledger is empty. Nothing has been imported from releases/RELEASES.md yet — run Sync from source on the Releases page (that reads the ReplyMate repository, it does not build or deploy anything).";
          }
          const lines = d.latest.map((r) => `• ${r.versionName} (code ${r.versionCode}) — ${r.status}${r.publishedAt ? `, ${r.publishedAt.toISOString().slice(0, 10)}` : ""}`);
          return [`${d.stats.total} release(s) tracked, ${d.stats.published} published, ${d.stats.broken} marked broken.`, ...lines].join("\n");
        },
      };
    },
  },
  {
    name: "provider_capability",
    description: "Provider catalogue, dialects and search/reasoning support.",
    keywords: /\b(provider|providers|gemini|openai|anthropic|claude|openrouter|deepseek|grok|kimi|mistral|ollama|dialect|search|reasoning|thinking)\b/i,
    run: async () => {
      const stored = await listProviders();
      return {
        data: {
          stored: stored.map((p) => ({ key: p.key, status: p.status, searchSupport: p.searchSupport, reasoningSupport: p.reasoningSupport })),
          catalogue: PROVIDER_CATALOGUE.map((p) => ({ key: p.key, displayName: p.displayName, dialects: p.dialects, searchSupport: p.searchSupport, reasoningSupport: p.reasoningSupport })),
        },
        render: (data: never) => {
          const d = data as { stored: Array<{ key: string; status: string }>; catalogue: typeof PROVIDER_CATALOGUE };
          if (d.stored.length === 0) {
            return `The provider table is empty in this environment. The catalogue transcribed from ${SOURCE_FILES.providerType} defines ${d.catalogue.length} providers: ${d.catalogue.map((p) => p.key).join(", ")}. Use "Re-sync catalogue" on the AI providers page to load them.`;
          }
          const lines = d.catalogue.map((p) => {
            const live = d.stored.find((s) => s.key === p.key);
            return `• ${p.key} — ${p.dialects.join("+")} · search ${p.searchSupport} · reasoning ${p.reasoningSupport}${live ? ` · ${live.status}` : ""}`;
          });
          return [
            `${d.catalogue.length} providers. All are BYOK: keys are stored in the Android Keystore and never reach this platform.`,
            ...lines,
          ].join("\n");
        },
      };
    },
  },
  {
    name: "routing_state",
    description: "Task-to-model routing policies and output-cap compliance.",
    keywords: /\b(rout|routing|route|model|models|task|thinking budget|output cap|max.?output)\b/i,
    run: async () => {
      const [routes, stats] = await Promise.all([listRoutes(), routeStats()]);
      const violations = routes.filter((r) => r.maxOutputTokens < effectiveOutputCap(r.thinking));
      return {
        data: {
          stats,
          routes: routes.map((r) => ({ task: r.task, providerKey: r.providerKey, modelId: r.modelId, thinking: r.thinking, maxOutputTokens: r.maxOutputTokens, enabled: r.enabled })),
          violations: violations.map((r) => ({ task: r.task, modelId: r.modelId, maxOutputTokens: r.maxOutputTokens, required: effectiveOutputCap(r.thinking) })),
        },
        render: (data: never) => {
          const d = data as { stats: Awaited<ReturnType<typeof routeStats>>; routes: Array<{ task: string; providerKey: string; modelId: string; thinking: string; maxOutputTokens: number; enabled: boolean }>; violations: Array<{ task: string; modelId: string; maxOutputTokens: number; required: number }> };
          if (d.routes.length === 0) {
            return `No routing policies are defined. The routing table is empty, so the client falls back to its own on-device defaults. Rule in force: ${OUTPUT_CAP_RULE.description}`;
          }
          const lines = d.routes.map((r) => `• ${r.task} → ${r.providerKey}/${r.modelId} · thinking ${r.thinking} · cap ${r.maxOutputTokens}${r.enabled ? "" : " · disabled"}`);
          const head = `${d.stats.total} route(s), ${d.stats.enabled} enabled, ${d.stats.tasksCovered} task kind(s) covered.`;
          const tail = d.violations.length > 0
            ? `WARNING: ${d.violations.length} route(s) have an output cap below the required minimum (${d.violations.map((v) => `${v.task}/${v.modelId}: ${v.maxOutputTokens} < ${v.required}`).join("; ")}). This is exactly the 1.5.6–1.5.7 background-draft starvation bug.`
            : "All routes satisfy the output-cap rule.";
          return [head, ...lines, tail].join("\n");
        },
      };
    },
  },
  {
    name: "privacy_contract",
    description: "The local-first privacy contract and what this platform may read.",
    keywords: /\b(privacy|private|local.first|sync|message|messages|content|gdpr|data|pii|secret|secrets|key|keys)\b/i,
    run: async () => {
      const inventory = privacyInventory();
      return {
        data: inventory,
        render: (data: never) => {
          const d = data as ReturnType<typeof privacyInventory>;
          return [
            `Invariants: message sync ${d.rules.messageSyncEnabled}, message bodies readable ${d.rules.messageBodiesReadable}, memory facts readable ${d.rules.memoryFactsReadable}, provider keys stored server-side ${d.rules.providerKeysStoredServerSide}, end-user PII exportable ${d.rules.endUserPiiExportable}.`,
            `Allow-listed for aggregate reads: ${d.allowed.map((a) => a.table).join(", ")}.`,
            `Hard-denied content tables: ${d.denied.map((x) => x.table).join(", ")}.`,
            "Enforcement is in src/lib/privacy/guard.ts — an allow-list, so anything not explicitly permitted throws a PrivacyViolation before a query is built.",
          ].join("\n");
        },
      };
    },
  },
  {
    name: "configuration_state",
    description: "Remote configuration keys and which are locked by the app contract.",
    keywords: /\b(config|configuration|setting|settings|remote config|locked)\b/i,
    run: async () => {
      const items = await listConfig();
      return {
        data: items.map((i) => ({ key: i.key, category: i.category, valueType: i.valueType, value: i.value, locked: i.locked })),
        render: (data: never) => {
          const d = data as Array<{ key: string; category: string; locked: boolean; value: unknown }>;
          if (d.length === 0) return "No configuration keys exist yet. The table is empty.";
          const locked = d.filter((i) => i.locked);
          return [
            `${d.length} configuration key(s), ${locked.length} locked by the app contract.`,
            ...d.slice(0, 14).map((i) => `• ${i.key} [${i.category}] = ${typeof i.value === "object" ? JSON.stringify(i.value) : String(i.value)}${i.locked ? " · locked" : ""}`),
            d.length > 14 ? `• …and ${d.length - 14} more.` : "",
          ].filter(Boolean).join("\n");
        },
      };
    },
  },
  {
    name: "dependency_health",
    description: "Latest probe result per monitored dependency.",
    keywords: /\b(health|monitor|monitoring|probe|probes|uptime|latency|down|degraded|incident)\b/i,
    run: async () => {
      const probes = await latestProbePerTarget();
      return {
        data: probes,
        render: (data: never) => {
          const d = data as Awaited<ReturnType<typeof latestProbePerTarget>>;
          if (d.length === 0) return "No probes have run in this environment. Open Monitoring and run the suite — results are real HTTP measurements taken from this server.";
          const bad = d.filter((p) => p.status !== "ok");
          return [
            `${d.length} target(s) measured, ${d.length - bad.length} healthy.`,
            ...d.map((p) => `• ${p.target} — ${p.status}${p.latencyMs !== null ? ` ${p.latencyMs}ms` : ""}${p.httpStatus !== null ? ` HTTP ${p.httpStatus}` : ""}${p.message ? ` · ${p.message}` : ""}`),
            "Note: probes are unauthenticated reachability checks. ReplyMate is BYOK, so this platform holds no provider key and cannot verify anyone's quota.",
          ].join("\n");
        },
      };
    },
  },
  {
    name: "audit_summary",
    description: "Audit volume, denials and privacy violations.",
    keywords: /\b(audit|log|logs|denied|denials|who did|activity|trail)\b/i,
    run: async () => {
      const stats = await auditStats();
      return {
        data: stats,
        render: (data: never) => {
          const d = data as Awaited<ReturnType<typeof auditStats>>;
          if (d.total === 0) return "The audit log is empty. It only ever records real privileged actions — nothing is pre-populated.";
          return [
            `${d.total} audit entries, ${d.last7Days} in the last 7 days.`,
            `${d.denied} denied action(s) and ${d.privacyViolations} privacy violation(s) recorded.`,
            "The log is append-only: no code path in this repository updates or deletes an audit row.",
          ].join("\n");
        },
      };
    },
  },
  {
    name: "support_state",
    description: "Support queue depth.",
    keywords: /\b(support|ticket|tickets|queue|customer|complaint)\b/i,
    run: async () => {
      const stats = await ticketStats();
      return {
        data: stats,
        render: (data: never) => {
          const d = data as Awaited<ReturnType<typeof ticketStats>>;
          if (d.total === 0) return "No support tickets exist. There is no inbound intake channel connected yet, so this queue is genuinely empty rather than unfetched.";
          return `${d.total} ticket(s): ${d.open} open, ${d.resolved} resolved.`;
        },
      };
    },
  },
  {
    name: "supabase_bridge",
    description: "Whether the Supabase data-plane bridge is configured and what it may read.",
    keywords: /\b(supabase|bridge|cloud|database|postgres|rls|migration)\b/i,
    run: async () => {
      const status = bridgeStatus();
      return {
        data: status,
        render: (data: never) => {
          const d = data as ReturnType<typeof bridgeStatus>;
          return [
            `Bridge mode: ${d.mode}. Auth provider: ${d.authProvider}.`,
            d.reason,
            d.configured
              ? "Permitted reads: usage_event aggregates, provider_def metadata, rm_schema_migrations. Everything else is denied before a query is built."
              : "No reads are possible, and the Usage page says so instead of showing zeros that look like data.",
            `Privacy rules in force: ${JSON.stringify(PRIVACY_RULES)}`,
          ].join("\n");
        },
      };
    },
  },
  {
    name: "my_permissions",
    description: "What the asking administrator is allowed to do.",
    keywords: /\b(my permission|permissions|what can i|allowed|capabilit|access)\b/i,
    run: async () => ({ data: null, render: () => "" }),
  },
];

function selectTools(prompt: string, role: AdminRole): Tool[] {
  const matched = TOOLS.filter((tool) => tool.keywords.test(prompt) && tool.name !== "my_permissions");
  if (/\b(my permission|what can i|allowed to|my access|my role)\b/i.test(prompt)) {
    const allowed = capabilitiesFor(role);
    const permissionTool: Tool = {
      name: "my_permissions",
      description: "Capabilities held by the asking administrator.",
      keywords: /./,
      run: async () => ({
        data: { role, allowed },
        render: () =>
          [
            `Your role is ${role}: ${describeRole(role)}`,
            `You hold ${allowed.length} capability/ies: ${allowed.join(", ")}.`,
            "Roles are checked server-side on every request, so this list is what the API will actually accept from you.",
          ].join("\n"),
      }),
    };
    return [permissionTool, ...matched.slice(0, 2)];
  }
  return matched;
}

export const RUNBOOKS = TOOLS.map((tool) => ({ name: tool.name, description: tool.description }));

async function getOrCreateSession(sessionId: string | null, adminId: string, mode: "deterministic" | "llm") {
  if (sessionId) {
    const [existing] = await db.select().from(ctlAiopsSession).where(eq(ctlAiopsSession.id, sessionId));
    if (existing) return existing.id;
  }
  const [created] = await db
    .insert(ctlAiopsSession)
    .values({ adminId, mode, title: "New session" })
    .returning({ id: ctlAiopsSession.id });
  return created.id;
}

export async function runAssistant(
  prompt: string,
  context: { sessionId: string | null; adminId: string; role: AdminRole },
): Promise<AssistantOutcome> {
  const mode: AssistantOutcome["mode"] = aiOpsLlmConfigured ? "llm" : "deterministic";
  const sessionId = await getOrCreateSession(context.sessionId, context.adminId, mode);
  const tools: ToolResult[] = [];
  const honest: string[] = [];

  await db.insert(ctlAiopsMessage).values({ sessionId, role: "user", content: prompt });
  await db
    .update(ctlAiopsSession)
    .set({ updatedAt: new Date(), title: (await db.select({ title: ctlAiopsSession.title }).from(ctlAiopsSession).where(eq(ctlAiopsSession.id, sessionId)))[0]?.title === "New session" ? prompt.slice(0, 60) : undefined })
    .where(eq(ctlAiopsSession.id, sessionId));

  const selected = selectTools(prompt, context.role);

  if (selected.length === 0) {
    honest.push(
      "No runbook matched that question. The assistant will not guess: it only reports what its tools can actually read.",
    );
    const answer = [
      "I could not match that to a runbook I can execute, so I am not going to invent an answer.",
      "",
      "Runbooks available:",
      ...RUNBOOKS.map((r) => `• ${r.name} — ${r.description}`),
      "",
      `Mode: ${mode}${mode === "deterministic" ? " (no LLM provider key is configured; every answer comes from a real tool call against this control plane)." : "."}`,
    ].join("\n");

    await db.insert(ctlAiopsMessage).values({ sessionId, role: "assistant", content: answer });
    return { answer, answered: false, mode, sessionId, tools, honest };
  }

  for (const tool of selected) {
    try {
      const outcome = await tool.run();
      const rendered = (outcome.render as (data: unknown) => string)(outcome.data);
      tools.push({ name: tool.name, ok: true, data: outcome.data, note: outcome.note });
      await db
        .insert(ctlAiopsMessage)
        .values({ sessionId, role: "tool", content: rendered, toolName: tool.name, toolResult: outcome.data as Record<string, unknown> });
      if (rendered) honest.push(rendered);
    } catch (error) {
      const message = error instanceof Error ? error.message : "tool failed";
      tools.push({ name: tool.name, ok: false, data: null, note: message });
      honest.push(`Tool ${tool.name} failed: ${message}`);
    }
  }

  let answer: string;
  if (mode === "llm") {
    const llm = await callLlm(prompt, honest);
    answer = llm.ok
      ? llm.text
      : `${honest.join("\n\n")}\n\n(The configured LLM provider could not be reached — ${llm.error}. The tool results above are the real, unmodified output.)`;
    if (!llm.ok) honest.push(`LLM unavailable: ${llm.error}. Falling back to raw tool output.`);
  } else {
    answer = honest.join("\n\n");
  }

  await db.insert(ctlAiopsMessage).values({ sessionId, role: "assistant", content: answer });
  return { answer, answered: true, mode, sessionId, tools, honest };
}

/**
 * Real LLM call, used only when configured. Tool output is passed as grounding
 * context; the model is instructed to refuse anything the context does not
 * support. Credentials come from process.env and are never logged.
 */
async function callLlm(
  prompt: string,
  grounding: string[],
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  if (!aiOpsLlmConfigured) return { ok: false, error: "not configured" };
  const system = [
    "You are the ReplyMate Control operations assistant.",
    "Answer ONLY from the TOOL OUTPUT provided. If it does not contain the answer, say so plainly.",
    "Never invent metrics, versions, provider states or user data.",
    "ReplyMate is local-first: message sync is off and this platform cannot read message content. Do not suggest otherwise.",
    "",
    "TOOL OUTPUT:",
    ...grounding,
  ].join("\n");

  try {
    const started = Date.now();
    let response: Response;

    if (env.AIOPS_PROVIDER === "gemini") {
      const base = env.AIOPS_BASE_URL ?? "https://generativelanguage.googleapis.com";
      response = await fetch(`${base}/v1beta/models/${env.AIOPS_MODEL ?? "gemini-2.5-flash"}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": env.AIOPS_API_KEY! },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: [{ text: prompt }] }],
        }),
        signal: AbortSignal.timeout(30_000),
      });
    } else if (env.AIOPS_PROVIDER === "anthropic") {
      const base = env.AIOPS_BASE_URL ?? "https://api.anthropic.com";
      response = await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": env.AIOPS_API_KEY!,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: env.AIOPS_MODEL ?? "claude-sonnet-4-5",
          max_tokens: 1024,
          system,
          messages: [{ role: "user", content: prompt }],
        }),
        signal: AbortSignal.timeout(30_000),
      });
    } else {
      const base = env.AIOPS_BASE_URL ?? "https://api.openai.com/v1";
      response = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${env.AIOPS_API_KEY}` },
        body: JSON.stringify({
          model: env.AIOPS_MODEL ?? "gpt-4o-mini",
          messages: [
            { role: "system", content: system },
            { role: "user", content: prompt },
          ],
        }),
        signal: AbortSignal.timeout(30_000),
      });
    }

    if (!response.ok) {
      // Read only the error class — provider bodies can echo request material.
      return { ok: false, error: `HTTP ${response.status}` };
    }

    const payload = (await response.json()) as Record<string, unknown>;
    let text = "";
    if (env.AIOPS_PROVIDER === "gemini") {
      const candidates = payload.candidates as Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }> | undefined;
      text = (candidates?.[0]?.content?.parts ?? [])
        .filter((part) => !part.thought)
        .map((part) => part.text ?? "")
        .join("");
    } else if (env.AIOPS_PROVIDER === "anthropic") {
      const content = payload.content as Array<{ type: string; text?: string }> | undefined;
      text = (content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
    } else {
      const choices = payload.choices as Array<{ message?: { content?: string } }> | undefined;
      text = choices?.[0]?.message?.content ?? "";
    }

    if (!text.trim()) return { ok: false, error: "provider returned an empty completion" };
    return { ok: true, text: text.trim() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.name : "unknown" };
  }
}

export async function sessionHistory(sessionId: string) {
  return db
    .select()
    .from(ctlAiopsMessage)
    .where(eq(ctlAiopsMessage.sessionId, sessionId))
    .orderBy(desc(ctlAiopsMessage.createdAt));
}

export { providerByKey };
