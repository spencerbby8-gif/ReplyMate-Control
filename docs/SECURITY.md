# Security model

## 1. Threat model

**In scope:** a leaked control-plane database, a leaked session cookie store, credential stuffing
against admin accounts, a malicious or careless administrator acting above their role, an
accidental secret in a commit or a log, and any code path that might grow read access to ReplyMate
end-user content.

**Out of scope:** a compromised host with root access to the server process (at that point the
environment variables are readable regardless of design), and physical access.

## 2. Authentication

| Control | Implementation |
|---|---|
| Password hashing | scrypt, N=16384, r=8, p=1, 32-byte random salt, 64-byte derived key. `timingSafeEqual` comparison. The encoded form carries its own parameters, so a future cost increase needs no migration. |
| Lockout | 5 consecutive failures → 15-minute lock, tracked per account in `ctl_admin`. The lock event is audited separately from the failure. |
| No account-existence oracle | Unknown email, suspended account, missing password and wrong password all return the identical `401 invalid_credentials` body. |
| MFA | RFC 6238 TOTP — SHA-1, 30-second step, 6 digits, ±1 step skew window. Implemented directly on `node:crypto`; no third-party OTP dependency to audit. |
| MFA replay protection | Each accepted TOTP step is recorded in `ctl_admin.mfa_last_step`. A step at or below the last accepted one is rejected and audited as `code_replayed`, so a code cannot be reused inside its window. |
| MFA storage | The shared secret is encrypted with AES-256-GCM under a key derived from `CONTROL_ENC_KEY`, with a fresh 12-byte IV per encryption. **Enrolment is refused outright if that key is absent** — there is no plaintext fallback. |
| Two-step enrolment | A factor only becomes live after a valid code proves possession. A half-finished enrolment cannot lock anyone out. |
| Partial sessions | A session created before MFA verification carries `mfaVerified = false` and can reach exactly one endpoint: the MFA challenge. Every other guard rejects it. |

## 3. Sessions

- 256 bits of CSPRNG output in the cookie; **only the SHA-256 digest is stored**, so a database leak
  yields no usable session.
- `HttpOnly`, `SameSite=Lax`, `Secure` in production, scoped to `/`.
- Sliding expiry (`SESSION_TTL_HOURS`, default 8h). Expiry is extended only when MFA is verified.
- Revocation is immediate: suspending an administrator, resetting their MFA, or revoking a session
  sets `revoked_at`, and the digest stops matching on the very next request.
- Expired rows are purgeable (`purgeExpiredSessions`); the purge deletes sessions only, never audit
  rows.

## 4. Authorization

Roles: `owner > admin > operator > support > viewer`.

- The matrix lives in one place (`lib/authz/permissions.ts`) and is derived from the capability list
  in `config/nav.ts`.
- **Three guards, no bypass:** `requireSession()` and `requireCapability()` for server components,
  `apiRequire()` for route handlers. No page or handler reads the session by hand.
- Administrator lifecycle (`users:manage`, `security:manage`) is **owner-only**.
- Rank checks prevent escalation: an actor may only modify accounts strictly below their own rank,
  may not grant a role at or above their own, may not suspend or demote themselves, and only an owner
  may touch an owner account.
- The sidebar is filtered server-side *before* serialization, so a viewer's browser never even
  receives the href for `/users`. This is cosmetic; the guard is what actually stops them.
- Every denial is audited with `outcome: denied`, the capability, the path and a request id that is
  also returned to the caller — so a 403 can be traced to its audit row.

## 5. Auditing

- Append-only by construction: `lib/audit/logger.ts` exposes **no** update or delete function, and no
  API route can mutate `ctl_audit_log`.
- Written for successes, denials **and** errors.
- Redaction runs before the write (`lib/audit/redact.ts`):
  - credential-shaped **keys** → `[redacted]` (`password`, `secret`, `token`, `apikey`, `otp`, `mfa`,
    `pin`, `session`, `cookie`, `authorization`, `salt`, `hash`, `enc`, …), with a narrow override so
    identifiers like a feature-flag `key` survive;
  - credential-shaped **values** → `[redacted]` (GitHub, OpenAI, Anthropic, Google, Slack, JWT,
    base32 and connection-string shapes), regardless of the key they sit under;
  - content-shaped **fields** (`body`, `message`, `reply`, `draft`, `summary`, `fact`, `sample`,
    `prompt`) → `[content-omitted]`, because the control plane has no business recording ReplyMate
    end-user content in the first place;
  - depth capped at 6, strings at 240 characters, arrays at 50 elements.
- Diffs record only changed keys, both sides redacted, with timestamp churn excluded.
- Values that must reach the caller but must **never** be logged (today: the single-use invitation
  URL) travel in a separate `responseOnly` field that the audit writer never sees.

## 6. Secrets handling

- `config/env.ts` is the only place the environment is read. `envReport()` returns **presence
  booleans** and non-secret identifiers — it is the only env-derived shape permitted to reach a page,
  an API response or a log.
- `.env`, `.env.local` and `.env.*.local` are gitignored and additionally listed in
  `.git/info/exclude`.
- `scripts/check-secrets.mjs` scans tracked content for ten credential shapes and exits non-zero on a
  hit. It prints the file, line and rule name — never the matched secret.
- The Supabase service-role key and the GitHub read token are read from `process.env` in server code
  only. Neither is prefixed `NEXT_PUBLIC_`, so neither can reach a client bundle.
- Provider error bodies are **not** logged verbatim: they can echo request material. Only the error
  class and HTTP status are kept.

## 7. Privacy boundary

See [`PRIVACY.md`](PRIVACY.md). Summary: allow-list only, enforced before a query is built, throwing
`PrivacyViolation` (HTTP 451) rather than returning an empty result that would look like "no data".
`message_sync` is pinned off, cannot be set to another value and cannot be deleted, so the
prohibition stays visible.

## 8. Application hardening

- `robots: noindex, nofollow` — an admin console should never be crawled.
- `cache-control: no-store` on every API response.
- Zod validation on every inbound payload; the mutation surface is one endpoint with a closed
  registry, so there is no undocumented action to discover.
- Business invariants are enforced server-side, not in the form: flag rollout/status coherence, the
  model-routing output-cap minimum, provider keys restricted to the client catalogue, locked and
  privacy configuration keys refusing writes.
- No `dangerouslySetInnerHTML`, no `eval`, no user-controlled SQL. All queries go through Drizzle's
  parameter builder.
- The one place raw SQL appears is `select 1` in the health and probe checks.

## 9. Known limitations (stated, not hidden)

- **No CSRF token.** Sessions are `SameSite=Lax` cookies and every mutation is a `POST` with a JSON
  body, which Lax plus the preflight requirement covers. A dedicated origin check would still be a
  reasonable hardening step.
- **No rate limiting on the login endpoint** beyond the per-account lockout. An IP-level limiter
  belongs in front of the app (proxy or edge), not in this codebase.
- **No scheduled probe runs.** Monitoring is on-demand; the page says so rather than implying
  continuous coverage.
- **`AUTH_PROVIDER=supabase` is wired but not exercised** in this environment, because no Supabase
  project credentials were available. The `local` provider is fully functional and is what the tests
  and smoke checks cover.
- **Session digests use a fixed pepper.** A per-deployment pepper derived from `CONTROL_ENC_KEY`
  would be marginally stronger; the 256-bit token entropy is what actually protects sessions.
