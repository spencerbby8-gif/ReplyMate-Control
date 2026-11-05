# Privacy contract

ReplyMate Control operates under the privacy model of the product it administers. That model is
**local-first**: the phone is the source of truth, message sync is off, and provider API keys never
leave the Android Keystore. This document states what the control plane may and may not do, and
points at the code that enforces each rule.

Source documents in [`spencerbby8-gif/ReplyMate`](https://github.com/spencerbby8-gif/ReplyMate):
`docs/SPEC.md`, `docs/BLUEPRINT.md` §6, `docs/supabase/README.md`.

---

## 1. Non-negotiable invariants

| # | Invariant | Enforcement point |
|---|---|---|
| P1 | Message sync is never enabled from this platform | `lib/api/control-actions.ts` rejects any `message_sync` status other than `off`, and refuses to delete the flag so the prohibition stays visible |
| P2 | No message body, memory fact, rolling summary, draft, prompt snapshot, style sample or contact name is read | `lib/privacy/guard.ts` deny list, checked **before** a query is built |
| P3 | No provider API key is stored, transmitted or rendered | BYOK only; no column in `src/db/schema.ts` can hold one; `ctl_config_item.sensitive` keys are write-refused |
| P4 | No end-user identity crosses the bridge | The only permitted end-user read is a scalar count (`readEndUserCount`) |
| P5 | Audit payloads contain no credential and no content | `lib/audit/redact.ts` runs on every write |
| P6 | No secret appears in code, logs, commits or an API response | `config/env.ts` reports presence only; `scripts/check-secrets.mjs` scans tracked files |
| P7 | No production migration is applied and nothing is deployed | The GitHub integration is GET-only; `supabase/` SQL is authored documentation |

---

## 2. Cross-database access matrix

The control plane has its own tables (`ctl_*`). Reading the **ReplyMate** cloud foundation is a
separate, allow-listed decision.

### Denied — end-user content

`message` · `memory_fact` · `contact_summary` · `draft` · `style_profile` · `app_kv` · `contact` ·
`contact_channel`

Access throws `PrivacyViolation`, surfaces as **HTTP 451 Unavailable For Legal Reasons**, and is
written to the audit log with outcome `denied`. A denial is preferred over an empty result: an empty
result looks like "no data", which is a lie about what was attempted.

### Allowed — aggregate or non-content

| Table | Permitted columns | Mode | Justification |
|---|---|---|---|
| `usage_event` | `ts`, `model`, `kind`, `tokens_in`, `tokens_out` | aggregate only | Token/request telemetry contains no message content; drives the Usage page |
| `provider_def` | `type`, `base_url`, `model_name`, `is_active`, `created_at` | aggregate only | Provider and model distribution. **`key_ref` is excluded** — even a vault label is not needed |
| `rm_schema_migrations` | `version`, `label`, `applied_at` | row | Proves which cloud foundation version is applied, without touching user data |

Anything not on this list is denied. Adding an entry requires an explicit `reason` string in
`lib/privacy/guard.ts` and a test in `tests/privacy-guard.test.ts`.

### Writes

**None.** There is no write path from this platform to the ReplyMate database. The bridge client is
constructed for `select` only, and no mutation function exists.

---

## 3. Data this platform stores about itself

| Category | Stored | Notes |
|---|---|---|
| Admin credentials | scrypt hash only | N=16384, r=8, p=1, 32-byte random salt |
| Session tokens | SHA-256 digest only | A database leak yields no usable session |
| Invite tokens | SHA-256 digest only | Single-use; cannot be recovered or re-issued by reading the table |
| TOTP secret | AES-256-GCM ciphertext | Key derived from `CONTROL_ENC_KEY`; enrolment is **refused** if that key is absent |
| Audit entries | action, actor, target, redacted detail, IP, user agent, request id | Append-only |
| Support tickets | free text supplied by an operator | Never paste message content; redaction drops `body`-shaped fields from audit detail |

---

## 4. End-user data

The control plane holds **no** ReplyMate end-user records. `ctl_subscription.end_user_id` is an
opaque UUID, never an email. `ctl_device` requires a non-null `consent_recorded_at`, so a row cannot
exist without a recorded consent — and no client build writes one, so the table is empty.

---

## 5. What would need to change

Any of the following requires an owner-approved phase and a change-control entry under
`docs/BLUEPRINT.md` §11 in the source repository:

- Device diagnostics of any kind (consent screen + opt-in transport + schema review)
- Reading message content for support purposes (rejected — the Diagnostics blocks added in 0.7.0
  exist precisely so support never needs message text)
- Enabling sync (rejected — it contradicts the product's north-star qualities)
- Storing a provider key server-side (rejected — it breaks BYOK and the Keystore model)

Until then, the empty states on those pages are the honest answer.
