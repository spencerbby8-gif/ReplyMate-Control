-- =====================================================================
-- ReplyMate Control — database hardening (CONTROL PLANE ONLY)
--
-- Target: the database in DATABASE_URL. This file must NEVER be applied to the
-- ReplyMate production Supabase project. `scripts/apply-hardening.ts` asserts
-- that by refusing to run when the connection string does not look like the
-- control plane.
--
-- Idempotent: every statement uses CREATE OR REPLACE / DROP ... IF EXISTS /
-- DO $$ guards, so re-running is safe.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Audit immutability at the database layer
--
--    The application has no UPDATE or DELETE path for ctl_audit_log. That is a
--    promise made in code; this makes it a promise the database keeps. A row
--    trigger fires for the table owner too, so even a superuser session that
--    reaches this database cannot quietly rewrite history.
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

-- TRUNCATE cannot be intercepted by a trigger, so it is constrained by
-- privilege instead: the application role must never hold it.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'rmctl_app') then
    revoke truncate, update, delete on public.ctl_audit_log from rmctl_app;
    grant select, insert on public.ctl_audit_log to rmctl_app;
  end if;
end $$;

comment on table public.ctl_audit_log is
  'Append-only. UPDATE and DELETE are refused by trigger; TRUNCATE must not be granted to the application role.';

-- ---------------------------------------------------------------------
-- 2. Credential columns are never readable through a view or the API layer
--    by accident: revoke column-level SELECT from PUBLIC as a floor.
-- ---------------------------------------------------------------------

revoke all privileges on public.ctl_admin from public;
revoke all privileges on public.ctl_session from public;
revoke all privileges on public.ctl_invite from public;
revoke all privileges on public.ctl_login_attempt from public;
revoke all privileges on public.ctl_audit_log from public;

-- ---------------------------------------------------------------------
-- 3. Indexes the throttle and session paths depend on. Drizzle creates the
--    declared ones; these are additional composite indexes for the hot paths.
-- ---------------------------------------------------------------------

create index if not exists ctl_session_lookup_idx
  on public.ctl_session (token_hash)
  where revoked_at is null;

create index if not exists ctl_login_attempt_throttle_idx
  on public.ctl_login_attempt (source_digest, ts desc);

create index if not exists ctl_audit_log_recent_idx
  on public.ctl_audit_log (ts desc);
