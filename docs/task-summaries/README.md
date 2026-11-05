# Task summaries

Every task carries a sequential identifier used consistently across its summary
file, its commit message and its PR comment. **A task is only reported complete
once its implementation and its evidence are pushed to `feat/admin-foundation`.**

| ID | Title | Status |
|---|---|---|
| [TASK-001](TASK-001.md) | Supabase credential discovery and secure wiring | complete |
| [TASK-002](TASK-002.md) | Live audit of the Supabase project | complete (read-only) |
| [TASK-003](TASK-003.md) | Supabase Auth strategy, role mapping and invitation gating | complete; invitation creation gated on approval |
| [TASK-004](TASK-004.md) | Migration workflow and ledger comparison | complete (read-only) |
| [TASK-005](TASK-005.md) | Secure AI gateway for ReplyMate's built-in AI | prepared and tested offline; **not deployed** |
| [TASK-006](TASK-006.md) | Android ↔ Control integration contract | complete as a contract; **not connected** |
| [TASK-007](TASK-007.md) | Maintenance scheduling, demonstrated | complete; execution demonstrated |
| [TASK-008](TASK-008.md) | Pages on live data, proxy-aware throttling, edge CSRF | complete; two items blocked on approval |
| [TASK-009](TASK-009.md) | Preview-environment verification and honest probe classification | complete |
| [TASK-010](TASK-010.md) | Build-time secret-exposure guard and branch integration | complete |

## Evidence classes

Every claim in these summaries is labelled with where it was actually observed:

| Label | Meaning |
|---|---|
| **local** | ran in the sandbox against the control-plane Postgres |
| **preview** | ran against the deployed preview build |
| **live-supabase** | a real request reached project `xdcsxxwhvpiissetbrdr` |
| **production-write** | a write to the production project — **none performed** |

## Standing constraints

No production migration applied · no plan upgraded · no paid service activated ·
no production data modified · no production secret changed · no Android
repository change · message sync remains off · no secret value in any summary,
commit, log or PR comment.
