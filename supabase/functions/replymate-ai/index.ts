/**
 * ReplyMate AI Gateway — Supabase Edge Function.
 *
 *   STATUS: PREPARED, **NOT DEPLOYED**.
 *   Deploying is a production change requiring owner approval and a Supabase
 *   access token, neither of which this work has. See
 *   docs/task-summaries/TASK-005.md.
 *
 * WHAT IT IS FOR
 * ReplyMate ships BYOK: the user pastes their own provider key, encrypted in the
 * Android Keystore, never leaving the device. That path is unchanged and is NOT
 * routed through this function. This function is for a future "built-in AI"
 * option where the platform holds a master key — so that option can exist without
 * ever shipping a platform key inside an APK.
 *
 * HARD RULES
 *  1. Master keys live in function secrets only. Never a database table, never a
 *     response body, never a log line.
 *  2. The caller must present a valid Supabase access token.
 *  3. No message content is logged, stored or echoed. Provider error bodies are
 *     reduced to a short class and message, because a body can reflect request
 *     material — here, fragments of a user's conversation.
 *  4. Conversation history is never persisted. Turns arrive in the request and
 *     leave in the response. Nothing is written to message, draft or any content
 *     table.
 *  5. Usage accounting writes counts only (tokens in/out, model, kind).
 *  6. A client-supplied provider key is REFUSED: BYOK never transits the platform.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  GATEWAY_PROVIDERS,
  attribute,
  parseReply,
  prepareCall,
  providerByKey,
  type GatewayRequest,
} from "../_shared/ai-gateway/catalogue.ts";
import { resolveRoute, type RoutePolicy } from "../_shared/ai-gateway/routing.ts";
import { DEFAULT_LIMITS, estimateTokens, evaluateLimits } from "../_shared/ai-gateway/limits.ts";
import { classifyError, classifyReplyProblem } from "../_shared/ai-gateway/errors.ts";
import { createKeyResolver, readKeyValue, type ResolvedKey } from "../_shared/ai-gateway/keys.ts";

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type, x-replymate-app-version",
  "access-control-allow-methods": "POST, OPTIONS",
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS },
  });
}

/** Redacts anything credential-shaped before it can reach a log. */
function safeLog(label: string, detail: Record<string, unknown>): void {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(detail)) {
    if (/key|secret|token|authorization|password/i.test(key)) clean[key] = "[redacted]";
    else if (typeof value === "string" && value.length > 200) clean[key] = `${value.slice(0, 200)}…`;
    else clean[key] = value;
  }
  console.log(`[replymate-ai] ${label}`, clean);
}

Deno.serve(async (request: Request): Promise<Response> => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (request.method !== "POST") return json({ error: "POST only" }, 405);

  const started = Date.now();

  // 1. Platform configuration ------------------------------------------------
  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
  if (!url || !anonKey) {
    safeLog("missing platform env", { hasUrl: Boolean(url), hasAnonKey: Boolean(anonKey) });
    return json({ error: "Gateway is not configured." }, 503);
  }

  // 2. Authenticate the caller ----------------------------------------------
  const authHeader = request.headers.get("authorization") ?? "";
  if (!authHeader.toLowerCase().startsWith("bearer ")) {
    return json({ error: "A Supabase access token is required." }, 401);
  }
  const supabase = createClient(url, anonKey, {
    global: { headers: { authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userError } = await supabase.auth.getUser();
  const user = userData?.user;
  if (userError || !user) return json({ error: "Invalid or expired token." }, 401);

  // An anonymous identity is a legitimate app end-user but is not given a
  // platform-funded generation budget at the normal rate.
  const isAnonymous = (user as { is_anonymous?: boolean }).is_anonymous === true || !user.email;

  // 3. Parse the request -----------------------------------------------------
  let payload: Record<string, unknown>;
  try {
    payload = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "Body must be JSON." }, 400);
  }

  const task = String(payload.task ?? "reply");
  const appVersion = request.headers.get("x-replymate-app-version") ?? null;
  const system = String(payload.system ?? "");
  const turns = Array.isArray(payload.turns)
    ? (payload.turns as Array<Record<string, unknown>>)
        .filter((turn) => turn && typeof turn.text === "string")
        .map((turn) => ({
          role: turn.role === "assistant" ? ("assistant" as const) : ("user" as const),
          text: String(turn.text).slice(0, 8000),
        }))
    : [];

  if (turns.length === 0) return json({ error: "At least one turn is required." }, 400);
  // Rule 6: a BYOK key must never be accepted here.
  if (payload.apiKey || payload.api_key) {
    return json(
      { error: "This endpoint does not accept a client-supplied provider key. BYOK stays on-device." },
      400,
    );
  }

  // 4. Keys and routing ------------------------------------------------------
  const resolver = createKeyResolver({
    providerKeys: GATEWAY_PROVIDERS.map((provider) => provider.key),
    readSecret: (name) => Deno.env.get(name),
    rotating: (Deno.env.get("GATEWAY_ROTATING_PROVIDERS") ?? "")
      .split(",").map((part) => part.trim()).filter(Boolean),
  });

  const routes = (Array.isArray(payload.routes) ? payload.routes : []) as RoutePolicy[];
  const decision = resolveRoute({
    task,
    routes,
    appVersion,
    hasKey: (providerKey) => resolver.available(providerKey),
  });
  if (!decision.ok) return json({ error: decision.reason, skipped: decision.skipped }, 503);

  const { route } = decision;
  const provider = providerByKey(route.providerKey);
  if (!provider) return json({ error: `Provider ${route.providerKey} is not proxied.` }, 503);

  // 5. Per-user limits -------------------------------------------------------
  const estimated = estimateTokens(system) + turns.reduce((sum, turn) => sum + estimateTokens(turn.text), 0);
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);

  const usageResult = await supabase
    .from("usage_event")
    .select("tokens_out")
    .eq("user_id", user.id)
    .gte("ts", dayStart.toISOString());

  const outputToday = (usageResult.data ?? []).reduce(
    (sum: number, row: { tokens_out?: number }) => sum + Number(row?.tokens_out ?? 0),
    0,
  );
  const limits = evaluateLimits({
    policy: { ...DEFAULT_LIMITS, requestsPerMinute: isAnonymous ? 3 : DEFAULT_LIMITS.requestsPerMinute },
    requestsThisMinute: 0,
    outputTokensToday: outputToday,
    estimatedTokensThisRequest: estimated,
  });
  if (!limits.allowed) {
    return json(
      { error: limits.reason, code: limits.code, retryAfterSeconds: limits.code === "daily_budget" ? limits.retryAfterSeconds : 60 },
      limits.code === "rate_limited" ? 429 : 402,
    );
  }

  // 6. Provider call ---------------------------------------------------------
  const resolvedKey: ResolvedKey | null = resolver.resolve(route.providerKey);
  if (!resolvedKey) return json({ error: `No master key for ${route.providerKey}.` }, 503);
  const apiKey = readKeyValue(resolvedKey, (name) => Deno.env.get(name));
  if (!apiKey) return json({ error: `Master key ${resolvedKey.secretName} is empty.` }, 503);

  const gatewayRequest: GatewayRequest = {
    providerKey: route.providerKey,
    model: route.model,
    system,
    turns,
    task,
    thinking: route.thinking,
    maxOutputTokens: decision.maxOutputTokens,
    timeoutMs: DEFAULT_LIMITS.timeoutMs,
  };
  const prepared = prepareCall(gatewayRequest, apiKey);

  let providerResponse: Response;
  try {
    providerResponse = await fetch(prepared.url, {
      method: prepared.method,
      headers: prepared.headers,
      body: prepared.body,
      signal: AbortSignal.timeout(prepared.timeoutMs),
    });
  } catch (error) {
    const classified = classifyError({
      providerKey: route.providerKey,
      status: null,
      transportError: error instanceof Error ? error.name : "unknown",
    });
    safeLog("transport failure", { provider: route.providerKey, class: classified.class });
    return json(
      { error: classified.providerSaid, class: classified.class, suggestedFix: classified.suggestedFix },
      classified.status,
    );
  }

  const rawText = await providerResponse.text();
  if (!providerResponse.ok) {
    let parsedBody: unknown = rawText.slice(0, 200);
    try { parsedBody = JSON.parse(rawText); } catch { /* keep the truncated string */ }
    const classified = classifyError({
      providerKey: route.providerKey,
      status: providerResponse.status,
      body: parsedBody,
    });
    // The secret NAME is safe to log; the value never is.
    safeLog("provider error", {
      provider: route.providerKey, model: gatewayRequest.model,
      status: providerResponse.status, class: classified.class, keySlot: resolvedKey.slot,
    });
    if (classified.class === "auth") {
      return json({
        error: "The platform provider key was rejected. This is a platform fault, not the user's.",
        class: classified.class,
        suggestedFix: classified.suggestedFix,
        rotateHint: `Populate ${resolvedKey.slot === "primary" ? "the _NEXT secret" : "the primary secret"} and add ${route.providerKey} to GATEWAY_ROTATING_PROVIDERS.`,
      }, classified.status);
    }
    return json({
      error: classified.providerSaid, class: classified.class,
      suggestedFix: classified.suggestedFix, retryable: classified.retryable,
    }, classified.status);
  }

  let parsedPayload: unknown = null;
  try { parsedPayload = JSON.parse(rawText); } catch { /* parseReply handles null */ }
  const reply = parseReply(route.providerKey, parsedPayload);
  const problem = classifyReplyProblem({ text: reply.text, truncated: reply.truncated });
  if (problem) {
    safeLog("unusable reply", { provider: route.providerKey, class: problem.class });
    return json({ error: problem.providerSaid, class: problem.class, suggestedFix: problem.suggestedFix }, problem.status);
  }

  // 7. Usage accounting — counts only, never content -------------------------
  const insert = await supabase.from("usage_event").insert({
    user_id: user.id,
    ts: new Date().toISOString(),
    model: gatewayRequest.model,
    tokens_in: reply.tokensIn,
    tokens_out: reply.tokensOut,
    kind: task,
  });
  if (insert.error) safeLog("usage insert failed", { code: insert.error.code });

  return json({
    text: reply.text,
    usage: { tokensIn: reply.tokensIn, tokensOut: reply.tokensOut },
    attribution: attribute(route.providerKey, gatewayRequest.model),
    latencyMs: Date.now() - started,
    limits: limits.allowed ? limits.remaining : null,
    keyExposed: false,
  }, 200);
});
