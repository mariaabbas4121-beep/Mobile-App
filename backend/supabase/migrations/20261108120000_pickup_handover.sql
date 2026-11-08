-- NeighborShare pickup authorization and handover (Phase 3B.1)
--
-- After a borrow request is accepted, the lender hands the item over. The
-- borrower either collects it in person, or authorizes someone else (who
-- needs no account) with a one-time code shown as a QR. Either way the
-- LENDER confirms the handover; nobody else can.
--
--   pickup_authorizations  one-time permission for a named person to collect
--                          the item. Only a SHA-256 hash of the code is
--                          stored; the code itself is shown once, to the
--                          borrower. Nobody can read this table directly.
--   handovers              the handover itself, at most one per request. Its
--                          existence is what "handed over" means: there is
--                          no separate status to fall out of step.
--   handover_photos        condition photos the confirming lender took, in
--                          the private Storage bucket "handover-evidence".
--   handover_events        append-only audit trail of the above.
--
-- borrow_requests is not changed: an accepted request stays accepted while
-- the item is out. Authorization status:
--
--   active -> redeemed   the lender confirmed the handover with this code
--   active -> revoked    the borrower withdrew it (or the item was collected in person)
--   active -> expired    expires_at passed. Stored lazily; every read derives
--                        it from expires_at, so an unstored expiry never lets
--                        a code through.
--
-- All changes go through the SECURITY DEFINER functions below. Each takes the
-- caller from auth.uid() (never from an argument), locks the request row and
-- checks role, request status, code and expiry in one transaction, so two
-- simultaneous confirmations cannot both succeed.
--
-- Errors (mapped by the API):
--   NSH01 request not found, or the caller is not one of its participants
--   42501 the caller is a participant but may not do this
--   NSH03 the request is not accepted
--   NSH04 the item has already been handed over
--   NSH05 an active authorization already exists for this request
--   NSH06 the authorization is not active (nothing to revoke)
--   NSH07 the code does not belong to this request (or does not exist)
--   NSH08 the authorization was revoked
--   NSH09 the authorization was already used
--   NSH10 the authorization expired
--   NSH11 photo limit reached
--   NSH12 photos can no longer be added
--   22023 invalid argument

create type public.pickup_authorization_status as enum ('active', 'redeemed', 'revoked', 'expired');
create type public.handover_method as enum ('personal', 'authorized');
create type public.handover_event_kind as enum (
  'authorization_created', 'authorization_revoked', 'authorization_redeemed', 'handover_confirmed'
);

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.pickup_authorizations (
  id                uuid primary key default gen_random_uuid(),
  borrow_request_id uuid not null references public.borrow_requests (id) on delete cascade,
  -- The borrower who created it (always the request's borrower).
  borrower_id       uuid not null references public.profiles (id) on delete cascade,
  -- Only pickup in this phase; the column keeps returns possible later.
  operation         text not null default 'pickup' check (operation = 'pickup'),
  recipient_name    text not null check (char_length(recipient_name) between 2 and 80),
  recipient_phone   text check (recipient_phone is null or recipient_phone ~ '^\+?[0-9]{7,15}$'),
  note              text check (note is null or char_length(note) between 1 and 200),
  -- Hex SHA-256 of the code. Unique, so a code identifies one authorization.
  token_hash        text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  status            public.pickup_authorization_status not null default 'active',
  expires_at        timestamptz not null,
  created_at        timestamptz not null default now(),
  revoked_at        timestamptz,
  redeemed_at       timestamptz,
  redeemed_by       uuid references public.profiles (id),
  constraint pickup_authorizations_revoked_at_matches check ((status = 'revoked') = (revoked_at is not null)),
  constraint pickup_authorizations_redeemed_matches
    check ((status = 'redeemed') = (redeemed_at is not null and redeemed_by is not null)),
  constraint pickup_authorizations_expires_after_creation check (expires_at > created_at)
);

comment on table public.pickup_authorizations is
  'One-time permission for a named person to collect a borrowed item. Stores a hash of the code only.';

-- At most one usable authorization per request; a replacement needs a revoke first.
create unique index pickup_authorizations_one_active
  on public.pickup_authorizations (borrow_request_id) where status = 'active';
create index pickup_authorizations_request_idx on public.pickup_authorizations (borrow_request_id, created_at desc);

create table public.handovers (
  id                uuid primary key default gen_random_uuid(),
  -- Exactly once per request.
  borrow_request_id uuid not null unique references public.borrow_requests (id) on delete cascade,
  method            public.handover_method not null,
  authorization_id  uuid unique references public.pickup_authorizations (id),
  -- Copied from the authorization at the moment it was used.
  recipient_name    text,
  recipient_phone   text,
  -- The lender, from auth.uid().
  confirmed_by      uuid not null references public.profiles (id),
  condition_notes   text check (condition_notes is null or char_length(condition_notes) between 1 and 1000),
  confirmed_at      timestamptz not null default now(),
  constraint handovers_authorization_matches_method check ((method = 'authorized') = (authorization_id is not null)),
  constraint handovers_recipient_matches_method check ((method = 'authorized') = (recipient_name is not null))
);

comment on table public.handovers is 'The lender''s confirmation that a borrowed item was handed over. One per request.';

create table public.handover_photos (
  id                uuid primary key default gen_random_uuid(),
  handover_id       uuid not null references public.handovers (id) on delete cascade,
  borrow_request_id uuid not null references public.borrow_requests (id) on delete cascade,
  uploaded_by       uuid not null references public.profiles (id),
  -- <borrow_request_id>/<handover_id>/<uuid>.<ext> in "handover-evidence".
  storage_path      text not null unique,
  content_type      text not null check (content_type in ('image/jpeg', 'image/png', 'image/webp')),
  created_at        timestamptz not null default now(),
  constraint handover_photos_path_matches
    check (split_part(storage_path, '/', 1) = borrow_request_id::text and split_part(storage_path, '/', 2) = handover_id::text)
);

create index handover_photos_handover_idx on public.handover_photos (handover_id, created_at);

create table public.handover_events (
  id                bigint generated always as identity primary key,
  borrow_request_id uuid not null references public.borrow_requests (id) on delete cascade,
  authorization_id  uuid references public.pickup_authorizations (id) on delete cascade,
  actor_id          uuid not null references public.profiles (id) on delete cascade,
  kind              public.handover_event_kind not null,
  created_at        timestamptz not null default now()
);

create index handover_events_request_idx on public.handover_events (borrow_request_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Functions
-- ---------------------------------------------------------------------------

-- Effective status: an active authorization past its expiry is expired,
-- whether or not that has been stored yet.
create function public.pickup_authorization_status_of(a public.pickup_authorizations)
returns public.pickup_authorization_status
language sql
stable
set search_path = ''
as $$
  select case when a.status = 'active' and a.expires_at <= pg_catalog.now()
              then 'expired'::public.pickup_authorization_status else a.status end;
$$;

-- Never includes the hash.
create function public.pickup_authorization_json(a public.pickup_authorizations)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'id', a.id,
    'borrow_request_id', a.borrow_request_id,
    'operation', a.operation,
    'status', public.pickup_authorization_status_of(a),
    'recipient_name', a.recipient_name,
    'recipient_phone', a.recipient_phone,
    'note', a.note,
    'expires_at', a.expires_at,
    'created_at', a.created_at,
    'revoked_at', a.revoked_at,
    'redeemed_at', a.redeemed_at
  );
$$;

-- The request, locked, after checking that the caller takes part in it.
-- p_role: the side the caller must be on ('borrower' | 'lender').
create function public.handover_request_for(p_request_id uuid, p_role text)
returns public.borrow_requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := auth.uid();
  r public.borrow_requests;
begin
  select * into r from public.borrow_requests where id = p_request_id for update;
  if not found or me is null or (r.borrower_id <> me and r.lender_id <> me) then
    raise exception 'request_not_found' using errcode = 'NSH01';
  end if;
  if (p_role = 'borrower' and r.borrower_id <> me) or (p_role = 'lender' and r.lender_id <> me) then
    raise exception 'only the % may do this', p_role using errcode = '42501';
  end if;
  if not exists (select 1 from public.profiles p where p.id = me and p.account_status in ('active', 'restricted')) then
    raise exception 'account may not do this' using errcode = '42501';
  end if;
  if r.status <> 'accepted' then
    raise exception 'request_not_accepted' using errcode = 'NSH03';
  end if;
  if exists (select 1 from public.handovers h where h.borrow_request_id = r.id) then
    raise exception 'already_handed_over' using errcode = 'NSH04';
  end if;
  return r;
end;
$$;

-- The authorization a code belongs to, for this request, if it is usable.
create function public.usable_pickup_authorization(p_request_id uuid, p_token_hash text, p_lock boolean)
returns public.pickup_authorizations
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.pickup_authorizations;
begin
  if p_lock then
    select * into a from public.pickup_authorizations
     where token_hash = p_token_hash and borrow_request_id = p_request_id for update;
  else
    select * into a from public.pickup_authorizations
     where token_hash = p_token_hash and borrow_request_id = p_request_id;
  end if;
  -- A code for another request is indistinguishable from a wrong code.
  if not found then
    raise exception 'invalid_code' using errcode = 'NSH07';
  end if;
  case public.pickup_authorization_status_of(a)
    when 'revoked' then raise exception 'authorization_revoked' using errcode = 'NSH08';
    when 'redeemed' then raise exception 'authorization_used' using errcode = 'NSH09';
    when 'expired' then raise exception 'authorization_expired' using errcode = 'NSH10';
    else return a;
  end case;
end;
$$;

-- Borrower: authorize someone to collect the item. The API generates the code
-- and passes only its hash; p_ttl_hours comes from server configuration.
create function public.create_pickup_authorization(
  p_request_id      uuid,
  p_token_hash      text,
  p_recipient_name  text,
  p_recipient_phone text,
  p_note            text,
  p_ttl_hours       integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.borrow_requests;
  a public.pickup_authorizations;
begin
  if p_ttl_hours is null or p_ttl_hours < 1 or p_ttl_hours > 168 then
    raise exception 'ttl must be 1-168 hours' using errcode = '22023';
  end if;
  r := public.handover_request_for(p_request_id, 'borrower');

  -- Record expiries first, so a lapsed code does not block a new one.
  update public.pickup_authorizations
     set status = 'expired'
   where borrow_request_id = r.id and status = 'active' and expires_at <= pg_catalog.now();
  if exists (select 1 from public.pickup_authorizations where borrow_request_id = r.id and status = 'active') then
    raise exception 'active_authorization_exists' using errcode = 'NSH05';
  end if;

  insert into public.pickup_authorizations
    (borrow_request_id, borrower_id, recipient_name, recipient_phone, note, token_hash, expires_at)
  values (
    r.id,
    r.borrower_id,
    pg_catalog.btrim(p_recipient_name),
    nullif(pg_catalog.btrim(coalesce(p_recipient_phone, '')), ''),
    nullif(pg_catalog.btrim(coalesce(p_note, '')), ''),
    p_token_hash,
    pg_catalog.now() + pg_catalog.make_interval(hours => p_ttl_hours)
  )
  returning * into a;

  insert into public.handover_events (borrow_request_id, authorization_id, actor_id, kind)
  values (r.id, a.id, r.borrower_id, 'authorization_created');
  return public.pickup_authorization_json(a);
end;
$$;

-- Borrower: withdraw an unused authorization.
create function public.revoke_pickup_authorization(p_request_id uuid, p_authorization_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := auth.uid();
  r public.borrow_requests;
  a public.pickup_authorizations;
begin
  select * into r from public.borrow_requests where id = p_request_id for update;
  if not found or me is null or (r.borrower_id <> me and r.lender_id <> me) then
    raise exception 'request_not_found' using errcode = 'NSH01';
  end if;
  if r.borrower_id <> me then
    raise exception 'only the borrower revokes' using errcode = '42501';
  end if;
  select * into a from public.pickup_authorizations
   where id = p_authorization_id and borrow_request_id = r.id for update;
  if not found then
    raise exception 'authorization_not_found' using errcode = 'NSH01';
  end if;
  if public.pickup_authorization_status_of(a) <> 'active' then
    raise exception 'authorization_not_active' using errcode = 'NSH06';
  end if;

  update public.pickup_authorizations
     set status = 'revoked', revoked_at = pg_catalog.now()
   where id = a.id
  returning * into a;
  insert into public.handover_events (borrow_request_id, authorization_id, actor_id, kind)
  values (r.id, a.id, me, 'authorization_revoked');
  return public.pickup_authorization_json(a);
end;
$$;

-- Lender: check a scanned or typed code before confirming. Changes nothing.
create function public.verify_pickup_code(p_request_id uuid, p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.borrow_requests;
begin
  r := public.handover_request_for(p_request_id, 'lender');
  return public.pickup_authorization_json(public.usable_pickup_authorization(r.id, p_token_hash, false));
end;
$$;

-- Lender: confirm the handover, once. p_method 'personal' (the borrower in
-- person) or 'authorized' (with the code the authorized person showed).
create function public.confirm_handover(
  p_request_id      uuid,
  p_method          text,
  p_token_hash      text,
  p_condition_notes text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := auth.uid();
  r public.borrow_requests;
  a public.pickup_authorizations;
  h public.handovers;
  notes text := nullif(pg_catalog.btrim(coalesce(p_condition_notes, '')), '');
begin
  r := public.handover_request_for(p_request_id, 'lender');

  if p_method = 'authorized' then
    if p_token_hash is null then
      raise exception 'code required' using errcode = '22023';
    end if;
    a := public.usable_pickup_authorization(r.id, p_token_hash, true);
    update public.pickup_authorizations
       set status = 'redeemed', redeemed_at = pg_catalog.now(), redeemed_by = me
     where id = a.id;
    insert into public.handovers (borrow_request_id, method, authorization_id, recipient_name, recipient_phone, confirmed_by, condition_notes)
    values (r.id, 'authorized', a.id, a.recipient_name, a.recipient_phone, me, notes)
    returning * into h;
    insert into public.handover_events (borrow_request_id, authorization_id, actor_id, kind)
    values (r.id, a.id, me, 'authorization_redeemed');
  elsif p_method = 'personal' then
    if p_token_hash is not null then
      raise exception 'no code for a personal pickup' using errcode = '22023';
    end if;
    -- Collected in person: an unused authorization can no longer be used.
    update public.pickup_authorizations
       set status = 'expired'
     where borrow_request_id = r.id and status = 'active' and expires_at <= pg_catalog.now();
    with revoked as (
      update public.pickup_authorizations
         set status = 'revoked', revoked_at = pg_catalog.now()
       where borrow_request_id = r.id and status = 'active'
      returning id
    )
    insert into public.handover_events (borrow_request_id, authorization_id, actor_id, kind)
    select r.id, revoked.id, me, 'authorization_revoked' from revoked;
    insert into public.handovers (borrow_request_id, method, confirmed_by, condition_notes)
    values (r.id, 'personal', me, notes)
    returning * into h;
  else
    raise exception 'method must be personal or authorized' using errcode = '22023';
  end if;

  insert into public.handover_events (borrow_request_id, authorization_id, actor_id, kind)
  values (r.id, h.authorization_id, me, 'handover_confirmed');
  return h.id;
end;
$$;

-- Everything about a request's handover, for its two participants. Null for
-- anyone else. Authorizations newest first, never with their hash.
create function public.get_handover_state(p_request_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with me as (select auth.uid() as id),
  r as (
    select br.* from public.borrow_requests br, me
     where br.id = p_request_id and me.id is not null and (br.borrower_id = me.id or br.lender_id = me.id)
  )
  select pg_catalog.jsonb_build_object(
    'borrow_request_id', r.id,
    'request_status', r.status,
    'handover', (
      select pg_catalog.jsonb_build_object(
        'id', h.id,
        'method', h.method,
        'authorization_id', h.authorization_id,
        'recipient_name', h.recipient_name,
        'recipient_phone', h.recipient_phone,
        'condition_notes', h.condition_notes,
        'confirmed_at', h.confirmed_at,
        'confirmed_by', pg_catalog.jsonb_build_object('id', h.confirmed_by, 'display_name', p.display_name),
        'photos', coalesce((
          select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                   'id', ph.id, 'storage_path', ph.storage_path, 'content_type', ph.content_type, 'created_at', ph.created_at
                 ) order by ph.created_at, ph.id)
            from public.handover_photos ph where ph.handover_id = h.id
        ), '[]'::jsonb)
      )
        from public.handovers h
        left join public.profiles p on p.id = h.confirmed_by
       where h.borrow_request_id = r.id
    ),
    'authorizations', coalesce((
      select pg_catalog.jsonb_agg(public.pickup_authorization_json(a) order by a.created_at desc, a.id)
        from public.pickup_authorizations a where a.borrow_request_id = r.id
    ), '[]'::jsonb)
  )
    from r;
$$;

-- Handover events of the caller's requests, newest first, for Activity.
create function public.list_handover_events(p_limit integer default 50)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with me as (select auth.uid() as id)
  select coalesce(pg_catalog.jsonb_agg(e.item order by e.created_at desc, e.id desc), '[]'::jsonb)
    from (
      select ev.id, ev.created_at,
             pg_catalog.jsonb_build_object(
               'id', ev.id,
               'kind', ev.kind,
               'created_at', ev.created_at,
               'actor', pg_catalog.jsonb_build_object('id', ev.actor_id, 'display_name', ap.display_name),
               'recipient_name', a.recipient_name,
               'method', h.method,
               'request', pg_catalog.jsonb_build_object(
                 'id', r.id, 'status', r.status, 'start_date', r.start_date, 'end_date', r.end_date,
                 'viewer_role', case when r.borrower_id = me.id then 'borrower' else 'lender' end
               ),
               'listing', pg_catalog.jsonb_build_object(
                 'id', l.id, 'title', l.title,
                 'cover_path', (select i.storage_path from public.listing_images i
                                 where i.listing_id = l.id order by i.created_at limit 1)
               )
             ) as item
        from public.handover_events ev
        cross join me
        join public.borrow_requests r on r.id = ev.borrow_request_id
        join public.listings l on l.id = r.listing_id
        left join public.profiles ap on ap.id = ev.actor_id
        left join public.pickup_authorizations a on a.id = ev.authorization_id
        left join public.handovers h on h.borrow_request_id = r.id and ev.kind = 'handover_confirmed'
       where me.id is not null and (r.borrower_id = me.id or r.lender_id = me.id)
       order by ev.created_at desc, ev.id desc
       limit least(greatest(p_limit, 1), 100)
    ) e;
$$;

-- Photo rows: filled and checked by the database, not the client. Only the
-- lender who confirmed, within 24 hours, at most 5. SECURITY DEFINER to lock
-- the handover row, so two uploads cannot both take the fifth place.
create function public.handover_photos_before_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  h public.handovers;
begin
  select * into h from public.handovers where id = new.handover_id for update;
  if not found or h.borrow_request_id <> new.borrow_request_id then
    raise exception 'request_not_found' using errcode = 'NSH01';
  end if;
  if h.confirmed_by <> auth.uid() then
    raise exception 'only the lender who confirmed adds photos' using errcode = '42501';
  end if;
  if h.confirmed_at <= pg_catalog.now() - interval '24 hours' then
    raise exception 'evidence_window_closed' using errcode = 'NSH12';
  end if;
  if (select pg_catalog.count(*) from public.handover_photos p where p.handover_id = h.id) >= 5 then
    raise exception 'photo_limit' using errcode = 'NSH11';
  end if;
  new.uploaded_by := h.confirmed_by;
  new.created_at := pg_catalog.now();
  return new;
end;
$$;

create trigger handover_photos_before_insert
  before insert on public.handover_photos
  for each row execute function public.handover_photos_before_insert();

-- Storage access for evidence files, by path <request>/<handover>/<file>.
-- Read: either participant of the request. Write: the confirming lender,
-- while photos may still be added.
create function public.can_read_handover_object(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.borrow_requests r
     where r.id::text = split_part(p_name, '/', 1)
       and (r.borrower_id = auth.uid() or r.lender_id = auth.uid())
  );
$$;

create function public.can_write_handover_object(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.handovers h
     where h.borrow_request_id::text = split_part(p_name, '/', 1)
       and h.id::text = split_part(p_name, '/', 2)
       and h.confirmed_by = auth.uid()
       and h.confirmed_at > pg_catalog.now() - interval '24 hours'
  );
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

-- Authorizations, handovers and events are read and written only through the
-- functions above. Photos are inserted directly (checked by the trigger and RLS).
revoke all on table public.pickup_authorizations, public.handovers, public.handover_events, public.handover_photos
  from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.pickup_authorizations, public.handovers, public.handover_events,
  public.handover_photos to service_role;
grant select on table public.handover_photos to authenticated;
grant insert (handover_id, borrow_request_id, storage_path, content_type) on table public.handover_photos to authenticated;

revoke execute on function
  public.pickup_authorization_status_of(public.pickup_authorizations),
  public.pickup_authorization_json(public.pickup_authorizations),
  public.handover_request_for(uuid, text),
  public.usable_pickup_authorization(uuid, text, boolean),
  public.create_pickup_authorization(uuid, text, text, text, text, integer),
  public.revoke_pickup_authorization(uuid, uuid),
  public.verify_pickup_code(uuid, text),
  public.confirm_handover(uuid, text, text, text),
  public.get_handover_state(uuid),
  public.list_handover_events(integer),
  public.handover_photos_before_insert(),
  public.can_read_handover_object(text),
  public.can_write_handover_object(text)
  from public, anon, authenticated;

grant execute on function
  public.create_pickup_authorization(uuid, text, text, text, text, integer),
  public.revoke_pickup_authorization(uuid, uuid),
  public.verify_pickup_code(uuid, text),
  public.confirm_handover(uuid, text, text, text),
  public.get_handover_state(uuid),
  public.list_handover_events(integer),
  -- Called by the Storage policies, which run as the caller.
  public.can_read_handover_object(text),
  public.can_write_handover_object(text)
  to authenticated;

-- ---------------------------------------------------------------------------
-- Row-Level Security
-- ---------------------------------------------------------------------------

alter table public.pickup_authorizations enable row level security;
alter table public.handovers enable row level security;
alter table public.handover_events enable row level security;
alter table public.handover_photos enable row level security;
-- No policies on the first three: no API role reads or writes them directly.

create policy "handover_photos: participants can read"
  on public.handover_photos for select
  to authenticated
  using (public.can_read_handover_object(storage_path));

create policy "handover_photos: confirming lender can add"
  on public.handover_photos for insert
  to authenticated
  with check (public.can_write_handover_object(storage_path));

-- ---------------------------------------------------------------------------
-- Storage: private bucket, files under <borrow_request_id>/<handover_id>/
-- ---------------------------------------------------------------------------

-- Never public: files are served only through short-lived signed URLs, which
-- Storage issues only to the two participants (policy below).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('handover-evidence', 'handover-evidence', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

create policy "handover-evidence: confirming lender can upload"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'handover-evidence' and public.can_write_handover_object(name));

create policy "handover-evidence: participants can read"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'handover-evidence' and public.can_read_handover_object(name));

-- Only to clean up a file whose photo row could not be saved.
create policy "handover-evidence: confirming lender can remove unsaved upload"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'handover-evidence'
    and public.can_write_handover_object(name)
    and not exists (select 1 from public.handover_photos p where p.storage_path = objects.name)
  );
