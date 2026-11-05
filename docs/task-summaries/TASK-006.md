# TASK-006 — Android ↔ Control integration contract

**Status:** COMPLETE as a contract · **NOT CONNECTED** (no client build sends telemetry)
**Branch:** `feat/admin-foundation` · **PR:** #1

## Objective

Prepare the real integration contract between ReplyMate Android and Control: privacy-safe device
registration, explicit consent, revocation, allow-listed telemetry, remote configuration and
operational health — with offline-safe delivery, bounded retries, authentication and version
compatibility. Do not modify the Android repository.

## The anti-drift design

A prose contract and an implementation drift apart. So the contract is **data**, the document is
**generated from that data**, and a test suite fails if they disagree:

```
src/lib/ingest/contract.ts   → the single source of truth
docs/ANDROID-CONTRACT.md     → generated from it
tests/android-contract.test.ts → 26 cases asserting document == enforcing code
```

The tests compare published limits against the constants the validator actually enforces
(`MAX_BATCH_SIZE`, `MAX_PAYLOAD_BYTES`, `MAX_STRING_LENGTH`, `MAX_INGEST_PER_MINUTE`), so a contract
that promises 25 events per batch while the server accepts 10 cannot pass.

## What the contract specifies

**Endpoints** — `POST /api/ingest/events` (Bearer device key), `GET /api/client/config?appVersion=`,
`GET /api/health`. Each with methods, auth, body shape and both success and refusal statuses.

**Event kinds and their exact permitted fields** — the five allow-listed kinds from TASK-002's
ingestion work, each with a closed field list. An unknown kind is refused; an unexpected field inside
a known kind is refused. There is no free-form payload column, so content has nowhere to go.

**Always refused, at any depth** — message bodies and notification text, conversation history, contact
names and phone numbers and remote conversation keys, drafts and prompt snapshots and style samples,
memory facts and rolling summaries, media URIs and attachments, provider API keys and vault references
and any BYOK material, stack-trace *text* (the exception class and frame count are permitted),
advertising identifiers and precise location.

**Consent** — required before the first send; `consent_recorded_at` is `NOT NULL` so a row cannot exist
without it; revocable at any time; revocation marks the device revoked, stops every ingest key
authenticating, and **drops queued events rather than flushing them**. Consent is never implied by
installing the app, signing in, or granting notification-listener access.

**Offline-safe delivery** — queue before send, 500-entry cap, `drop-oldest` overflow, ≤3 retries with
0.5s × 2ⁿ jittered backoff capped at 8s, `Retry-After` honoured over the computed backoff, and a
strict split between retryable (408/425/429/5xx) and **non-retryable** (400/401/403/422) statuses — a
payload refused on content grounds must never be retried into a loop.

The backoff deliberately mirrors the app's existing resilience policy (`docs/SPEC.md` §6) so the
telemetry path behaves like the generation path instead of inventing a second convention.

**Version compatibility** — `clientVersionSupported()` compares numerically, so `1.7.10 > 1.7.2`.
A request with no `X-ReplyMate-App-Version` header is **refused with 426** rather than assumed
compatible, because an older build cannot know the allow-list and would send fields that no longer
exist. Wired into `POST /api/ingest/events`, audited as a denial.

## What a client build must add before this contract is live

1. An in-app consent screen whose acceptance timestamp is sent at registration.
2. An opt-in transport reading the ingest key from the Keystore, never plain storage.
3. A persistent queue honouring the limits above.
4. `X-ReplyMate-App-Version` on every request.
5. A revocation path that stops the queue and drops queued events.
6. A change-control entry under `docs/BLUEPRINT.md` §11 in the Android repository, with owner approval.

**Until all six exist, the Devices page reports zero registered devices and says so.** This PR does not
claim Android telemetry is connected.

## Evidence

```
$ npx vitest run tests/android-contract.test.ts
  Test Files  1 passed
       Tests  26 passed
```

Server-side behaviour was also demonstrated live against the deployed preview in the previous
milestone: registration `200` with a one-time ingest key, future-dated consent `409`, valid heartbeat
`200 accepted`, smuggled `body` field `422 denied_key`, smuggled `contact` field `422`,
`syncEnabled=true` `422`, unknown kind `422`, no credential `401`, `GET` on the ingest path `405`.

## The Android repository was not modified

No file in `spencerbby8-gif/ReplyMate` was read for writing, and none was changed. The only interaction
was `GET` on public raw file URLs to transcribe `ProviderType.java`, `provider-capability-map.md` and
`releases/RELEASES.md`.
