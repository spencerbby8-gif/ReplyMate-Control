# TASK-012 — Provider key vault, Management API integration and gateway control

**Status:** complete for everything that does not require a new credential; **blocked
on one owner action** (`SUPABASE_ACCESS_TOKEN`) for live writes
**Evidence class:** local (654 tests) · preview (deployed, exercised) · live-supabase
(read paths) · production-write: **none**

## Objective

Make ReplyMate Control the place where platform provider master keys are managed —
added, replaced, rotated, disabled and probed — by writing **directly to Supabase
Edge Function Secrets** through the Management API, so routine key changes never
require opening the Supabase dashboard.

## The design decision everything else follows from

**This platform never stores a provider key.**

The authoritative store is Supabase Edge Function Secrets, which is where the
gateway already reads them (`Deno.env.get`). Control is a *management plane* for
that store, not a second copy of it. A value exists in this process for the
duration of one request, is sent once over TLS, and is dropped.

This is stronger than encrypting keys in our own database, and it is provable
rather than asserted: `ctl_provider_key` has **no column in which a value could be
stored**. Verified against the live schema — 16 columns, of which the only
value-adjacent two are `value_fingerprint` (a 16-hex keyed HMAC) and
`value_length` (a character count).

Three consequences follow, and each is surfaced in the UI rather than left to be
discovered:

1. **A saved key cannot be read back** — not by the UI, an API route, a database
   dump, or an attacker holding the secret key. Supabase does not return secret
   values either, so there is no read path at all.
2. **Control cannot test a key itself**, because testing requires *using* it. A
   probe is delegated to the deployed gateway — the only component holding a value
   at runtime. Until it is deployed, `testProviderKey` returns `unavailable` with
   that explanation. It does not fake a result.
3. **Rotation is two-phase**, and promotion requires re-entering the key. Nothing
   stored it, so the server verifies by fingerprint instead. That re-entry is a
   control: it proves continued possession.

## Why a new credential is required — explained before requesting it

The project keys this app already holds authenticate against the **data plane**
(PostgREST, GoTrue, Storage). They are rejected by `api.supabase.com`. Verified
live in TASK-002: `401 {"message":"JWT could not be decoded"}`. Ordinary project
keys **cannot** modify Edge Function secrets.

Minimum permissions requested, per the Management API reference:

| Permission | Endpoint | Used for | Required |
|---|---|---|---|
| `edge_functions_secrets_read` | `GET /v1/projects/{ref}/secrets` | presence, drift, rotation state | yes |
| `edge_functions_secrets_write` | `POST /v1/projects/{ref}/secrets` | add / replace a key; maintain `GATEWAY_ROTATING_PROVIDERS` | yes |
| `edge_functions_secrets_write` | `DELETE /v1/projects/{ref}/secrets` | delete a slot; remove `_NEXT` after promotion | yes |
| `edge_functions_read` | `GET /v1/projects/{ref}/functions` | is `replymate-ai` deployed, and what version | yes |
| `edge_functions_write` | `POST /v1/projects/{ref}/functions` | deployment only | **no** — separable onto its own token |

Legacy scopes if a non-fine-grained token is used: `secrets:read`,
`secrets:write`, `edge_functions:read`, `edge_functions:write`.

**Deliberately NOT requested**, each with the reason recorded in
`src/config/vault-requirements.ts` and rendered on the vault page:
`projects:write` (can pause/restart/recreate the project), `database:write`
(arbitrary SQL on production), `storage:*`, `api_gateway_keys_*` (would expose or
rotate the project's own API keys), `auth_signing_keys_*` (could invalidate every
user session), `organization_*`, `project_admin_write`. None is needed to rotate a
provider key, and requesting them would widen the blast radius of a leaked token
for nothing.

## Secret naming matches the gateway exactly

No mapping layer, so nothing can drift:

| Slot | Secret name | Read by |
|---|---|---|
| primary | `{PROVIDER}_MASTER_KEY` | `_shared/ai-gateway/keys.ts` → `secretNamesFor()` |
| rotation | `{PROVIDER}_MASTER_KEY_NEXT` | same |
| rotation flag | `GATEWAY_ROTATING_PROVIDERS` | `replymate-ai/index.ts` |

Eight providers are vaultable (`gemini`, `anthropic`, `openai`, `openrouter`,
`deepseek`, `grok`, `kimi`, `mistral`) — exactly the set the gateway proxies.
`ollama` and `openai_compat` are **excluded by construction** with their reasons,
so a user's own local or custom endpoint can never be shadowed by a platform key.

## Authorization: three gates, and one that live testing found broken

Vault actions require **owner role + a verified MFA session + typed confirmation**.

The confirmation is not a modal. The operator must type the provider key back, and
the server rejects a mismatch — which is what catches pasting a key while the
wrong provider is selected. A modal is one keystroke from muscle memory.

**The MFA gate did not work, and live testing is what caught it.** `requireMfa`
on the session guard means "MFA-verified *if the account has a factor enrolled*".
A session for an account with no factor is created with `mfaVerified = true`,
because there was nothing to verify. So the first live probe of `vault:setKey`
returned **502 from the Management API** — the request had sailed through the gate
and reached the upstream call. For an action that writes production provider
credentials, "no factor enrolled" must not mean "no factor required".

Fixed by requiring **both** conditions:

```
needsVerifiedMfa = MFA_VERIFIED_REQUIRED.has(resource)        // "vault"
mfaSatisfied     = session.mfaVerified && admin.mfaEnrolledAt !== null
```

Re-verified live — all five vault operations now return `403 mfa_required`
**before** any upstream call, each audited with `reason: mfa_not_enrolled`:

```
vault:setKey           -> 403 mfa_required     (was 502 — reached the API)
vault:stageRotation    -> 403 mfa_required
vault:promoteRotation  -> 403 mfa_required
vault:disableKey       -> 403 mfa_required
vault:setPolicy        -> 403 mfa_required
provider:resyncCatalogue -> 200   (gate is scoped to vault, not global)
probe:run                -> 200
```

## BYOK and platform AI are separate modes

`ctl_provider_policy` carries `platform_enabled` and `byok_allowed` as distinct
flags. Two invariants are enforced server-side, not hidden in the Android UI:

- **BYOK cannot be disabled.** Attempting it is rejected: it is the product's
  existing behaviour and users' own keys live only in their device Keystore, so
  removing the option would strand them.
- **Platform AI cannot be enabled with a zero spend cap.** That would allow
  unbounded platform spend. The rejection names the fix.

A BYOK request is never routed through a platform key or vice versa: `ollama` and
`openai_compat` have no platform key at all, and the gateway is only invoked for a
user whose plan grants platform AI.

## Deployment is a script, not a button

`scripts/deploy-edge-function.ts` ships code to production, which is a different
class of action from rotating a key. It requires a shell, an explicit `--confirm`
flag, a verified project ref, and it prints exactly which files will be bundled
and which runtime secrets the function expects. The vault page reports deployment
*state* and links to the script; there is no deploy button next to the credential
controls.

Dry run verified: it correctly refuses with `SUPABASE_ACCESS_TOKEN is not set`
before touching anything. It also refuses to fake a deploy when `deno` is absent —
it reports that an ESZIP bundle cannot be produced rather than claiming success.

## Files

| File | Change |
|---|---|
| `src/lib/supabase/management.ts` | **New.** Management API client: secrets list/upsert/delete, functions list/get. Names and digests only; values stripped defensively; errors reduced to a status and a permission hint. |
| `src/lib/vault/provider-keys.ts` | **New.** Vault service: status, setKey, stageRotation, promoteRotation, disableKey, testProviderKey, markRotating, setProviderPolicy. |
| `src/config/vault-requirements.ts` | **New.** Single source of truth for required permissions, refused permissions and bootstrap variables — code, so the UI cannot drift from it. |
| `src/db/schema.ts` | `ctl_provider_key` (metadata only), `ctl_provider_policy`. |
| `src/lib/api/control-actions.ts` | Five `vault:*` actions, `vault:manage` capability, `MFA_VERIFIED_REQUIRED`, `assertConfirmation()`. |
| `src/app/api/control/route.ts` | The MFA gate, fixed to require an enrolled factor. |
| `src/config/nav.ts`, `src/lib/authz/permissions.ts`, `sidebar.tsx` | `vault:view` / `vault:manage` / `plans:manage`; `/ai-keys` nav entry; `KeyRound` icon. |
| `src/components/forms/vault.tsx` | **New.** Set / rotate / promote / delete dialogs with typed confirmation and no value retention. |
| `src/app/(admin)/ai-keys/page.tsx` | **New.** Vault page. |
| `scripts/deploy-edge-function.ts` | **New.** Controlled deployment, `--confirm` gated. |
| `tests/provider-vault.test.ts` | **New.** 31 cases. |

## Verification

| Level | Result |
|---|---|
| Local unit tests | **654 passed** (was 623), 23 files |
| Preview | `/ai-keys` renders 200 with all 8 providers × 2 slots, permission table, bootstrap table, gateway state; **no secret in the HTML** |
| Preview guardrails | 5 × `403 mfa_required`, confirmation mismatch `409`, zero-cap `409`, unknown action `400`, all audited |
| Live Supabase | read paths verified in TASK-002/011; `GET /secrets` not exercised (needs the token) |
| Production writes | **none** |

`eslint` clean · `tsc --noEmit` clean · `next build` clean (32 routes) ·
`check-secrets` clean on 170 files.

Two of my own test defects were caught by the tests themselves: the column-list
assertion omitted drizzle's `enableRLS` config flag, and — more importantly — a
self-check loop proving the "no secret-shaped column" pattern was not vacuous
caught that my first regex let `keyValue` through. The pattern is now broad with an
explicit descriptive allowlist.

## Blockers and owner decisions

1. **`SUPABASE_ACCESS_TOKEN` is not configured.** Until it is, every vault write
   fails closed with `502` and the reason. No key has been written, and no
   fallback store was created. Create a fine-grained token scoped to
   `xdcsxxwhvpiissetbrdr` with the four required permissions above.
2. **`replymate-ai` is not deployed.** Deployment needs `edge_functions_write`,
   `deno`, and your approval. Until then written keys are inert and cannot be
   probed.
3. **Key probes need an end-user access token.** The gateway authenticates the
   caller and enforces that user's quota; Control has neither and minting one
   would bypass the quota it is meant to enforce. Decision needed: probe with a
   dedicated service identity, or accept that probing is manual.
4. **Vault writes are currently blocked by MFA** because no factor is enrolled on
   the owner account. That is the gate working correctly. Enrol TOTP from
   `/security` to use the vault.
5. **Free-tier capacity for the gateway is unverified.** The Management API could
   report Edge Function invocation limits and egress, but needs the same token.
   Measured so far: 12 MB database of the Free 500 MB allowance, 0 storage
   objects, 0 realtime tables. **No plan upgrade and no paid service activated.**
6. **Premium plans, entitlements and subscriptions** (items 4 and 5 of the brief)
   are not implemented here. They are a separate task: the entitlement registry
   must be shared with the Android configuration contract, and inventing it
   alongside the vault would have produced two half-finished systems.

## Remaining work, in order

- TASK-013: entitlement registry + manageable plans (create/edit/activate/version)
- TASK-014: subscription lifecycle, expiry, cancellation, audit history (Paystack
  kept separate until approved)
- TASK-015: gateway wiring — quotas, spend caps, responding-model attribution,
  live probe once deployed
- TASK-016: Android contract for gateway auth, entitlement fetch, offline caching,
  revocation
