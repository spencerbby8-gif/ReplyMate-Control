# ReplyMate Control

A **separate, invitation-only administrative platform** for [ReplyMate](https://github.com/spencerbby8-gif/ReplyMate) — the local-first, on-device AI reply assistant for Android.

This is the control plane. It configures, observes and governs the product. It is **not** part of the Android app, does not share a codebase with it, and — by construction — cannot read a single message.

> **Stack:** Next.js (App Router) · TypeScript · Tailwind CSS v4 · shadcn/ui · Supabase · Drizzle ORM · PostgreSQL · Vitest

---

## The contract this platform is bound by

ReplyMate's privacy model is documented in `docs/SPEC.md` and `docs/BLUEPRINT.md` of the source repository, and its cloud foundation in `docs/supabase/`. This platform inherits those constraints as **code**, not as good intentions:

| Invariant | How it is enforced here |
|---|---|
| Message sync stays off | `SYNC_ENABLED=false` is pinned by `SupabaseConfigTest` in the Android repo. The `message_sync` flag is pinned `off` server-side, rejects every other value, and cannot be deleted. |
| No message content is readable | `src/lib/privacy/guard.ts` is an **allow-list**. `message`, `memory_fact`, `contact_summary`, `draft`, `style_profile`, `app_kv`, `contact` and `contact_channel` are denied *before a query is built* and throw `PrivacyViolation` (HTTP 451). |
| Provider keys never leave the device | ReplyMate is BYOK — keys live in the Android Keystore (`rm_master`, AES/GCM/NoPadding). This platform stores no key material. Even `provider_def.key_ref` is excluded from every permitted projection. |
| Secrets are never exposed | `envReport()` returns presence booleans only. `.env` is gitignored. `scripts/check-secrets.mjs` scans tracked content before commit. |
| No production migrations, no deploys | The GitHub integration is **GET-only**. Migration SQL in `supabase/` is authored documentation for an owner to apply deliberately. Nothing here runs `db push` against the ReplyMate project. |

See [`docs/PRIVACY.md`](docs/PRIVACY.md) for the full access matrix and [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the module map.

---

## Quick start

```bash
cp .env.example .env          # then fill in the values you need
npm install

# 1. Create the control-plane schema
npx drizzle-kit push

# 2. Create the first owner + load the reference catalogue
BOOTSTRAP_OWNER_EMAIL=you@company.com \
BOOTSTRAP_OWNER_PASSWORD='a-long-unique-password' \
npx tsx scripts/bootstrap.ts

npm run dev                    # http://localhost:3000
```

Credentials are read **only** from the environment by the bootstrap script — never over HTTP. Enrol TOTP MFA from **Security** on first sign-in.

### Verification

```bash
npm run lint                   # eslint (flat config, next core-web-vitals)
npm run typecheck              # tsc --noEmit
npx vitest run                 # unit suites — guardrails, TOTP, crypto, redaction, catalogue
npm run build                  # production build
node scripts/check-secrets.mjs --all
```

---

## What is here

### Access & governance
- **Users** — invitation-only admin accounts. Single-use, expiring, hashed invite tokens; no self-service sign-up.
- **Security** — TOTP enrolment (RFC 6238, SHA-1, 30 s, ±1 step window, **single-use codes**), live session inventory with immediate revocation, lockout posture.
- **Audit log** — append-only. No update path, no delete path, no route that can mutate it. Denials are recorded exactly like successes.

### Server-side roles
`owner > admin > operator > support > viewer`, defined once in `src/config/nav.ts` and evaluated in `src/lib/authz/permissions.ts`. Every route handler and server component re-checks through a guard; the sidebar is filtered by the same matrix before it reaches the browser, so hiding a link grants nothing. Administrator lifecycle (`users:manage`, `security:manage`) is **owner-only**.

### Intelligence operations
- **AI providers** — the ten providers the Android client implements, with their real wire dialects, official base URLs and search/reasoning capability bindings, transcribed from `ProviderType.java` and `docs/provider-capability-map.md`.
- **Model routing** — task→model policy. The server rejects unknown providers and any output cap below the required minimum for its thinking level (the exact rule that fixed the 1.5.6–1.5.7 background-draft starvation bug).
- **Usage** — aggregate token telemetry from the Supabase bridge, or an explicit "bridge closed" state. Never zeros dressed as data.
- **AI operations assistant** — a tool-executing assistant over this control plane. Deterministic by default: an intent router selects real tools, the tools query the database, and the answer is composed only from what they returned. With `AIOPS_PROVIDER` + `AIOPS_API_KEY` configured, the same registry is offered to a real model over its native dialect. Either way it will not guess.

### Product & platform
**Feature flags** · **Releases** (synced read-only from `releases/RELEASES.md`, including its BROKEN markers) · **Devices** · **Subscriptions** · **Support** · **Configuration** · **Monitoring** (on-demand live probes) · **Privacy**.

### Honest empty states
There is no seed data pretending to be production data, and no disabled button that looks like a feature. Every empty state says *why* it is empty and *what would change that* — see `src/components/shared/empty-state.tsx`, which is the only empty-state component in the app and requires a `reason`.

---

## Architecture

```
src/
├─ app/
│  ├─ (admin)/            console pages — each calls requireCapability() first
│  ├─ login/ invite/      public auth surfaces
│  └─ api/
│     ├─ control/         ONE authorized mutation endpoint (parse→authn→authz→execute→audit)
│     ├─ auth/            login, logout, MFA challenge, MFA enrolment, invite redemption
│     └─ health/          liveness + presence-only configuration posture
├─ components/
│  ├─ ui/                 shadcn/ui primitives (Radix + cva + tailwind-merge)
│  ├─ layout/             sidebar, shell, topbar
│  ├─ forms/              mutation dialogs, MFA enrolment, assistant console
│  └─ shared/             page header, stat card, empty state, async action
├─ config/                env (validated, presence-only reporting), nav, domain catalogue
├─ db/                    Drizzle client + control-plane schema (ctl_* tables)
└─ lib/
   ├─ auth/               scrypt passwords, AES-GCM, RFC 6238 TOTP, hashed sessions
   ├─ authz/              permission matrix + page/API guards
   ├─ audit/              append-only logger + redaction
   ├─ privacy/            the allow-list guard — the hard boundary
   ├─ api/                control-action registry (capability, schema, executor)
   ├─ queries/            read models
   ├─ integrations/       read-only GitHub ledger sync
   ├─ monitoring/         live probe suite
   ├─ aiops/              tool registry + deterministic/LLM engine
   └─ supabase/           allow-listed, read-only bridge
```

**Modularity rule:** a page never queries the database directly — it calls a read model from `lib/queries`. A mutation never happens in a page — it goes through `lib/api/control-actions.ts`, which owns the capability mapping, the payload schema and the executor. Adding a write means adding one registry entry, not a new route file.

---

## Supabase

Two distinct roles, deliberately separated:

1. **Identity (optional).** `AUTH_PROVIDER=supabase` makes Supabase Auth the identity provider for administrators, with invitation-only access via `auth.admin.inviteUserByEmail` and TOTP MFA. The default `local` mode uses the control-plane database with scrypt passwords and this repo's own RFC 6238 implementation — a real, functioning provider, not a stub.
2. **Data plane (optional, read-only).** When the bridge credentials are present, `lib/supabase/bridge.ts` may read exactly three things from the ReplyMate project: `usage_event` aggregates, `provider_def` metadata (never `key_ref`), and the `rm_schema_migrations` ledger. The only end-user read is a **scalar count** — no email, id or metadata crosses the bridge.

When the credentials are absent the bridge reports `closed` and the affected pages say so. That is the honest state; nothing is simulated in its place.

---

## Security notes

- Passwords: scrypt (N=16384, r=8, p=1), 32-byte salt, timing-safe comparison.
- Sessions: 256-bit CSPRNG cookie, **only the SHA-256 digest is stored**, sliding expiry, `HttpOnly`, `SameSite=Lax`, `Secure` in production.
- Lockout: 5 failed attempts → 15 minutes. Every attempt is audited, success or failure.
- TOTP secrets: AES-256-GCM under a key derived from `CONTROL_ENC_KEY`. Enrolment is **refused** if that key is missing rather than degraded to plaintext.
- Audit payloads: credential-shaped keys and values are replaced, content-shaped fields are dropped, depth and size are capped.
- No account-existence oracle: an unknown email and a wrong password return the identical response.

---

## Explicitly out of scope

Applying migrations to the ReplyMate production database · modifying the Android repository · building, signing or publishing an APK · deploying · enabling message sync · reading message content · storing a provider API key · billing.

If any of these become necessary they need an owner-approved phase and a change-control entry under `docs/BLUEPRINT.md` §11 in the source repository.
