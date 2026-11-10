-- NeighborShare returns and due-date extensions (Phase 3B.2)
--
-- After the lender hands an item over (20261108120000_pickup_handover.sql),
-- the borrower brings it back:
--
--   borrower initiates the return (in person, by delivery/courier, or by
--   authorizing someone else with a one-time code) -> lender verifies ->
--   LENDER confirms receipt -> returned.
--
-- Initiating or authorizing never completes a return; only the lender's
-- confirmation does. Borrowers can also ask for more time; only an approved
-- extension moves the due date.
--
--   item_returns         the return, one per request. Created when the
--                        borrower initiates it; completed (confirmed_at) by
--                        the lender. Its existence before confirmation means
--                        "awaiting the lender".
--   pickup_authorizations  now also holds RETURN authorizations
--                        (operation = 'return'), with the same hashed
--                        one-time codes. A code only ever works for its own
--                        operation: pickup lookups match 'pickup' only and
--                        return lookups 'return' only.
--   return_photos        condition photos the confirming lender took, in the
--                        private bucket "return-evidence".
--   due_date_extensions  requests for a later due date, with the decision.
--   return_events        append-only audit trail of all of the above.
--
-- The due date is borrow_requests.end_date (inclusive, Pakistan time). An
-- approved extension moves it, so the booking calendar and the existing
-- no-overlap constraint cover the extra days and nobody else can book them.
-- That is the one change to existing borrow_requests behaviour: its update
-- trigger now allows end_date to move later, only while decide_extension()
-- is running. Clients still cannot write end_date (no column grant).
--
-- Overdue: picked up, not returned, and today (Pakistan) is after end_date.
-- Computed on every read; nothing is marked, charged or sent.
--
-- Errors (mapped by the API). NSH01, 42501, NSH03 and NSH07-NSH12 keep the
-- meanings of the pickup migration (not found, forbidden, not accepted,
-- invalid/revoked/used/expired code, photo limit/window).
--   NSR01 the item has not been picked up yet
--   NSR02 the return has not been initiated
--   NSR03 the item has already been returned
--   NSR04 the authorization is not active (nothing to revoke)
--   NSE01 extension not found
--   NSE02 an extension request is already pending
--   NSE03 the requested date is not allowed
--   NSE04 the extension has already been decided
--   NSE05 the extra days are booked by someone else
--   22023 invalid argument

create type public.return_method as enum ('personal', 'authorized', 'delivery');
create type public.extension_status as enum ('pending', 'approved', 'rejected');

-- ---------------------------------------------------------------------------
-- Authorizations: pickup and return in one table, never interchangeable
-- ---------------------------------------------------------------------------

alter table public.pickup_authorizations drop constraint pickup_authorizations_operation_check;
alter table public.pickup_authorizations
  add constraint pickup_authorizations_operation_check check (operation in ('pickup', 'return'));

-- One usable authorization per request AND operation.
drop index public.pickup_authorizations_one_active;
create unique index pickup_authorizations_one_active
  on public.pickup_authorizations (borrow_request_id, operation) where status = 'active';

comment on table public.pickup_authorizations is
  'One-time permission for a named person to collect (operation pickup) or return (operation return) a borrowed item. Stores a hash of the code only.';

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.item_returns (
  id                 uuid primary key default gen_random_uuid(),
  -- At most one return, and so one completed return, per request.
  borrow_request_id  uuid not null unique references public.borrow_requests (id) on delete cascade,
  handover_id        uuid not null unique references public.handovers (id) on delete cascade,
  -- As initiated, then as it actually happened once confirmed.
  method             public.return_method not null,
  -- Optional, for delivery/courier. Informational only: no live tracking.
  delivery_provider  text check (delivery_provider is null or char_length(delivery_provider) between 1 and 80),
  delivery_reference text check (delivery_reference is null or char_length(delivery_reference) between 1 and 80),
  delivery_note      text check (delivery_note is null or char_length(delivery_note) between 1 and 300),
  initiated_by       uuid not null references public.profiles (id),
  initiated_at       timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  -- Filled by the lender's confirmation.
  authorization_id   uuid unique references public.pickup_authorizations (id),
  recipient_name     text,
  recipient_phone    text,
  confirmed_by       uuid references public.profiles (id),
  confirmed_at       timestamptz,
  condition_notes    text check (condition_notes is null or char_length(condition_notes) between 1 and 1000),
  constraint item_returns_confirmed_matches check ((confirmed_at is null) = (confirmed_by is null)),
  -- A code is recorded only when an authorized return was confirmed with it.
  constraint item_returns_authorization_matches
    check ((authorization_id is not null) = (method = 'authorized' and confirmed_at is not null)),
  constraint item_returns_notes_after_confirmation check (condition_notes is null or confirmed_at is not null)
);

comment on table public.item_returns is
  'The return of a borrowed item. Awaiting the lender until confirmed_at is set; only the lender sets it.';

create table public.return_photos (
  id                uuid primary key default gen_random_uuid(),
  return_id         uuid not null references public.item_returns (id) on delete cascade,
  borrow_request_id uuid not null references public.borrow_requests (id) on delete cascade,
  uploaded_by       uuid not null references public.profiles (id),
  -- <borrow_request_id>/<return_id>/<uuid>.<ext> in "return-evidence".
  storage_path      text not null unique,
  content_type      text not null check (content_type in ('image/jpeg', 'image/png', 'image/webp')),
  created_at        timestamptz not null default now(),
  constraint return_photos_path_matches
    check (split_part(storage_path, '/', 1) = borrow_request_id::text and split_part(storage_path, '/', 2) = return_id::text)
);

create index return_photos_return_idx on public.return_photos (return_id, created_at);

create table public.due_date_extensions (
  id                      uuid primary key default gen_random_uuid(),
  borrow_request_id       uuid not null references public.borrow_requests (id) on delete cascade,
  requested_by            uuid not null references public.profiles (id),
  -- The due date when asked, and the one asked for (inclusive dates).
  previous_end_date       date not null,
  requested_end_date      date not null,
  reason                  text check (reason is null or char_length(reason) between 1 and 300),
  status                  public.extension_status not null default 'pending',
  -- Kept so that an approval never hides that the item was already late.
  requested_while_overdue boolean not null default false,
  overdue_at_decision     boolean,
  decided_by              uuid references public.profiles (id),
  decided_at              timestamptz,
  created_at              timestamptz not null default now(),
  constraint due_date_extensions_later check (requested_end_date > previous_end_date),
  constraint due_date_extensions_decided_matches
    check ((status = 'pending') = (decided_at is null) and (decided_at is null) = (decided_by is null)
           and (decided_at is null) = (overdue_at_decision is null))
);

create unique index due_date_extensions_one_pending
  on public.due_date_extensions (borrow_request_id) where status = 'pending';
create index due_date_extensions_request_idx on public.due_date_extensions (borrow_request_id, created_at desc);

create table public.return_events (
  id                bigint generated always as identity primary key,
  borrow_request_id uuid not null references public.borrow_requests (id) on delete cascade,
  authorization_id  uuid references public.pickup_authorizations (id) on delete cascade,
  extension_id      uuid references public.due_date_extensions (id) on delete cascade,
  actor_id          uuid not null references public.profiles (id) on delete cascade,
  kind              text not null check (kind in (
                      'return_initiated', 'return_authorization_created', 'return_authorization_revoked',
                      'return_authorization_redeemed', 'return_confirmed',
                      'extension_requested', 'extension_approved', 'extension_rejected')),
  created_at        timestamptz not null default now()
);

create index return_events_request_idx on public.return_events (borrow_request_id, created_at desc);

-- ---------------------------------------------------------------------------
-- borrow_requests: let an approved extension move the due date
-- ---------------------------------------------------------------------------

-- As in 20261102120000_borrow_requests.sql, plus one allowance: while
-- decide_extension() runs (it sets neighborshare.due_date_extension for its
-- own transaction), an accepted request's end_date may move LATER and
-- nothing else may change. Clients have no update grant on end_date, so
-- they cannot reach this path. The 30-day and no-overlap constraints still
-- apply to the new date.
create or replace function public.borrow_requests_before_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  extending boolean := coalesce(pg_catalog.current_setting('neighborshare.due_date_extension', true), '') = 'on';
begin
  if (new.listing_id, new.lender_id, new.borrower_id, new.start_date, new.message, new.created_at)
     is distinct from
     (old.listing_id, old.lender_id, old.borrower_id, old.start_date, old.message, old.created_at)
     or (new.end_date is distinct from old.end_date and not extending) then
    raise exception 'request details cannot change' using errcode = 'NSB05';
  end if;
  if new.end_date is distinct from old.end_date then
    if old.status <> 'accepted' or new.status <> old.status or new.end_date < old.end_date then
      raise exception 'due date can only move later on an accepted request' using errcode = 'NSB05';
    end if;
    new.decided_at := old.decided_at;
    new.cancelled_at := old.cancelled_at;
    return new;
  end if;
  if new.status = old.status then
    -- Nothing to do; keep the timestamps as they were.
    new.decided_at := old.decided_at;
    new.cancelled_at := old.cancelled_at;
    return new;
  end if;
  if old.status <> 'pending' then
    raise exception 'invalid_transition' using errcode = 'NSB05';
  end if;

  if new.status in ('accepted', 'declined') then
    if actor is not null and actor <> old.lender_id then
      raise exception 'only the lender decides' using errcode = '42501';
    end if;
    if new.status = 'accepted' then
      if actor is not null and not exists (
        select 1 from public.profiles p where p.id = actor and p.account_status = 'active'
      ) then
        raise exception 'lender account not active' using errcode = '42501';
      end if;
      if exists (select 1 from public.listings l where l.id = old.listing_id and l.archived_at is not null) then
        raise exception 'listing_not_borrowable' using errcode = 'NSB01';
      end if;
    end if;
    new.decided_at := pg_catalog.now();
    new.cancelled_at := null;
  elsif new.status = 'cancelled' then
    if actor is not null and actor <> old.borrower_id then
      raise exception 'only the borrower cancels' using errcode = '42501';
    end if;
    new.cancelled_at := pg_catalog.now();
    new.decided_at := null;
  else
    raise exception 'invalid_transition' using errcode = 'NSB05';
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Pickup functions: restricted to pickup authorizations
-- ---------------------------------------------------------------------------

-- The authorization a code belongs to, for this request AND operation, if it
-- is usable. A pickup code never matches a return lookup, and vice versa.
create function public.usable_authorization(p_request_id uuid, p_token_hash text, p_operation text, p_lock boolean)
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
     where token_hash = p_token_hash and borrow_request_id = p_request_id and operation = p_operation for update;
  else
    select * into a from public.pickup_authorizations
     where token_hash = p_token_hash and borrow_request_id = p_request_id and operation = p_operation;
  end if;
  -- A code for another request or operation is indistinguishable from a wrong code.
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

-- Pickup lookups: pickup codes only.
create or replace function public.usable_pickup_authorization(p_request_id uuid, p_token_hash text, p_lock boolean)
returns public.pickup_authorizations
language sql
security definer
set search_path = ''
as $$
  select public.usable_authorization(p_request_id, p_token_hash, 'pickup', p_lock);
$$;

-- As in the pickup migration, for pickup authorizations only.
create or replace function public.revoke_pickup_authorization(p_request_id uuid, p_authorization_id uuid)
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
   where id = p_authorization_id and borrow_request_id = r.id and operation = 'pickup' for update;
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

-- As in the pickup migration; lists pickup authorizations only.
create or replace function public.get_handover_state(p_request_id uuid)
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
        from public.pickup_authorizations a where a.borrow_request_id = r.id and a.operation = 'pickup'
    ), '[]'::jsonb)
  )
    from r;
$$;

-- ---------------------------------------------------------------------------
-- Return functions
-- ---------------------------------------------------------------------------

-- The request, locked, for a return action: the caller takes part on the
-- given side, is in good standing, the request is accepted, the item was
-- picked up and has not come back yet.
create function public.return_request_for(p_request_id uuid, p_role text)
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
  if not exists (select 1 from public.handovers h where h.borrow_request_id = r.id) then
    raise exception 'not_picked_up' using errcode = 'NSR01';
  end if;
  if exists (select 1 from public.item_returns x where x.borrow_request_id = r.id and x.confirmed_at is not null) then
    raise exception 'already_returned' using errcode = 'NSR03';
  end if;
  return r;
end;
$$;

-- Retires an unused return authorization (record expiry first, so an expired
-- code is not reported as revoked).
create function public.retire_return_authorizations(p_request_id uuid, p_actor uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.pickup_authorizations
     set status = 'expired'
   where borrow_request_id = p_request_id and operation = 'return' and status = 'active' and expires_at <= pg_catalog.now();
  with revoked as (
    update public.pickup_authorizations
       set status = 'revoked', revoked_at = pg_catalog.now()
     where borrow_request_id = p_request_id and operation = 'return' and status = 'active'
    returning id
  )
  insert into public.return_events (borrow_request_id, authorization_id, actor_id, kind)
  select p_request_id, revoked.id, p_actor, 'return_authorization_revoked' from revoked;
end;
$$;

-- Creates the return record, or updates how the borrower plans to return.
create function public.upsert_item_return(
  p_request public.borrow_requests,
  p_method public.return_method,
  p_delivery_provider text,
  p_delivery_reference text,
  p_delivery_note text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  is_delivery boolean := p_method = 'delivery';
  before_method public.return_method;
begin
  select method into before_method from public.item_returns where borrow_request_id = p_request.id;
  insert into public.item_returns
    (borrow_request_id, handover_id, method, delivery_provider, delivery_reference, delivery_note, initiated_by)
  select p_request.id, h.id, p_method,
         case when is_delivery then nullif(pg_catalog.btrim(coalesce(p_delivery_provider, '')), '') end,
         case when is_delivery then nullif(pg_catalog.btrim(coalesce(p_delivery_reference, '')), '') end,
         case when is_delivery then nullif(pg_catalog.btrim(coalesce(p_delivery_note, '')), '') end,
         p_request.borrower_id
    from public.handovers h where h.borrow_request_id = p_request.id
  on conflict (borrow_request_id) do update
     set method = excluded.method,
         delivery_provider = excluded.delivery_provider,
         delivery_reference = excluded.delivery_reference,
         delivery_note = excluded.delivery_note,
         updated_at = pg_catalog.now()
   where public.item_returns.confirmed_at is null;
  -- Audited when the return starts or its method changes.
  if before_method is distinct from p_method then
    insert into public.return_events (borrow_request_id, actor_id, kind)
    values (p_request.id, p_request.borrower_id, 'return_initiated');
  end if;
end;
$$;

-- Borrower: "I am returning it" in person or by delivery/courier. Choosing
-- this retires an unused authorized-person code.
create function public.initiate_return(
  p_request_id         uuid,
  p_method             text,
  p_delivery_provider  text,
  p_delivery_reference text,
  p_delivery_note      text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.borrow_requests;
begin
  if p_method is null or p_method not in ('personal', 'delivery') then
    raise exception 'method must be personal or delivery' using errcode = '22023';
  end if;
  r := public.return_request_for(p_request_id, 'borrower');
  perform public.retire_return_authorizations(r.id, r.borrower_id);
  perform public.upsert_item_return(r, p_method::public.return_method, p_delivery_provider, p_delivery_reference, p_delivery_note);
  return (select id from public.item_returns where borrow_request_id = r.id);
end;
$$;

-- Borrower: authorize someone else to return the item. Replaces (revokes) an
-- earlier unused return code in the same transaction.
create function public.create_return_authorization(
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
  r := public.return_request_for(p_request_id, 'borrower');
  perform public.retire_return_authorizations(r.id, r.borrower_id);
  perform public.upsert_item_return(r, 'authorized', null, null, null);

  insert into public.pickup_authorizations
    (borrow_request_id, borrower_id, operation, recipient_name, recipient_phone, note, token_hash, expires_at)
  values (
    r.id,
    r.borrower_id,
    'return',
    pg_catalog.btrim(p_recipient_name),
    nullif(pg_catalog.btrim(coalesce(p_recipient_phone, '')), ''),
    nullif(pg_catalog.btrim(coalesce(p_note, '')), ''),
    p_token_hash,
    pg_catalog.now() + pg_catalog.make_interval(hours => p_ttl_hours)
  )
  returning * into a;

  insert into public.return_events (borrow_request_id, authorization_id, actor_id, kind)
  values (r.id, a.id, r.borrower_id, 'return_authorization_created');
  return public.pickup_authorization_json(a);
end;
$$;

-- Borrower: withdraw an unused return code.
create function public.revoke_return_authorization(p_request_id uuid, p_authorization_id uuid)
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
   where id = p_authorization_id and borrow_request_id = r.id and operation = 'return' for update;
  if not found then
    raise exception 'authorization_not_found' using errcode = 'NSH01';
  end if;
  if public.pickup_authorization_status_of(a) <> 'active' then
    raise exception 'authorization_not_active' using errcode = 'NSR04';
  end if;
  update public.pickup_authorizations set status = 'revoked', revoked_at = pg_catalog.now() where id = a.id
  returning * into a;
  insert into public.return_events (borrow_request_id, authorization_id, actor_id, kind)
  values (r.id, a.id, me, 'return_authorization_revoked');
  return public.pickup_authorization_json(a);
end;
$$;

-- Lender: check a scanned or typed return code. Changes nothing.
create function public.verify_return_code(p_request_id uuid, p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.borrow_requests;
begin
  r := public.return_request_for(p_request_id, 'lender');
  return public.pickup_authorization_json(public.usable_authorization(r.id, p_token_hash, 'return', false));
end;
$$;

-- Lender: confirm the item is back, once. p_method is how it actually came
-- back: 'personal', 'delivery', or 'authorized' with the code the person
-- showed. The borrower must have initiated the return first.
create function public.confirm_return(
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
  x public.item_returns;
  notes text := nullif(pg_catalog.btrim(coalesce(p_condition_notes, '')), '');
begin
  if p_method is null or p_method not in ('personal', 'delivery', 'authorized') then
    raise exception 'method must be personal, delivery or authorized' using errcode = '22023';
  end if;
  if (p_method = 'authorized') <> (p_token_hash is not null) then
    raise exception 'a code is required for, and only for, an authorized return' using errcode = '22023';
  end if;
  r := public.return_request_for(p_request_id, 'lender');
  select * into x from public.item_returns where borrow_request_id = r.id for update;
  if not found then
    raise exception 'return_not_initiated' using errcode = 'NSR02';
  end if;

  if p_method = 'authorized' then
    a := public.usable_authorization(r.id, p_token_hash, 'return', true);
    update public.pickup_authorizations
       set status = 'redeemed', redeemed_at = pg_catalog.now(), redeemed_by = me
     where id = a.id;
    insert into public.return_events (borrow_request_id, authorization_id, actor_id, kind)
    values (r.id, a.id, me, 'return_authorization_redeemed');
  else
    -- Came back another way: an unused code can no longer be used.
    perform public.retire_return_authorizations(r.id, me);
  end if;

  update public.item_returns
     set method = p_method::public.return_method,
         authorization_id = a.id,
         recipient_name = a.recipient_name,
         recipient_phone = a.recipient_phone,
         confirmed_by = me,
         confirmed_at = pg_catalog.now(),
         condition_notes = notes,
         updated_at = pg_catalog.now()
   where id = x.id;
  insert into public.return_events (borrow_request_id, authorization_id, actor_id, kind)
  values (r.id, a.id, me, 'return_confirmed');
  return x.id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Due-date extensions
-- ---------------------------------------------------------------------------

-- Overdue: picked up, not returned, and today (Pakistan) is after the due date.
create function public.borrow_is_overdue(p_request_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.borrow_requests r
     where r.id = p_request_id and r.status = 'accepted'
       and public.borrow_today() > r.end_date
       and exists (select 1 from public.handovers h where h.borrow_request_id = r.id)
       and not exists (select 1 from public.item_returns x where x.borrow_request_id = r.id and x.confirmed_at is not null)
  );
$$;

-- Borrower: ask for a later due date. Same limits as a new request: at most
-- 30 days in total, not in the past, and not over another accepted booking.
create function public.request_extension(p_request_id uuid, p_requested_end_date date, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := auth.uid();
  r public.borrow_requests;
  e public.due_date_extensions;
begin
  select * into r from public.borrow_requests where id = p_request_id for update;
  if not found or me is null or (r.borrower_id <> me and r.lender_id <> me) then
    raise exception 'request_not_found' using errcode = 'NSH01';
  end if;
  if r.borrower_id <> me then
    raise exception 'only the borrower asks for more time' using errcode = '42501';
  end if;
  if not exists (select 1 from public.profiles p where p.id = me and p.account_status in ('active', 'restricted')) then
    raise exception 'account may not do this' using errcode = '42501';
  end if;
  if r.status <> 'accepted' then
    raise exception 'request_not_accepted' using errcode = 'NSH03';
  end if;
  if exists (select 1 from public.item_returns x where x.borrow_request_id = r.id and x.confirmed_at is not null) then
    raise exception 'already_returned' using errcode = 'NSR03';
  end if;
  if exists (select 1 from public.due_date_extensions d where d.borrow_request_id = r.id and d.status = 'pending') then
    raise exception 'extension_pending' using errcode = 'NSE02';
  end if;
  if p_requested_end_date is null or p_requested_end_date <= r.end_date
     or p_requested_end_date < public.borrow_today()
     or p_requested_end_date - r.start_date >= 30 then
    raise exception 'date_not_allowed' using errcode = 'NSE03';
  end if;
  if exists (
    select 1 from public.borrow_requests o
     where o.listing_id = r.listing_id and o.id <> r.id and o.status = 'accepted'
       and o.period && pg_catalog.daterange(r.end_date + 1, p_requested_end_date, '[]')
  ) then
    raise exception 'dates_unavailable' using errcode = 'NSE05';
  end if;

  insert into public.due_date_extensions
    (borrow_request_id, requested_by, previous_end_date, requested_end_date, reason, requested_while_overdue)
  values (r.id, me, r.end_date, p_requested_end_date, nullif(pg_catalog.btrim(coalesce(p_reason, '')), ''),
          public.borrow_is_overdue(r.id))
  returning * into e;
  insert into public.return_events (borrow_request_id, extension_id, actor_id, kind)
  values (r.id, e.id, me, 'extension_requested');
  return pg_catalog.to_jsonb(e);
end;
$$;

-- Lender: approve or reject. Only an approval moves the due date, and only
-- if the extra days are still free.
create function public.decide_extension(p_request_id uuid, p_extension_id uuid, p_decision text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := auth.uid();
  r public.borrow_requests;
  e public.due_date_extensions;
  late boolean;
begin
  if p_decision is null or p_decision not in ('approved', 'rejected') then
    raise exception 'decision must be approved or rejected' using errcode = '22023';
  end if;
  select * into r from public.borrow_requests where id = p_request_id for update;
  if not found or me is null or (r.borrower_id <> me and r.lender_id <> me) then
    raise exception 'request_not_found' using errcode = 'NSH01';
  end if;
  if r.lender_id <> me then
    raise exception 'only the lender decides' using errcode = '42501';
  end if;
  if not exists (select 1 from public.profiles p where p.id = me and p.account_status in ('active', 'restricted')) then
    raise exception 'account may not do this' using errcode = '42501';
  end if;
  select * into e from public.due_date_extensions where id = p_extension_id and borrow_request_id = r.id for update;
  if not found then
    raise exception 'extension_not_found' using errcode = 'NSE01';
  end if;
  if e.status <> 'pending' then
    raise exception 'extension_decided' using errcode = 'NSE04';
  end if;
  late := public.borrow_is_overdue(r.id);

  if p_decision = 'approved' then
    if r.status <> 'accepted' then
      raise exception 'request_not_accepted' using errcode = 'NSH03';
    end if;
    if exists (select 1 from public.item_returns x where x.borrow_request_id = r.id and x.confirmed_at is not null) then
      raise exception 'already_returned' using errcode = 'NSR03';
    end if;
    if e.requested_end_date <= r.end_date then
      raise exception 'date_not_allowed' using errcode = 'NSE03';
    end if;
    perform pg_catalog.set_config('neighborshare.due_date_extension', 'on', true);
    begin
      update public.borrow_requests set end_date = e.requested_end_date where id = r.id;
    exception
      when exclusion_violation then
        raise exception 'dates_unavailable' using errcode = 'NSE05';
      when check_violation then
        raise exception 'date_not_allowed' using errcode = 'NSE03';
    end;
    perform pg_catalog.set_config('neighborshare.due_date_extension', 'off', true);
  end if;

  update public.due_date_extensions
     set status = p_decision::public.extension_status, decided_by = me, decided_at = pg_catalog.now(),
         overdue_at_decision = late
   where id = e.id
  returning * into e;
  insert into public.return_events (borrow_request_id, extension_id, actor_id, kind)
  values (r.id, e.id, me, case when p_decision = 'approved' then 'extension_approved' else 'extension_rejected' end);
  return pg_catalog.to_jsonb(e);
end;
$$;

-- ---------------------------------------------------------------------------
-- Reads
-- ---------------------------------------------------------------------------

-- Due date, overdue state, the return, its codes (never their hashes) and
-- extension history, for the request's two participants. Null otherwise.
create function public.get_return_state(p_request_id uuid)
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
    'start_date', r.start_date,
    'due_date', r.end_date,
    -- The due date before any approved extension.
    'original_due_date', coalesce((
      select d.previous_end_date from public.due_date_extensions d
       where d.borrow_request_id = r.id and d.status = 'approved' order by d.decided_at, d.id limit 1
    ), r.end_date),
    'today', public.borrow_today(),
    'picked_up', exists (select 1 from public.handovers h where h.borrow_request_id = r.id),
    'overdue', public.borrow_is_overdue(r.id),
    'return', (
      select pg_catalog.jsonb_build_object(
        'id', x.id,
        'method', x.method,
        'delivery_provider', x.delivery_provider,
        'delivery_reference', x.delivery_reference,
        'delivery_note', x.delivery_note,
        'initiated_at', x.initiated_at,
        'updated_at', x.updated_at,
        'authorization_id', x.authorization_id,
        'recipient_name', x.recipient_name,
        'recipient_phone', x.recipient_phone,
        'confirmed_at', x.confirmed_at,
        'confirmed_by', case when x.confirmed_by is null then null
                             else pg_catalog.jsonb_build_object('id', x.confirmed_by, 'display_name', p.display_name) end,
        'condition_notes', x.condition_notes,
        'photos', coalesce((
          select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                   'id', ph.id, 'storage_path', ph.storage_path, 'content_type', ph.content_type, 'created_at', ph.created_at
                 ) order by ph.created_at, ph.id)
            from public.return_photos ph where ph.return_id = x.id
        ), '[]'::jsonb)
      )
        from public.item_returns x
        left join public.profiles p on p.id = x.confirmed_by
       where x.borrow_request_id = r.id
    ),
    'authorizations', coalesce((
      select pg_catalog.jsonb_agg(public.pickup_authorization_json(a) order by a.created_at desc, a.id)
        from public.pickup_authorizations a where a.borrow_request_id = r.id and a.operation = 'return'
    ), '[]'::jsonb),
    'extensions', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
               'id', d.id, 'status', d.status, 'previous_end_date', d.previous_end_date,
               'requested_end_date', d.requested_end_date, 'reason', d.reason,
               'requested_while_overdue', d.requested_while_overdue, 'overdue_at_decision', d.overdue_at_decision,
               'created_at', d.created_at, 'decided_at', d.decided_at
             ) order by d.created_at desc, d.id)
        from public.due_date_extensions d where d.borrow_request_id = r.id
    ), '[]'::jsonb)
  )
    from r;
$$;

-- Return and extension events of the caller's requests, newest first.
create function public.list_return_events(p_limit integer default 50)
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
               'method', case when ev.kind in ('return_initiated', 'return_confirmed') then x.method end,
               'requested_end_date', d.requested_end_date,
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
        from public.return_events ev
        cross join me
        join public.borrow_requests r on r.id = ev.borrow_request_id
        join public.listings l on l.id = r.listing_id
        left join public.profiles ap on ap.id = ev.actor_id
        left join public.pickup_authorizations a on a.id = ev.authorization_id
        left join public.item_returns x on x.borrow_request_id = r.id
        left join public.due_date_extensions d on d.id = ev.extension_id
       where me.id is not null and (r.borrower_id = me.id or r.lender_id = me.id)
       order by ev.created_at desc, ev.id desc
       limit least(greatest(p_limit, 1), 100)
    ) e;
$$;

-- ---------------------------------------------------------------------------
-- Return evidence
-- ---------------------------------------------------------------------------

-- Only the lender who confirmed, within 24 hours, at most 5. Locks the
-- return row so two uploads cannot both take the fifth place.
create function public.return_photos_before_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  x public.item_returns;
begin
  select * into x from public.item_returns where id = new.return_id for update;
  if not found or x.borrow_request_id <> new.borrow_request_id then
    raise exception 'request_not_found' using errcode = 'NSH01';
  end if;
  if x.confirmed_at is null then
    raise exception 'return_not_confirmed' using errcode = 'NSR02';
  end if;
  if x.confirmed_by <> auth.uid() then
    raise exception 'only the lender who confirmed adds photos' using errcode = '42501';
  end if;
  if x.confirmed_at <= pg_catalog.now() - interval '24 hours' then
    raise exception 'evidence_window_closed' using errcode = 'NSH12';
  end if;
  if (select pg_catalog.count(*) from public.return_photos p where p.return_id = x.id) >= 5 then
    raise exception 'photo_limit' using errcode = 'NSH11';
  end if;
  new.uploaded_by := x.confirmed_by;
  new.created_at := pg_catalog.now();
  return new;
end;
$$;

create trigger return_photos_before_insert
  before insert on public.return_photos
  for each row execute function public.return_photos_before_insert();

-- Storage access by path <request>/<return>/<file>.
create function public.can_read_return_object(p_name text)
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

create function public.can_write_return_object(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.item_returns x
     where x.borrow_request_id::text = split_part(p_name, '/', 1)
       and x.id::text = split_part(p_name, '/', 2)
       and x.confirmed_by = auth.uid()
       and x.confirmed_at > pg_catalog.now() - interval '24 hours'
  );
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

revoke all on table public.item_returns, public.return_photos, public.due_date_extensions, public.return_events
  from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.item_returns, public.return_photos, public.due_date_extensions,
  public.return_events to service_role;
grant select on table public.return_photos to authenticated;
grant insert (return_id, borrow_request_id, storage_path, content_type) on table public.return_photos to authenticated;

revoke execute on function
  public.usable_authorization(uuid, text, text, boolean),
  public.return_request_for(uuid, text),
  public.retire_return_authorizations(uuid, uuid),
  public.upsert_item_return(public.borrow_requests, public.return_method, text, text, text),
  public.initiate_return(uuid, text, text, text, text),
  public.create_return_authorization(uuid, text, text, text, text, integer),
  public.revoke_return_authorization(uuid, uuid),
  public.verify_return_code(uuid, text),
  public.confirm_return(uuid, text, text, text),
  public.borrow_is_overdue(uuid),
  public.request_extension(uuid, date, text),
  public.decide_extension(uuid, uuid, text),
  public.get_return_state(uuid),
  public.list_return_events(integer),
  public.return_photos_before_insert(),
  public.can_read_return_object(text),
  public.can_write_return_object(text)
  from public, anon, authenticated;

grant execute on function
  public.initiate_return(uuid, text, text, text, text),
  public.create_return_authorization(uuid, text, text, text, text, integer),
  public.revoke_return_authorization(uuid, uuid),
  public.verify_return_code(uuid, text),
  public.confirm_return(uuid, text, text, text),
  public.request_extension(uuid, date, text),
  public.decide_extension(uuid, uuid, text),
  public.get_return_state(uuid),
  public.list_return_events(integer),
  -- Called by the Storage policies, which run as the caller.
  public.can_read_return_object(text),
  public.can_write_return_object(text)
  to authenticated;

-- ---------------------------------------------------------------------------
-- Row-Level Security
-- ---------------------------------------------------------------------------

alter table public.item_returns enable row level security;
alter table public.return_photos enable row level security;
alter table public.due_date_extensions enable row level security;
alter table public.return_events enable row level security;
-- No policies on item_returns, due_date_extensions or return_events: no API
-- role reads or writes them directly.

create policy "return_photos: participants can read"
  on public.return_photos for select
  to authenticated
  using (public.can_read_return_object(storage_path));

create policy "return_photos: confirming lender can add"
  on public.return_photos for insert
  to authenticated
  with check (public.can_write_return_object(storage_path));

-- ---------------------------------------------------------------------------
-- Storage: private bucket, files under <borrow_request_id>/<return_id>/
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('return-evidence', 'return-evidence', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

create policy "return-evidence: confirming lender can upload"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'return-evidence' and public.can_write_return_object(name));

create policy "return-evidence: participants can read"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'return-evidence' and public.can_read_return_object(name));

create policy "return-evidence: confirming lender can remove unsaved upload"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'return-evidence'
    and public.can_write_return_object(name)
    and not exists (select 1 from public.return_photos p where p.storage_path = objects.name)
  );
