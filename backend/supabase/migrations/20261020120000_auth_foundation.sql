-- NeighborShare authentication foundation
--
-- Supabase Auth (auth.users) owns identity and credentials. These tables hold
-- application state about each user:
--   profiles            one row per auth user, created by trigger on signup
--   user_verifications  current state of each verification type per user
--   audit_events        append-only log of security-relevant events
--
-- Access model:
--   anon           no access to any of these tables
--   authenticated  reads own profile and own verifications; updates only the
--                  listed profile columns of its own row; nothing else
--   service_role   used by the backend's secret key for privileged writes
--
-- Every function is fully qualified and runs with an empty search_path.

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------

create type public.account_status as enum ('active', 'restricted', 'suspended', 'deletion_pending');

create type public.verification_type as enum ('email', 'phone', 'identity');

create type public.verification_status as enum (
  'not_started', 'pending', 'verified', 'rejected', 'expired', 'revoked'
);

create type public.audit_outcome as enum ('success', 'failure', 'denied');

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------

create table public.profiles (
  id                   uuid primary key references auth.users (id) on delete cascade,
  display_name         text check (display_name is null or char_length(display_name) between 2 and 50),
  city                 text check (city is null or char_length(city) between 2 and 80),
  neighborhood         text check (neighborhood is null or char_length(neighborhood) between 2 and 80),
  bio                  text check (bio is null or char_length(bio) <= 500),
  -- Object path inside Supabase Storage, not a URL.
  avatar_path          text check (avatar_path is null or char_length(avatar_path) <= 300),
  -- E.164 phone number. Written only by the server-side phone verification
  -- flow (not yet implemented); unverified until phone_verified_at is set.
  phone_e164           text check (phone_e164 is null or phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  phone_verified_at    timestamptz,
  -- Maintained by trigger: when the required profile fields were first all
  -- present, null while any is missing.
  profile_completed_at timestamptz,
  account_status       public.account_status not null default 'active',
  status_reason        text check (status_reason is null or char_length(status_reason) <= 500),
  status_changed_at    timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint profiles_phone_verified_requires_phone
    check (phone_verified_at is null or phone_e164 is not null)
);

comment on table public.profiles is 'Application profile for each auth user. Created by trigger on auth.users insert.';

-- A verified phone number belongs to at most one account.
create unique index profiles_verified_phone_unique
  on public.profiles (phone_e164)
  where phone_verified_at is not null;

create index profiles_account_status_idx on public.profiles (account_status)
  where account_status <> 'active';

-- ---------------------------------------------------------------------------
-- user_verifications
-- ---------------------------------------------------------------------------

create table public.user_verifications (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references public.profiles (id) on delete cascade,
  verification_type  public.verification_type not null,
  status             public.verification_status not null default 'not_started',
  provider_name      text check (provider_name is null or char_length(provider_name) between 1 and 64),
  -- Opaque reference into the provider's system. Never a document number,
  -- OTP or raw provider payload.
  provider_reference text check (provider_reference is null or char_length(provider_reference) between 1 and 128),
  verified_at        timestamptz,
  expires_at         timestamptz,
  status_changed_at  timestamptz not null default now(),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  -- One current record per user and type; history is in audit_events.
  constraint user_verifications_user_type_unique unique (user_id, verification_type),
  constraint user_verifications_verified_has_timestamp
    check (status <> 'verified' or verified_at is not null),
  constraint user_verifications_reference_needs_provider
    check (provider_reference is null or provider_name is not null)
);

comment on table public.user_verifications is
  'Current state of each verification type per user. Transitions are enforced by trigger and logged to audit_events.';

-- The same provider result cannot be attached to two users.
create unique index user_verifications_provider_ref_unique
  on public.user_verifications (provider_name, provider_reference)
  where provider_reference is not null;

-- ---------------------------------------------------------------------------
-- audit_events
-- ---------------------------------------------------------------------------

create table public.audit_events (
  id            bigint generated always as identity primary key,
  -- Null for system events. Set null if the user is later deleted, so the
  -- event survives without pointing at a removed account.
  actor_user_id uuid references auth.users (id) on delete set null,
  event_type    text not null check (event_type ~ '^[a-z][a-z_]*(\.[a-z][a-z_]*)+$' and char_length(event_type) <= 64),
  entity_type   text check (entity_type is null or entity_type ~ '^[a-z][a-z_]{0,31}$'),
  entity_id     uuid,
  outcome       public.audit_outcome not null,
  -- Small, non-sensitive context only (e.g. {"from":"pending","to":"verified"}).
  metadata      jsonb not null default '{}'::jsonb
                check (jsonb_typeof(metadata) = 'object' and pg_column_size(metadata) <= 2048),
  created_at    timestamptz not null default now(),
  constraint audit_events_entity_pair check ((entity_type is null) = (entity_id is null))
);

comment on table public.audit_events is 'Append-only security audit log. No client access.';

create index audit_events_actor_idx on public.audit_events (actor_user_id, created_at desc);
create index audit_events_entity_idx on public.audit_events (entity_type, entity_id, created_at desc);
create index audit_events_type_idx on public.audit_events (event_type, created_at desc);

-- ---------------------------------------------------------------------------
-- Trigger functions
-- ---------------------------------------------------------------------------

create function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := pg_catalog.now();
  return new;
end;
$$;

-- Keeps profile_completed_at and status_changed_at consistent with the row.
create function public.profiles_maintain_derived()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  complete boolean := new.display_name is not null
                      and new.city is not null
                      and new.neighborhood is not null;
begin
  if not complete then
    new.profile_completed_at := null;
  elsif tg_op = 'INSERT' or old.profile_completed_at is null then
    new.profile_completed_at := pg_catalog.now();
  else
    new.profile_completed_at := old.profile_completed_at;
  end if;

  if tg_op = 'UPDATE' and new.account_status is distinct from old.account_status then
    new.status_changed_at := pg_catalog.now();
  end if;

  return new;
end;
$$;

create function public.profiles_audit_status_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.audit_events (actor_user_id, event_type, entity_type, entity_id, outcome, metadata)
  values (
    null,
    'account.status_changed',
    'profile',
    new.id,
    'success',
    pg_catalog.jsonb_build_object('from', old.account_status, 'to', new.account_status)
  );
  return null;
end;
$$;

-- Allowed status transitions. Re-asserting the same status is a no-op.
create function public.verification_transition_allowed(
  from_status public.verification_status,
  to_status public.verification_status
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select from_status = to_status or (from_status, to_status) in (
    ('not_started'::public.verification_status, 'pending'::public.verification_status),
    ('not_started', 'verified'),
    ('pending',     'verified'),
    ('pending',     'rejected'),
    ('pending',     'expired'),
    ('pending',     'not_started'),
    ('verified',    'revoked'),
    ('verified',    'expired'),
    ('rejected',    'pending'),
    ('expired',     'pending'),
    ('revoked',     'pending')
  );
$$;

create function public.user_verifications_enforce_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.user_id is distinct from old.user_id
     or new.verification_type is distinct from old.verification_type then
    raise exception 'user_id and verification_type cannot change'
      using errcode = 'check_violation';
  end if;

  if not public.verification_transition_allowed(old.status, new.status) then
    raise exception 'invalid verification transition % -> %', old.status, new.status
      using errcode = 'check_violation';
  end if;

  if new.status is distinct from old.status then
    new.status_changed_at := pg_catalog.now();
    -- Leaving "verified" for a fresh attempt clears the old result.
    if new.status in ('pending', 'not_started') then
      new.verified_at := null;
    end if;
  end if;

  return new;
end;
$$;

create function public.user_verifications_audit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.status is not distinct from old.status then
    return null;
  end if;

  insert into public.audit_events (actor_user_id, event_type, entity_type, entity_id, outcome, metadata)
  values (
    null,
    'verification.status_changed',
    'user_verification',
    new.id,
    'success',
    pg_catalog.jsonb_build_object(
      'user_id', new.user_id,
      'type', new.verification_type,
      'from', case when tg_op = 'UPDATE' then old.status::text end,
      'to', new.status
    )
  );
  return null;
end;
$$;

-- Audit rows are immutable. The only permitted update is the foreign key's
-- own ON DELETE SET NULL when the actor's account is deleted.
create function public.audit_events_block_changes()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE'
     and old.actor_user_id is not null
     and new.actor_user_id is null
     and (new.id, new.event_type, new.entity_type, new.entity_id, new.outcome, new.metadata, new.created_at)
         is not distinct from
         (old.id, old.event_type, old.entity_type, old.entity_id, old.outcome, old.metadata, old.created_at) then
    return new;
  end if;
  raise exception 'audit_events is append-only' using errcode = 'insufficient_privilege';
end;
$$;

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

create trigger profiles_maintain_derived
  before insert or update on public.profiles
  for each row execute function public.profiles_maintain_derived();

create trigger profiles_audit_status_change
  after update of account_status on public.profiles
  for each row when (new.account_status is distinct from old.account_status)
  execute function public.profiles_audit_status_change();

create trigger user_verifications_set_updated_at
  before update on public.user_verifications
  for each row execute function public.set_updated_at();

create trigger user_verifications_enforce_transition
  before update on public.user_verifications
  for each row execute function public.user_verifications_enforce_transition();

create trigger user_verifications_audit
  after insert or update on public.user_verifications
  for each row execute function public.user_verifications_audit();

create trigger audit_events_block_changes
  before update or delete on public.audit_events
  for each row execute function public.audit_events_block_changes();

-- ---------------------------------------------------------------------------
-- Profile provisioning from auth.users
-- ---------------------------------------------------------------------------

-- Runs inside the signup transaction. Idempotent (ON CONFLICT DO NOTHING) so a
-- retried insert cannot duplicate or fail on existing rows. It reads only the
-- new auth row, never client-supplied ids. A user-supplied display name in
-- signup metadata is used only if it already satisfies the column rules, so
-- bad metadata cannot make signup fail.
create function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  requested_name text := pg_catalog.btrim(new.raw_user_meta_data ->> 'display_name');
  inserted_id uuid;
begin
  -- ->> renders objects and arrays as JSON text; accept only a JSON string.
  if pg_catalog.jsonb_typeof(new.raw_user_meta_data -> 'display_name') is distinct from 'string'
     or pg_catalog.char_length(requested_name) not between 2 and 50 then
    requested_name := null;
  end if;

  insert into public.profiles (id, display_name)
  values (new.id, requested_name)
  on conflict (id) do nothing
  returning id into inserted_id;

  insert into public.user_verifications (user_id, verification_type, status, provider_name, verified_at)
  values
    (
      new.id,
      'email',
      case
        when new.email is null then 'not_started'
        when new.email_confirmed_at is not null then 'verified'
        else 'pending'
      end::public.verification_status,
      case when new.email is not null then 'supabase_auth' end,
      new.email_confirmed_at
    ),
    (new.id, 'phone', 'not_started', null, null),
    (new.id, 'identity', 'not_started', null, null)
  on conflict (user_id, verification_type) do nothing;

  if inserted_id is not null then
    insert into public.audit_events (actor_user_id, event_type, entity_type, entity_id, outcome, metadata)
    values (new.id, 'auth.user_registered', 'profile', new.id, 'success', '{}'::jsonb);
  end if;

  return new;
end;
$$;

-- Mirrors Supabase's email confirmation into user_verifications.
create function public.handle_auth_email_confirmed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.user_verifications
     set status = 'verified',
         provider_name = 'supabase_auth',
         verified_at = new.email_confirmed_at
   where user_id = new.id
     and verification_type = 'email'
     and status in ('not_started', 'pending');
  return null;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

create trigger on_auth_user_email_confirmed
  after update of email_confirmed_at on auth.users
  for each row
  when (old.email_confirmed_at is null and new.email_confirmed_at is not null)
  execute function public.handle_auth_email_confirmed();

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

-- Supabase grants broad default privileges on new public objects to anon and
-- authenticated. Start from nothing and grant only what is needed.
revoke all on table public.profiles, public.user_verifications, public.audit_events
  from public, anon, authenticated;
revoke all on sequence public.audit_events_id_seq from public, anon, authenticated;

grant select on table public.profiles to authenticated;
grant update (display_name, city, neighborhood, bio, avatar_path) on table public.profiles to authenticated;
grant select on table public.user_verifications to authenticated;

grant select, insert, update, delete on table public.profiles to service_role;
grant select, insert, update, delete on table public.user_verifications to service_role;
grant select, insert on table public.audit_events to service_role;
grant usage on sequence public.audit_events_id_seq to service_role;

-- Functions are callable through the Data API unless revoked.
revoke execute on function
  public.set_updated_at(),
  public.profiles_maintain_derived(),
  public.profiles_audit_status_change(),
  public.verification_transition_allowed(public.verification_status, public.verification_status),
  public.user_verifications_enforce_transition(),
  public.user_verifications_audit(),
  public.audit_events_block_changes(),
  public.handle_new_auth_user(),
  public.handle_auth_email_confirmed()
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Row-Level Security
-- ---------------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.user_verifications enable row level security;
alter table public.audit_events enable row level security;

create policy "profiles: owner can read"
  on public.profiles for select
  to authenticated
  using (id = (select auth.uid()));

-- Column grants limit WHICH fields can change; this limits WHOSE row and
-- blocks suspended or deletion-pending accounts from editing.
create policy "profiles: owner can update allowed fields while in good standing"
  on public.profiles for update
  to authenticated
  using (id = (select auth.uid()) and account_status in ('active', 'restricted'))
  with check (id = (select auth.uid()) and account_status in ('active', 'restricted'));

create policy "user_verifications: owner can read"
  on public.user_verifications for select
  to authenticated
  using (user_id = (select auth.uid()));

-- audit_events: RLS enabled with no policies, so no client role can read or
-- write it even if a grant is added by mistake.
