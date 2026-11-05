# Android ↔ Control integration contract

> Contract version **1** · minimum app version **1.7.2**
>
> **STATUS: PREPARED, NOT CONNECTED.** No shipped ReplyMate build sends telemetry.
> This document is generated from `src/lib/ingest/contract.ts`; `tests/android-contract.test.ts`
> fails if the document and the enforcing validator disagree. The Android repository was **not**
> modified.

## Endpoints

### `ingest`

| Property | Value |
|---|---|
| `method` | `POST` |
| `path` | `/api/ingest/events` |
| `auth` | `Bearer <device ingest key>` |
| `contentType` | `application/json` |
| `bodyShape` | `{ "events": [ { "kind": "...", "occurredAt": "ISO-8601", "payload": { ... } } ] }` |
| `successStatuses` | `200, 207` |
| `refusalStatuses` | `400, 401, 403, 422, 426, 429` |

### `config`

| Property | Value |
|---|---|
| `method` | `GET` |
| `path` | `/api/client/config` |
| `auth` | `none (published, non-sensitive values only)` |
| `query` | `?appVersion=1.7.2` |
| `successStatuses` | `200` |
| `note` | `release:null means use the built-in defaults compiled into the app.` |

### `health`

| Property | Value |
|---|---|
| `method` | `GET` |
| `path` | `/api/health` |
| `auth` | `none` |
| `successStatuses` | `200, 503` |
| `note` | `Liveness and presence-only configuration posture. Contains no secret value.` |

## Limits

| Limit | Value |
|---|---|
| `maxBatchSize` | 25 |
| `maxPayloadBytes` | 2048 |
| `maxStringLength` | 64 |
| `maxEventsPerMinutePerDevice` | 30 |
| `maxNestingDepth` | 2 |

## Event kinds and their exact permitted fields

- **`provider_error`** — `providerKey`, `endpointHost`, `httpStatus`, `errorClass`, `suggestedFix`, `latencyMs`, `model`, `appVersion`, `androidApi`
- **`listener_state`** — `granted`, `watchedAppCount`, `rebindCount`, `batteryOptimised`, `appVersion`, `androidApi`
- **`draft_latency`** — `task`, `model`, `providerKey`, `latencyMs`, `tokensIn`, `tokensOut`, `outcome`, `thinkingLevel`, `appVersion`
- **`app_crash`** — `exceptionClass`, `frameCount`, `topFrameMethod`, `appVersion`, `androidApi`
- **`heartbeat`** — `appVersion`, `androidApi`, `uptimeMinutes`, `syncEnabled`

An unknown kind is refused. An unexpected field inside a known kind is refused. There is no
free-form payload column, so content has nowhere to go.

## Always refused, at any depth, in any kind

- message bodies and notification text
- conversation history and thread contents
- contact names, display names, phone numbers and remote conversation keys
- drafts, prompt snapshots and style samples
- memory facts and rolling summaries
- media URIs, MIME payloads and attachments
- provider API keys, vault references and any BYOK material
- stack trace text (the exception CLASS and frame count are permitted)
- device advertising identifiers and precise location

## Consent

- **requiredBeforeFirstSend**: True
- **recordedServerSide**: consent_recorded_at is NOT NULL, so a row cannot exist without it
- **revocableAtAnyTime**: True
- **revocationEffect**: Device marked revoked; every ingest key stops authenticating; queued events are dropped, not flushed.
- **neverImpliedBy**: `installing the app`, `signing in`, `using the notification listener`

## Offline-safe delivery

```json
{
  "queueBeforeSend": true,
  "maxQueueEntries": 500,
  "overflowPolicy": "drop-oldest",
  "maxRetries": 3,
  "backoff": {
    "baseMs": 500,
    "multiplier": 2,
    "jitter": true,
    "capMs": 8000
  },
  "nonRetryableStatuses": [
    400,
    401,
    403,
    422
  ],
  "retryableStatuses": [
    408,
    425,
    429,
    500,
    502,
    503,
    504
  ],
  "honourRetryAfter": true,
  "stopOnConsentRevoked": true
}
```

The backoff mirrors the app's existing resilience policy (`docs/SPEC.md` §6: 0.5s × 2ⁿ, ≤3
retries, jitter) so the telemetry path behaves like the generation path rather than inventing a
second convention.

## What a client build must add before this contract is live

1. An in-app consent screen whose acceptance timestamp is sent at registration.
2. An opt-in transport that reads the ingest key from the Keystore, never from plain storage.
3. A persistent queue honouring the limits above, with `drop-oldest` overflow.
4. `X-ReplyMate-App-Version` on every request — version gating refuses a request without it (426).
5. A revocation path that stops the queue and drops queued events rather than flushing them.
6. A change-control entry under `docs/BLUEPRINT.md` §11 in the Android repository, with owner approval.

Until all six exist, the Devices page reports zero registered devices and says so. That is the
honest state, and this PR does not claim otherwise.
