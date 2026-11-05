# TASK-011 — Supabase Auth cutover preflight

**Status:** COMPLETE

> **Identifier note.** This work was first committed as `TASK-010`. That
> identifier had already been taken on the remote branch by *"Build-time
> secret-exposure guard and branch integration"*, pushed from a parallel session
> while this was in flight. It is renumbered to `TASK-011` so identifiers stay
> unique and sequential across commits, documentation and PR reports. The PR
> comment that describes a "TASK-010 cutover preflight" refers to **this** task.
**Branch:** `feat/admin-foundation` · **PR:** #1

## Objective

`AUTH_PROVIDER=supabase` is implemented (TASK-003) and fails closed rather than
falling back to local hashes. But switching it on is not a one-line change:
several preconditions live in the Supabase **project configuration**, which this
platform can read and must never alter.

Without a preflight the failure mode is bad. An operator flips the variable and
either nobody can sign in, or self-service sign-up is open on a project meant for
invitation-only administration. This task makes the answer evidence-based:
*can we switch right now, and if not, exactly what must change first?*

## Design

Two halves, deliberately separated:

| Half | Responsibility |
|---|---|
| `gatherCutoverFacts()` (`src/lib/supabase/cutover-live.ts`) | Live **read-only** collection: two `GET`s against Supabase Auth, four `COUNT`s against the control plane |
| `evaluateCutover()` (`src/lib/supabase/cutover.ts`) | **Pure** function turning facts into a verdict |

The split exists so the policy is exhaustively testable offline, and so the live
half cannot embed a judgement the tests never see.

**Read-only, verified.** No project setting is changed, no user created, no
invitation sent, no row written. Fixing a failed check is an owner action in the
Supabase dashboard, and each check says so explicitly.

Invariant enforced by test: a `pass` check carries an **empty** `action`, and any
`unknown` fact **blocks** readiness. A silent pass on missing data is the exact
bug class this guards against — this suite found one instance of it in my own
first draft (see below).

## The eleven checks

`credentials` · `project-ref` · `disable-signup` · `mfa-parity` ·
`signable-identity` · `role-mapping` · `owner-continuity` · `anonymous-signin` ·
`admin-invite` · `db-separation` · `encryption-key`

Two are worth calling out because they are not obvious:

**`mfa-parity` is treated as blocking, not informational.** Local mode enforces
TOTP with this repository's own RFC 6238 implementation. Supabase mode delegates
the second factor to Supabase, so if the project has MFA disabled the cutover
would **silently remove a control**. That is a downgrade, and reporting it as a
warning would understate it.

**`owner-continuity` guards against locking yourself out.** A cutover with no
owner row would leave nobody able to administer administrators, and no way to
recover from inside the product.

## Live result against `xdcsxxwhvpiissetbrdr`

```
VERDICT: NOT ready — 3 blocking checks

BLOCK  disable-signup      disable_signup = FALSE. Anyone who can reach the
                           project can create an Auth identity.
BLOCK  mfa-parity          TOTP not fully enabled at project level.
BLOCK  signable-identity   4 auth users, 3 ANONYMOUS, 0 EMAIL-CONFIRMED.
WARN   role-mapping        1 ctl_admin row, 0 linked to a Supabase user id.
WARN   anonymous-signin    Anonymous sign-in ENABLED (ReplyMate guest mode),
                           3 anonymous users.
WARN   admin-invite        SUPABASE_ALLOW_ADMIN_INVITE unset; invite() fails closed.
PASS   credentials · project-ref · owner-continuity · db-separation · encryption-key
```

### The blocker nobody had quantified

**Three of the four auth users are anonymous, and zero are email-confirmed.**
Those four accounts are residue from ReplyMate's P-auth work (1.2.0), which
shipped guest mode via anonymous sign-in.

The consequence is concrete: in supabase mode there is currently **no identity
that could authenticate as an administrator at all**. Role mapping correctly
rejects anonymous identities before any role lookup (TASK-003), so all three are
unusable, and the fourth is unconfirmed. Switching `AUTH_PROVIDER` today would
not degrade access — it would remove it entirely, including for the owner, with
no in-product recovery path.

This is exactly the outcome the preflight exists to prevent, and it is now
evidenced rather than assumed.

## Defect found in my own first draft

`anonymous-signin` returned `status: "pass"` while still carrying a non-empty
`action` ("confirm guest mode still works"). That broke the pass⇒no-action
invariant and made the output ambiguous — a reader cannot tell whether an action
is required. Fixed by moving the advisory into `detail` when the check passes and
keeping it in `action` only when it warns. Pinned by the test
*"leaves the action empty for a passing check"*, which is what caught it.

A second test defect was mine, not the code's: the `READY` fixture carried
`anonymousAuthUsers: 1`, so it was never actually warning-free and the
"all checks pass" summary could not be asserted. The **fixture** was corrected;
the assertion was left intact.

## Files affected

| File | Change |
|---|---|
| `src/lib/supabase/cutover.ts` | **New.** Pure `evaluateCutover()`, 11 checks, exported types |
| `src/lib/supabase/cutover-live.ts` | **New.** `gatherCutoverFacts()`, read-only |
| `scripts/supabase-cutover-preflight.ts` | **New.** CLI runner; exits non-zero when not ready |
| `src/app/(admin)/security/page.tsx | Live preflight panel: verdict, per-check status, detail and action |
| `tests/cutover.test.ts` | **New.** 33 cases |

## Verification

| Level | Result |
|---|---|
| Local unit tests | **604 passed** (was 571), 21 files |
| Live Supabase operation | preflight executed against `xdcsxxwhvpiissetbrdr`; 2 real `GET`s |
| Preview environment | `/security` renders the live verdict and all 11 checks |
| Production writes | **none** |

eslint clean · `tsc --noEmit` clean · `next build` clean · `check-secrets` clean.

## Remaining issues

1. **The cutover remains blocked, correctly.** Three owner actions are required
   in the Supabase dashboard: disable self-service sign-up, enable TOTP MFA, and
   create a confirmed administrator identity. This task deliberately performs
   none of them.
2. **Google OAuth is disabled** on the project while ReplyMate 1.2.0 ships a
   Google sign-in path (TASK-002 F3). Not a cutover blocker, but it means the
   app's Google flow cannot work against this project as configured.
3. The preflight runs on every render of `/security`. It is two `GET`s and four
   `COUNT`s, so the cost is small, but it is not cached — a deliberate choice,
   because a cached preflight would report a stale verdict about a live
   configuration.
4. `SUPABASE_ALLOW_ADMIN_INVITE` stays unset until `disable-signup` passes.
   Enabling invitations before that would let the platform send email into a
   project that still allows public sign-up.
