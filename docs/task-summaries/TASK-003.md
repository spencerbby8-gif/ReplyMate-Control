# TASK-003 — Supabase Auth strategy, role mapping and invitation gating

**Status:** COMPLETE for verification; **invitation creation gated pending owner approval**
**Branch:** `feat/admin-foundation` · **PR:** #1

## Objective

Finish the Supabase authentication strategy: verification, role mapping, session handling and secure
admin invitations — without letting an IdP-side identity grant administrative access, and without
writing to the production identity store as a side effect of an operator clicking a button.

## Why role mapping had to be written down as a rule

The live audit (TASK-002) produced two facts that decide the design:

1. **`disable_signup` is `false`** on the production project — anyone can create an auth user.
2. **`anonymous_users` is enabled**, and 3 of the 4 existing users are anonymous with an empty-string
   email and no provider recorded.

A Supabase session therefore proves *somebody authenticated* and nothing else. Trusting `role`, `aud`,
`app_metadata` or `user_metadata` would let an Android end-user — or an anonymous signup — mint
themselves an administrator by writing their own metadata.

**The rule: Supabase verifies the password; `ctl_admin` decides the role.**

## Changes

| File | Change |
|---|---|
| `src/lib/auth/role-mapping.ts` | **New.** Pure `requireRoleRow()` decision function, `isAnonymousIdentity()`, the `UNTRUSTED_CLAIMS` list and a published `ROLE_MAPPING_POLICY`. Every branch total and covered. |
| `src/app/api/auth/login/route.ts` | In supabase mode, a verified identity is passed through `requireRoleRow()`. A refusal is audited as `authz.denied` **and returns the identical `401 invalid_credentials` body** as a bad password, so the existence of a Supabase identity without an admin row is not disclosed. |
| `src/lib/auth/identity.ts` | `VerifyResult` now carries `anonymous`, derived from `is_anonymous`, `app_metadata.provider` **or an empty/absent email** — the shape actually observed in the live project. |
| `src/lib/auth/identity.ts` | `supabaseIdentity.invite()` is gated behind `SUPABASE_ALLOW_ADMIN_INVITE=true` and **fails closed by default**. |
| `tests/role-mapping.test.ts` | **New**, 18 cases. |

## The invitation gate — why it fails closed

`auth.admin.inviteUserByEmail` **creates a row in the production `auth.users` table** of the ReplyMate
project. That is a production data change. An operator clicking "Invite administrator" in a console
must not be able to write to the app's production identity store as a side effect, so:

```
SUPABASE_ALLOW_ADMIN_INVITE unset or != "true"
  → { ok: false, code: "provider_unavailable",
      reason: "...would create a user in the production ReplyMate auth.users
               table, which needs owner approval..." }
```

**No production auth user was created during this work.** Verification was performed with a
`signInWithPassword` call using deliberately wrong credentials against an `@invalid.example` address,
which exercises the real round-trip and creates nothing.

## Session handling in supabase mode

The Supabase session returned by `signInWithPassword` is **discarded**. This application issues its own
digest-stored cookie. Persisting both would create two sources of truth for "is this administrator
signed in", and the Supabase token would be a second credential to protect for no benefit.

Everything else is unchanged and already tested: opaque 256-bit cookie, digest-only storage keyed from
the durable key (commit b303d76), idle expiry clamped to an absolute ceiling,
immediate revocation, MFA-pending partial sessions that can reach only the challenge endpoint.

MFA in supabase mode is delegated to Supabase (`mfaEnrolledExternally`); in local mode it is this
repository's own RFC 6238 implementation. `ctl_admin.mfa_enrolled_at` describes the **local** factor
only, and the UI says so rather than implying a single MFA state.

## Evidence

```
$ npx vitest run tests/role-mapping.test.ts
  Test Files  1 passed
       Tests  18 passed
```

Cases include: no `ctl_admin` row → refused `no_admin_row`; anonymous identity → refused even when an
admin row exists; missing Supabase user id → refused; `invited`/`suspended` rows → refused; each of the
five roles mapped exactly; a viewer row never upgraded; empty-string email flagged anonymous (the live
project's actual shape); the untrusted-claim list complete.

```
$ npx tsx scripts/verify-integration.ts
Identity strategy
  PASS  the supabase strategy reports itself configured from real credentials
  PASS  supabase strategy completes a real round-trip and rejects bad credentials — invalid_credentials
RESULT: 35 passed, 0 failed
```

## Remaining issues

| Item | Status | Required action |
|---|---|---|
| Create a real administrator via Supabase invitation | **BLOCKED — needs approval** | Set `SUPABASE_ALLOW_ADMIN_INVITE=true` and accept that a row is written to production `auth.users`. |
| Switch the deployment to `AUTH_PROVIDER=supabase` | **BLOCKED — needs approval** | Operational decision. Until then `local` is active and fully functional. |
| Supabase-side MFA | **NOT CONFIGURED on the project** | `/auth/v1/settings` returns `mfa: null` and 0 users have factors. Enabling it is a production auth change. |
| Google OAuth | **DISABLED on the project** | Reported to the owner in TASK-002: ReplyMate 1.2.0 shipped a Google sign-in path that cannot succeed against this project. |
