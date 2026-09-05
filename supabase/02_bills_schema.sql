-- ============================================================================
-- 02 — `bills` schema for the Manning household bills tracker
--
-- Replaces the handoff bundle's public.bills_state, which granted the anon
-- role unrestricted read AND write (`to anon using (true)`). Here nothing is
-- granted to anon at all: every policy requires a signed-in user whose email
-- is on the allowlist below.
-- ============================================================================

create schema if not exists bills;

-- ---------------------------------------------------------------------------
-- Who is allowed in. Keyed by email so it works before either account exists;
-- a magic-link sign-in matches on the JWT's email claim the moment it lands.
-- ---------------------------------------------------------------------------
create table if not exists bills.allowed_emails (
  email      text primary key,
  note       text,
  added_at   timestamptz not null default now()
);

comment on table bills.allowed_emails is
  'Allowlist for the bills app. Anyone may sign up via magic link, but only '
  'these addresses can read or write bills data. Edit via SQL editor only.';

-- ---------------------------------------------------------------------------
-- The ledger: one JSON document per row (row id ''main'' is the household).
-- `version` is bumped by the trigger below and is what a stale tab collides
-- on, so a phone left open last week cannot silently clobber today''s edits.
-- ---------------------------------------------------------------------------
create table if not exists bills.state (
  id          text primary key,
  data        jsonb not null,
  version     bigint not null default 1,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references auth.users(id) on delete set null
);

-- ---------------------------------------------------------------------------
-- Every save, kept. ~58 KB per revision, a few revisions a week — trivial
-- against the 500 MB free-tier budget, and it makes any bad write recoverable.
-- ---------------------------------------------------------------------------
create table if not exists bills.state_history (
  history_id  bigserial primary key,
  state_id    text not null,
  data        jsonb not null,
  version     bigint not null,
  saved_at    timestamptz not null default now(),
  saved_by    uuid references auth.users(id) on delete set null
);

create index if not exists state_history_state_id_saved_at_idx
  on bills.state_history (state_id, saved_at desc);

-- ---------------------------------------------------------------------------
-- Membership test. SECURITY DEFINER so the policies below can consult the
-- allowlist without the allowlist''s own RLS causing infinite recursion.
-- ---------------------------------------------------------------------------
create or replace function bills.is_member()
  returns boolean
  language sql
  stable
  security definer
  set search_path = bills, pg_temp
as $$
  select exists (
    select 1 from bills.allowed_emails
    where lower(email) = lower(
      nullif(
        nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email',
        '')
    )
  );
$$;
-- Note the double nullif: guard the empty string BEFORE casting to jsonb.
-- Casting first means ''::jsonb raises "invalid input syntax for type json"
-- rather than denying cleanly, and an error is the wrong way to fail closed.

-- ---------------------------------------------------------------------------
-- Bump version on every save (BEFORE), then record history (AFTER).
--
-- These are deliberately two triggers. A BEFORE INSERT trigger still fires
-- when `on conflict do nothing` ends up skipping the row, so writing history
-- there would log phantom revisions every time the seed script is re-run.
-- An AFTER trigger only fires on a row that was actually written.
-- ---------------------------------------------------------------------------
create or replace function bills.stamp_state()
  returns trigger
  language plpgsql
  security definer
  set search_path = bills, pg_temp
as $$
begin
  if tg_op = 'UPDATE' then
    new.version := old.version + 1;
  end if;
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end;
$$;

create or replace function bills.record_state_history()
  returns trigger
  language plpgsql
  security definer
  set search_path = bills, pg_temp
as $$
begin
  insert into bills.state_history (state_id, data, version, saved_by)
  values (new.id, new.data, new.version, auth.uid());
  return null;
end;
$$;

drop trigger if exists state_write on bills.state;
drop trigger if exists state_stamp on bills.state;
create trigger state_stamp
  before insert or update on bills.state
  for each row execute function bills.stamp_state();

drop trigger if exists state_history_write on bills.state;
create trigger state_history_write
  after insert or update on bills.state
  for each row execute function bills.record_state_history();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table bills.allowed_emails enable row level security;
alter table bills.state          enable row level security;
alter table bills.state_history  enable row level security;

-- Members may see the allowlist (so the app can show who has access).
drop policy if exists members_read_allowlist on bills.allowed_emails;
create policy members_read_allowlist
  on bills.allowed_emails for select
  to authenticated
  using (bills.is_member());
-- No insert/update/delete policy: the allowlist changes via the SQL editor only.

drop policy if exists members_read_state on bills.state;
create policy members_read_state
  on bills.state for select
  to authenticated
  using (bills.is_member());

drop policy if exists members_insert_state on bills.state;
create policy members_insert_state
  on bills.state for insert
  to authenticated
  with check (bills.is_member());

drop policy if exists members_update_state on bills.state;
create policy members_update_state
  on bills.state for update
  to authenticated
  using (bills.is_member())
  with check (bills.is_member());
-- No delete policy: the ledger cannot be dropped through the API.

drop policy if exists members_read_history on bills.state_history;
create policy members_read_history
  on bills.state_history for select
  to authenticated
  using (bills.is_member());
-- No insert policy: history is written only by the SECURITY DEFINER trigger.

-- ---------------------------------------------------------------------------
-- Grants. Note what is absent: anon gets nothing, not even schema USAGE.
-- ---------------------------------------------------------------------------
grant usage on schema bills to authenticated;
grant select                 on bills.allowed_emails to authenticated;
grant select, insert, update on bills.state          to authenticated;
grant select                 on bills.state_history  to authenticated;

revoke all on schema bills from anon;
revoke all on all tables in schema bills from anon;

-- ---------------------------------------------------------------------------
-- Realtime, so the other person''s save lands live. Realtime honours RLS, so
-- only signed-in members receive the change feed.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'bills' and tablename = 'state'
  ) then
    alter publication supabase_realtime add table bills.state;
  end if;
end $$;
