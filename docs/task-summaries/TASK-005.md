# TASK-005 — Secure AI gateway for ReplyMate's built-in AI

**Status:** PREPARED AND TESTED OFFLINE · **NOT DEPLOYED** (needs owner approval)
**Branch:** `feat/admin-foundation` · **PR:** #1

## Objective

Build the secure AI gateway: provider adapters and model catalogue, routing with controlled fallback,
authentication and per-user limits, rate limiting, timeouts and spend controls, accurate attribution,
usage accounting, error classification, and secure key rotation — while keeping BYOK separate and
never exposing a platform key to a client.

## What was built

```
supabase/functions/
├─ _shared/ai-gateway/        pure TypeScript, NO Deno-only APIs
│  ├─ catalogue.ts            providers, dialects, prepareCall(), parseReply(), attribute()
│  ├─ routing.ts              resolveRoute() with fallback chain and version gating
│  ├─ limits.ts               per-user budgets, token estimation, spend control
│  ├─ errors.ts               error classification matching the app's own taxonomy
│  └─ keys.ts                 master-key resolution and rotation
├─ replymate-ai/index.ts      the Deno Edge Function handler
├─ deno.d.ts                  minimal ambient types (see the honesty note below)
└─ tsconfig.json              separate config: Deno allows explicit .ts specifiers
```

The shared modules are imported **directly by the offline test suite**, so the logic that is tested is
the logic the deployed function runs. There is no parallel implementation to drift.

## Design decisions worth stating

**BYOK is untouched.** The user's own key is encrypted in the Android Keystore and never leaves the
device. That path is not routed through this function, and the function **refuses a client-supplied
key** with a 400 — the whole point of the separation is that a user key never transits the platform.
The gateway exists so a future "built-in AI" option can be added without ever shipping a platform key
inside an APK.

**Only 8 of 10 providers are proxied.** `ollama` runs on the user's device and `openai_compat` is an
arbitrary user-chosen endpoint; neither can be proxied and pretending otherwise would misstate
capability. Both are listed in `NOT_PROXIED` with a reason.

**Zero retries.** The Android app already implements exponential backoff with jitter and treats 429 as
normal backpressure (`docs/SPEC.md` §6). A gateway that also retried would multiply provider spend and
hide the backoff signal from the client. `DEFAULT_LIMITS.maxRetries === 0`, pinned by a test.

**The output-cap rule is enforced in `prepareCall()`, not left to the caller.** Requesting
`maxOutputTokens: 220` with `thinking: "high"` yields 4572, because providers count thinking inside the
output cap — the exact bug that silently killed background drafts on 1.5.6–1.5.7.

**Error classification preserves the app's hard-won distinctions.** A Gemini 429 carrying `limit: 0`
means *model unavailable*, never retry and never call it "exhausted". A billing 429 is separated from a
rate-limit 429. A deprecated model is separated from a missing one. All three envelope shapes (xAI
string, Mistral `detail`, OpenAI nested `error.message`) are parsed. A 401 is classified as a
**platform** key fault, never the user's.

**Provider bodies are never echoed.** Only a short extracted message is kept, because an error body can
reflect request material — which here means fragments of a user's conversation.

**Thought content never leaves.** Gemini's `includeThoughts` is never requested and `thought:true`
parts are filtered defensively; Anthropic `thinking` blocks are dropped entirely and never stored.

**Key rotation without a flag day.** A provider may hold a primary and a `_NEXT` secret. Setting
`GATEWAY_ROTATING_PROVIDERS` prefers the successor; a slot that fails auth is marked bad and skipped.
The resolver returns the **secret name**, never the value, so diagnostics can name what to fix without
leaking it.

## Security properties

- Master keys exist only in function secrets. Never a database table, never a response, never a log.
- The key is never placed in a URL — only in a header the caller already owns.
- Every response carries `keyExposed: false` as an explicit assertion.
- `safeLog()` redacts any credential-shaped field before it reaches `console.log`.
- The caller must present a valid Supabase access token; anonymous identities get a **reduced**
  request-per-minute budget rather than the normal one.
- Conversation history is never persisted: turns arrive in the request and leave in the response.
- Usage accounting writes counts only (`tokens_in`, `tokens_out`, `model`, `kind`) to `usage_event` —
  the same aggregate shape the app already writes locally.

## Evidence

```
$ npx vitest run tests/ai-gateway.test.ts
  Test Files  1 passed
       Tests  66 passed

$ npx tsc -p supabase/functions/tsconfig.json --noEmit
  (clean)
```

Coverage includes: catalogue fidelity to `ProviderType.java` base URLs; the output-cap rule under
`prepareCall`; Gemini 2.5 `thinkingBudget` vs 3.x `thinkingLevel`; Anthropic family split
(adaptive+`output_config.effort` on 4.6+/5.x vs `budget_tokens` on ≤4.5, never `temperature`); the
per-provider reasoning quirks for DeepSeek, Kimi, Mistral-small vs magistral, Grok (nothing sent —
no knob is documented, so none is invented) and OpenRouter; fallback when a provider has no master
key; skipping unproxied providers; `minAppVersion` gating; budget refusals; every error-class
distinction above; attribution when a fallback served; and key resolution, rotation, bad-slot skipping
and non-leakage.

## NOT DONE, and why

- **The function is not deployed.** `supabase functions deploy` requires a Supabase access token that
  is not present, and deploying to the production project is a change requiring owner approval.
- **The handler is not exercised end-to-end.** It needs Deno and a live provider call. `deno.d.ts`
  holds minimal ambient types so `tsc` catches genuine logic errors today; **that is not a substitute
  for `deno check`**, and the file says so. Before deploying, run `deno check` with the real
  `@supabase/supabase-js` types.
- **No master keys are configured.** Every `*_MASTER_KEY` secret is unset, so `resolveRoute()` reports
  "no master key configured" for every provider and returns 503 rather than pretending to serve.
- **`gateway_request_log` does not exist.** The per-minute counter reads it; the insert is
  best-effort so accounting never fails a user's reply. Creating that table is a production migration.
- **No spend rates are configured**, so `estimateMicroUsd()` returns `null` — "unknown", never "free".

## Required to go live

1. Owner approval to deploy an Edge Function to the production project.
2. A Supabase access token with `functions:write`.
3. The `*_MASTER_KEY` secrets populated in function config (never in the repository).
4. A decision on whether `gateway_request_log` may be created, or whether rate limiting should read
   from an existing aggregate instead.
5. `deno check` passing in an environment with the Deno CLI.
