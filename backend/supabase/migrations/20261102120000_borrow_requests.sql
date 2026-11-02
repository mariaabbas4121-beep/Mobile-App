-- NeighborShare borrow requests (Phase 2B)
--
-- A borrower asks to borrow a listing for a range of calendar dates; the
-- listing's owner (the lender) accepts or declines; the borrower may cancel
-- while the request is pending.
--
--   pending  -> accepted   lender only; the dates become reserved
--   pending  -> declined   lender only (also automatic when the listing is archived)
--   pending  -> cancelled  borrower only
--   accepted, declined, cancelled are final in this phase.
--
-- Dates are calendar dates in Pakistan time and INCLUSIVE at both ends:
-- 2026-11-05..2026-11-07 is three days. Two accepted requests for the same
-- listing conflict when they share any day, so a borrow ending on the 7th and
-- one starting on the 7th conflict; one starting on the 8th does not.
--
-- Double booking is prevented by an exclusion constraint on accepted rows,
-- which PostgreSQL enforces atomically: if two accepts race, one waits for
-- the other and then fails with exclusion_violation (23P01).
--
-- Access: only the two participants can see a request. All writes run with
-- the caller's own token; the triggers below decide who may make which change.
--
-- Errors raised by this migration use these SQLSTATEs (mapped by the API):
--   NSB01 listing not borrowable (missing, archived, unavailable, owner not in good standing)
--   NSB02 borrowing one's own listing
--   NSB03 dates outside the allowed window
--   NSB04 dates overlap an accepted request
--   NSB05 status transition not allowed
--   42501 caller may not make this change
--   23P01 accept would overlap another accepted request
--   23505 a pending request by this borrower for this listing already exists

create extension if not exists btree_gist with schema extensions;

create type public.borrow_request_status as enum ('pending', 'accepted', 'declined', 'cancelled');

-- ---------------------------------------------------------------------------
-- borrow_requests
-- ---------------------------------------------------------------------------

create table public.borrow_requests (
  id           uuid primary key default gen_random_uuid(),
  listing_id   uuid not null,
  -- Always the listing's owner: set by trigger, checked by the foreign key.
  lender_id    uuid not null,
  borrower_id  uuid not null references public.profiles (id) on delete cascade,
  start_date   date not null,
  end_date     date not null,
  -- Inclusive range of the requested days, for overlap checks. greatest()
  -- keeps a reversed range from erroring here, so the dates_ordered check
  -- below reports it instead.
  period       daterange generated always as (daterange(start_date, greatest(start_date, end_date), '[]')) stored,
  message      text check (message is null or char_length(message) between 1 and 500),
  status       public.borrow_request_status not null default 'pending',
  decided_at   timestamptz,
  cancelled_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint borrow_requests_listing_lender_fk
    foreign key (listing_id, lender_id) references public.listings (id, owner_id) on delete cascade,
  constraint borrow_requests_dates_ordered check (end_date >= start_date),
  constraint borrow_requests_at_most_30_days check (end_date - start_date < 30),
  constraint borrow_requests_not_own_listing check (borrower_id <> lender_id),
  constraint borrow_requests_decided_at_matches
    check ((status in ('accepted', 'declined')) = (decided_at is not null)),
  constraint borrow_requests_cancelled_at_matches
    check ((status = 'cancelled') = (cancelled_at is not null)),
  -- The reservation guarantee.
  constraint borrow_requests_no_overlapping_accepted
    exclude using gist (listing_id with =, period with &&) where (status = 'accepted')
);

comment on table public.borrow_requests is
  'Requests to borrow a listing for inclusive calendar dates. Accepted rows never overlap per listing.';

create index borrow_requests_borrower_idx on public.borrow_requests (borrower_id, created_at desc);
create index borrow_requests_lender_idx on public.borrow_requests (lender_id, created_at desc);
create index borrow_requests_listing_idx on public.borrow_requests (listing_id, status);
-- One open request per borrower per listing; a double tap cannot create two.
create unique index borrow_requests_one_pending_per_borrower
  on public.borrow_requests (listing_id, borrower_id)
  where status = 'pending';

-- ---------------------------------------------------------------------------
-- Functions
-- ---------------------------------------------------------------------------

-- Today in Pakistan, the pilot's only time zone.
create function public.borrow_today()
returns date
language sql
stable
set search_path = ''
as $$
  select (pg_catalog.now() at time zone 'Asia/Karachi')::date;
$$;

-- New requests: the server fills the lender and status; the listing must be
-- borrowable; dates must be in the allowed window and not already reserved.
-- SECURITY DEFINER to see the listing and other users' accepted requests;
-- it reveals nothing to the caller beyond the error code.
create function public.borrow_requests_before_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  l record;
  today date := public.borrow_today();
begin
  select id, owner_id, archived_at, availability into l
    from public.listings where id = new.listing_id;
  if not found or l.archived_at is not null or l.availability <> 'available'
     or not public.listing_owner_is_listable(l.owner_id) then
    raise exception 'listing_not_borrowable' using errcode = 'NSB01';
  end if;
  if l.owner_id = new.borrower_id then
    raise exception 'own_listing' using errcode = 'NSB02';
  end if;
  if new.end_date < new.start_date then
    raise exception 'end date before start date' using errcode = 'check_violation';
  end if;
  if new.start_date < today or new.start_date > today + 90 then
    raise exception 'dates_out_of_window' using errcode = 'NSB03';
  end if;
  if exists (
    select 1 from public.borrow_requests r
     where r.listing_id = new.listing_id and r.status = 'accepted'
       and r.period && pg_catalog.daterange(new.start_date, new.end_date, '[]')
  ) then
    raise exception 'dates_unavailable' using errcode = 'NSB04';
  end if;

  new.lender_id := l.owner_id;
  new.status := 'pending';
  new.decided_at := null;
  new.cancelled_at := null;
  new.created_at := pg_catalog.now();
  return new;
end;
$$;

-- Status changes: only from pending, only by the right participant, and
-- nothing else about a request ever changes. auth.uid() is null for the
-- service role (server maintenance), which may make any allowed transition.
create function public.borrow_requests_before_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
begin
  if (new.listing_id, new.lender_id, new.borrower_id, new.start_date, new.end_date, new.message, new.created_at)
     is distinct from
     (old.listing_id, old.lender_id, old.borrower_id, old.start_date, old.end_date, old.message, old.created_at) then
    raise exception 'request details cannot change' using errcode = 'NSB05';
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

-- Archiving a listing declines its open requests, so borrowers are not left
-- waiting. Accepted reservations are kept (handover is a later phase).
create function public.listings_decline_pending_on_archive()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.borrow_requests
     set status = 'declined'
   where listing_id = new.id and status = 'pending';
  return null;
end;
$$;

-- Reserved (accepted) date ranges of a listing from today on, for the
-- request form. Dates only: never who borrowed. Empty for listings the
-- caller cannot see.
create function public.listing_booked_ranges(p_listing_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object('start_date', r.start_date, 'end_date', r.end_date)
      order by r.start_date
    ),
    '[]'::jsonb
  )
    from public.borrow_requests r
    join public.listings l on l.id = r.listing_id
   where r.listing_id = p_listing_id
     and r.status = 'accepted'
     and r.end_date >= public.borrow_today()
     and ((l.archived_at is null and public.listing_owner_is_listable(l.owner_id))
          or l.owner_id = (select auth.uid()));
$$;

-- Requests the caller takes part in, with the listing title and both
-- participants' display names (which the caller could not read directly).
-- SECURITY DEFINER, so the participant filter below is the access rule.
--   p_role 'borrower' | 'lender' : the caller's side; null with p_id: either side
create function public.list_borrow_requests(
  p_role   text default null,
  p_status public.borrow_request_status default null,
  p_id     uuid default null,
  p_limit  integer default 20,
  p_offset integer default 0
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with me as (select auth.uid() as id),
  matches as (
    select r.*
      from public.borrow_requests r, me
     where me.id is not null
       and (r.borrower_id = me.id or r.lender_id = me.id)
       and (p_role is null or (p_role = 'borrower' and r.borrower_id = me.id)
                           or (p_role = 'lender' and r.lender_id = me.id))
       and (p_status is null or r.status = p_status)
       and (p_id is null or r.id = p_id)
  ),
  page as (
    select m.*, pg_catalog.row_number() over (order by m.created_at desc, m.id) as ord
      from matches m
     order by ord
     limit least(greatest(p_limit, 1), 50)
    offset greatest(p_offset, 0)
  )
  select pg_catalog.jsonb_build_object(
    'total', (select pg_catalog.count(*) from matches),
    'items', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'id', p.id,
          'status', p.status,
          'start_date', p.start_date,
          'end_date', p.end_date,
          'message', p.message,
          'decided_at', p.decided_at,
          'cancelled_at', p.cancelled_at,
          'created_at', p.created_at,
          'updated_at', p.updated_at,
          'listing', pg_catalog.jsonb_build_object(
            'id', l.id,
            'title', l.title,
            'archived', l.archived_at is not null,
            'cover_path', (select i.storage_path from public.listing_images i
                            where i.listing_id = l.id order by i.created_at limit 1)
          ),
          'borrower', pg_catalog.jsonb_build_object('id', p.borrower_id, 'display_name', bp.display_name),
          'lender', pg_catalog.jsonb_build_object('id', p.lender_id, 'display_name', lp.display_name)
        ) order by p.ord)
        from page p
        join public.listings l on l.id = p.listing_id
        left join public.profiles bp on bp.id = p.borrower_id
        left join public.profiles lp on lp.id = p.lender_id
    ), '[]'::jsonb)
  );
$$;

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

create trigger borrow_requests_before_insert
  before insert on public.borrow_requests
  for each row execute function public.borrow_requests_before_insert();

create trigger borrow_requests_before_update
  before update on public.borrow_requests
  for each row execute function public.borrow_requests_before_update();

create trigger borrow_requests_set_updated_at
  before update on public.borrow_requests
  for each row execute function public.set_updated_at();

create trigger listings_decline_pending_on_archive
  after update of archived_at on public.listings
  for each row when (old.archived_at is null and new.archived_at is not null)
  execute function public.listings_decline_pending_on_archive();

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

revoke all on table public.borrow_requests from public, anon, authenticated, service_role;

grant select on table public.borrow_requests to authenticated;
-- The lender, status and timestamps are never chosen by the client.
grant insert (listing_id, borrower_id, start_date, end_date, message) on table public.borrow_requests to authenticated;
grant update (status) on table public.borrow_requests to authenticated;
grant select, insert, update, delete on table public.borrow_requests to service_role;

revoke execute on function
  public.borrow_today(),
  public.borrow_requests_before_insert(),
  public.borrow_requests_before_update(),
  public.listings_decline_pending_on_archive(),
  public.listing_booked_ranges(uuid),
  public.list_borrow_requests(text, public.borrow_request_status, uuid, integer, integer)
  from public, anon, authenticated;

grant execute on function public.borrow_today() to anon, authenticated;
grant execute on function public.listing_booked_ranges(uuid) to anon, authenticated;
grant execute on function public.list_borrow_requests(text, public.borrow_request_status, uuid, integer, integer)
  to authenticated;

-- ---------------------------------------------------------------------------
-- Row-Level Security
-- ---------------------------------------------------------------------------

alter table public.borrow_requests enable row level security;

create policy "borrow_requests: participants can read"
  on public.borrow_requests for select
  to authenticated
  using (borrower_id = (select auth.uid()) or lender_id = (select auth.uid()));

create policy "borrow_requests: active borrower can create own"
  on public.borrow_requests for insert
  to authenticated
  with check (
    borrower_id = (select auth.uid())
    and exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.account_status = 'active')
  );

-- Which participant may set which status is decided by the update trigger.
create policy "borrow_requests: participants in good standing can update"
  on public.borrow_requests for update
  to authenticated
  using (
    (borrower_id = (select auth.uid()) or lender_id = (select auth.uid()))
    and exists (select 1 from public.profiles p
                 where p.id = (select auth.uid()) and p.account_status in ('active', 'restricted'))
  )
  with check (borrower_id = (select auth.uid()) or lender_id = (select auth.uid()));
