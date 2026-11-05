-- =====================================================================
-- ReplyMate Control — 0001_control_plane.sql
--
-- STATUS: AUTHORED, **NOT APPLIED**. Review only. See ./README.md.
--
-- This is the SQL an owner would run IF — and only if — they chose to host the
-- control plane inside the same Supabase project as the ReplyMate app data
-- plane, instead of the separate Postgres this repository assumes by default.
--
-- The authoritative definition of these tables is `src/db/schema.ts`. This file
-- exists because a Supabase project has properties a plain Postgres does not:
--
--   * `anon` and `authenticated` receive ALL privileges on every new public
--     table through platform DEFAULT PRIVILEGES. ReplyMate hit exactly this
--     drift and fixed it in its own migration 0003. The same mistake must not be
--     repeated here, so the REVOKEs below are the point of this file.
--   * RLS must be enabled explicitly, or PostgREST will serve these tables to
--     anyone holding the anon key — which is public by design in this product.
--
-- If you are deploying the control plane to its own database (the default and
-- the recommendation), DO NOT RUN THIS. Run `npx drizzle-kit push` followed by
-- `npx tsx scripts/apply-hardening.ts` instead.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. Tables
--
--    Column definitions are generated from src/db/schema.ts by
--    `npx drizzle-kit generate`. They are intentionally NOT duplicated here,
--    because two hand-maintained copies of a schema is how drift starts —
--    the exact failure mode ReplyMate's migration 0003 documents.
--
--    Apply order for a shared project:
--      a) drizzle-kit push / generate+apply   → creates ctl_* tables
--      b) THIS file                           → locks them down
-- ---------------------------------------------------------------------

-- ---------------------------------------------------------------------
-- 2. RLS on every control-plane table
--
--    Enabled with NO policies. That is deliberate: these tables are reached
--    only by trusted server code over a direct Postgres connection using the
--    service role, which bypasses RLS. PostgREST traffic from an anon or
--    authenticated key therefore sees nothing at all, rather than seeing
--    whatever a permissive policy happened to allow.
-- ---------------------------------------------------------------------

alter table public.ctl_admin            enable row level security;
alter table public.ctl_session          enable row level security;
alter table public.ctl_invite           enable row level security;
alter table public.ctl_login_attempt    enable row level security;
alter table public.ctl_audit_log        enable row level security;
alter table public.ctl_feature_flag     enable row level security;
alter table public.ctl_ai_provider      enable row level security;
alter table public.ctl_model_route      enable row level security;
alter table public.ctl_release          enable row level security;
alter table public.ctl_device           enable row level security;
alter table public.ctl_plan             enable row level security;
alter table public.ctl_subscription     enable row level security;
alter table public.ctl_config_item      enable row level security;
alter table public.ctl_monitor_probe    enable row level security;
alter table public.ctl_support_ticket   enable row level security;
alter table public.ctl_aiops_session    enable row level security;
alter table public.ctl_aiops_message    enable row level security;

-- ---------------------------------------------------------------------
-- 3. Revoke the platform default-privilege surface
--
--    `anon` gets NOTHING. `authenticated` gets NOTHING. Unlike the ReplyMate
--    app tables — where an end user legitimately CRUDs their own rows — no
--    end-user token should ever touch a control-plane table. An administrator
--    is a server-side concept here, not a PostgREST role.
-- ---------------------------------------------------------------------

revoke all privileges on all tables in schema public from anon;
revoke all privileges on all tables in schema public from authenticated;

-- Stop future tables inheriting the same problem.
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke all on tables from authenticated;

-- ---------------------------------------------------------------------
-- 4. Audit immutability (mirrors src/db/hardening.sql)
-- ---------------------------------------------------------------------

create or replace function public.ctl_assert_audit_immutable()
returns trigger
language plpgsql
as $$
begin
  raise exception
    'ctl_audit_log is append-only: % is refused by database policy (see docs/SECURITY.md)',
    tg_op
    using errcode = '42501';
end;
$$;

drop trigger if exists ctl_audit_log_no_update on public.ctl_audit_log;
create trigger ctl_audit_log_no_update
  before update on public.ctl_audit_log
  for each row execute function public.ctl_assert_audit_immutable();

drop trigger if exists ctl_audit_log_no_delete on public.ctl_audit_log;
create trigger ctl_audit_log_no_delete
  before delete on public.ctl_audit_log
  for each row execute function public.ctl_assert_audit_immutable();

-- ---------------------------------------------------------------------
-- 5. Record the migration
--
--    Uses ReplyMate's own ledger convention (`rm_schema_migrations`, 000N_*.sql
--    names) rather than the CLI's timestamp table, so the two schemas stay
--    auditable in one place. The version namespace is prefixed to make it
--    impossible to confuse a control-plane migration with an app migration.
-- ---------------------------------------------------------------------

insert into public.rm_schema_migrations (version, label)
select 9001, 'control-plane 0001: RLS on ctl_* with no policies, anon+authenticated revoked, audit immutability triggers'
where exists (select 1 from information_schema.tables where table_name = 'rm_schema_migrations' and table_schema = 'public')
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;

-- ---------------------------------------------------------------------
-- Verification (run after applying; all four must hold)
--
--   1. select relname, relrowsecurity from pg_class
--        where relname like 'ctl_%' and relkind = 'r';
--      → relrowsecurity = true for all 17 tables
--
--   2. select grantee, privilege_type from information_schema.role_table_grants
--        where table_name like 'ctl_%' and grantee in ('anon','authenticated');
--      → 0 rows
--
--   3. INSERT a probe row (permitted -- the table is append-only, not read-only),
--      then attack THAT row:
--        update public.ctl_audit_log set action = 'tampered' where id = <probe>;
--        delete from public.ctl_audit_log where id = <probe>;
--      → both must raise ERROR 42501 "ctl_audit_log is append-only"
--
--      Do NOT verify with a predicate that matches no rows (e.g. id = -1). These
--      are ROW triggers: PostgreSQL evaluates WHERE first and only fires the
--      trigger for matching rows, so a non-matching predicate "succeeds" with
--      0 rows and reports a false negative while the trigger works perfectly.
--
-- None of these queries touch a ReplyMate app table. This migration grants no
-- new access to message, memory_fact, contact_summary, draft, style_profile,
-- app_kv, contact or contact_channel, and cannot: it does not mention them.
-- ---------------------------------------------------------------------
