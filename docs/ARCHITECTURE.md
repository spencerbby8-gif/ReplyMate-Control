# Architecture

## 1. Principles

1. **Server-side authority.** Nothing is decided in the browser. Roles, capabilities, privacy rules
   and validation are all evaluated on the server; the client only renders what it was given.
2. **One write path.** Every mutation flows through `POST /api/control`. One dispatcher means one
   place where the order *parse → authenticate → authorize → execute → audit* is guaranteed.
3. **Allow-list, not deny-list.** Both for privacy (`lib/privacy/guard.ts`) and for authorization
   (`config/nav.ts` declares who may see a route; everything else is refused).
4. **Honest absence.** If a dependency is not configured, the UI says so and explains what would
   change it. No zeros that look like telemetry, no disabled buttons that look like features, no
   placeholder rows.
5. **Transcription over invention.** Domain data (providers, base URLs, dialects, capabilities,
   output-cap rules, channel set) is copied from the ReplyMate repository and pinned by tests.

---

## 2. Request lifecycle

### Read (a console page)

```
Browser → (admin)/layout.tsx → requireSession()      [redirects to /login if absent]
        → page.tsx           → requireCapability(c)   [redirects + audits a denial]
        → lib/queries/*      → Drizzle → Postgres
        → server-rendered HTML (no client data fetching for initial paint)
```

### Write (any control)

```
Client control (AsyncAction / dialog form)
  → POST /api/control  { resource, operation, values }
    1. zod discriminated union parse          → 400 invalid_input
    2. capabilityFor(resource, operation)
    3. apiRequire(request, capability)        → 401 unauthenticated / 403 forbidden (audited)
    4. executeControlAction(action, actor)    → ConflictError 409 / NotFoundError 404
                                              → ForbiddenError 403 / PrivacyViolation 451
                                              → UpstreamError 502
    5. recordAudit(success | denied | error)  → redacted detail, request id
    6. jsonOk({ summary, ...responseOnly })
  → router.refresh()  → page re-renders from the database
```

`responseOnly` carries values that must reach the caller but must **never** reach the audit log —
today exactly one thing: the single-use invitation URL.

---

## 3. Module map

| Module | Responsibility | Depends on |
|---|---|---|
| `config/env.ts` | Validates the environment; exposes `envReport()` (presence only) | zod |
| `config/nav.ts` | Navigation registry + capability list; the source of truth for who sees what | `db/schema` types |
| `config/catalog.ts` | Transcribed domain data from the ReplyMate repository | — |
| `db/schema.ts` | Control-plane tables (`ctl_*`) | drizzle |
| `lib/auth/crypto.ts` | scrypt, AES-256-GCM, token generation and digesting | node:crypto |
| `lib/auth/totp.ts` | RFC 6238 TOTP, base32 codec, otpauth URI | node:crypto |
| `lib/auth/session.ts` | Cookie sessions, lockout, MFA-verified flag | crypto, db |
| `lib/authz/permissions.ts` | Role → capability matrix, precedence | nav, schema |
| `lib/authz/guard.ts` | `requireSession`, `requireCapability`, `apiRequire` | session, permissions, audit |
| `lib/audit/redact.ts` | Key/value/content redaction + diffing | — |
| `lib/audit/logger.ts` | Append-only writer | db, redact |
| `lib/privacy/guard.ts` | Cross-database allow-list; `PrivacyViolation` | — |
| `lib/api/control-actions.ts` | Mutation registry: capability, schema, executor | everything above |
| `lib/queries/*` | Read models. Pages never touch Drizzle directly | db |
| `lib/integrations/github.ts` | GET-only release/migration ledger sync | env |
| `lib/monitoring/probes.ts` | Live unauthenticated reachability probes | env, catalog |
| `lib/aiops/engine.ts` | Tool registry + deterministic/LLM engine | queries, privacy, env |
| `lib/supabase/bridge.ts` | Allow-listed read-only bridge | privacy, env |
| `lib/auth/identity.ts` | Identity strategy: local scrypt OR Supabase Auth. Fails closed, never falls back | env, crypto |
| `lib/auth/csrf.ts` | Origin verification for state-changing requests | — |
| `lib/auth/rate-limit.ts` | Database-backed per-source login throttle | db |
| `lib/authz/escalation.ts` | Pure administrator-change policy | permissions |
| `lib/ingest/allowlist.ts` | Closed telemetry schema + denied-key sweep + PII value screening | zod |
| `lib/ingest/auth.ts` | Device bearer authentication, scoped and revocable | db, crypto |
| `lib/config/versioning.ts` | Immutable revisions, published snapshots, client resolution | db |
| `lib/queries/health.ts` | Structural self-checks, incl. "is this the production database?" | db |

---

## 4. Data model

All control-plane tables are prefixed `ctl_` so they can never be confused with a ReplyMate table,
even if both schemas were ever loaded into one database.

```
Identity     ctl_admin ─┬─ ctl_session   (token digest, mfa_verified, expiry)
                        └─ ctl_invite    (token digest, role, expiry, single-use)
Governance   ctl_audit_log               (append-only; no update/delete path exists)
Product      ctl_feature_flag            ctl_model_route        ctl_ai_provider
             ctl_release                 ctl_device             ctl_plan / ctl_subscription
Platform     ctl_config_item             ctl_monitor_probe      ctl_support_ticket
Assistant    ctl_aiops_session ─── ctl_aiops_message
```

`ctl_admin.supabase_user_id` is the only link to Supabase Auth, and it is nullable — populated only
when `AUTH_PROVIDER=supabase`.

---

## 5. Authentication modes

| Mode | Identity source | MFA | Invitations |
|---|---|---|---|
| `local` (default) | `ctl_admin` + scrypt | This repo's RFC 6238 TOTP | `ctl_invite`, hashed single-use token |
| `supabase` | Supabase Auth | Supabase TOTP (`auth.admin`) | `auth.admin.inviteUserByEmail` (service role) |

Both are real. `local` is the default so the platform is fully functional and testable without a
Supabase project; `supabase` delegates identity while keeping **roles in this database**, because
authorization is an administrative decision that should not live in an IdP claim.

---

## 6. UI layer

- shadcn/ui primitives in `src/components/ui` (Radix + `class-variance-authority` +
  `tailwind-merge`), Tailwind v4 tokens in `globals.css`, dark-first with a complete light theme.
- `components/layout/sidebar.tsx` is presentational; `(admin)/layout.tsx` filters the registry by
  role **before** it is serialized to the client.
- `components/shared/async-action.tsx` is the only mutation button. A control either has an endpoint
  wired through it or it does not exist — which is what makes "no dead controls" checkable.
- `components/shared/empty-state.tsx` requires a `reason` prop. It is not possible to render an empty
  state that only says "No data".

---

## 7. Testing strategy

| Suite | What it pins |
|---|---|
| `tests/privacy-guard.test.ts` | Every content table is denied; the allow-list columns are exact; `key_ref` is excluded; violations throw rather than return empty |
| `tests/authz.test.ts` | Role precedence; owner-only capabilities; viewers hold no write capability; navigation covers every required surface; every role sees at least one page |
| `tests/totp.test.ts` | RFC 6238 published vectors; ±1 step window; replay of a far code; malformed input; base32 round-trip; otpauth URI parameters |
| `tests/crypto.test.ts` | scrypt verify/reject, salted uniqueness, plaintext absence, malformed-hash safety; token uniqueness; AES-GCM round-trip and tamper detection |
| `tests/audit-redaction.test.ts` | Secret-like keys and values are replaced; content fields are dropped; recursion, depth and size caps; diffs record only real changes |
| `tests/catalog.test.ts` | The ten providers, their base URLs, dialects and capability bindings match the Android source; the output-cap rule is arithmetically correct |
| `tests/integrations.test.ts` | The release-ledger parser handles the real format, including `❌ BROKEN` rows and malformed sha256 |
| `tests/csrf.test.ts` | Safe-method exemption, `Sec-Fetch-Site` precedence over a forged Origin, host matching, malformed-Origin refusal, non-browser clients |
| `tests/rate-limit.test.ts` | Distinct-target limit trips before the volume limit; digests are stable, normalised and never contain the raw IP or address |
| `tests/session-policy.test.ts` | Expired lock resets the counter; token digest is keyed, not plain SHA-256 |
| `tests/identity.test.ts` | Strategy follows config; Supabase mode fails **closed** rather than falling back to local hashes |
| `tests/escalation.test.ts` | 34-case administrator-change matrix: self-protection, rank, owner-only rules, grant rules |
| `tests/ingest-allowlist.test.ts` | 91 cases attacking the validator: unknown kinds, smuggled content keys at depth, PII in allowed fields, the `syncEnabled=true` refusal, timestamp clamping, batch limits |
| `tests/config-versioning.test.ts` | Semver comparison — including `1.5.10 > 1.5.9`, which a string sort gets wrong |

These are unit tests over pure logic — no network, no database, no mocks of a service that does not
exist. Integration behaviour (a real sign-in, a real probe) is exercised through the running app.
