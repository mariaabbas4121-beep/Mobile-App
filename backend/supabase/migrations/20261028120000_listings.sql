-- NeighborShare listings (Phase 2A)
--
--   listings        items a user offers to lend
--   listing_images  metadata for listing photos; the files live in the
--                   private Storage bucket "listing-images"
--
-- Access model (the backend calls the database with the caller's own token,
-- so every rule below is enforced by Row-Level Security, not only by the API):
--   anon, authenticated  read listings that are not archived and whose owner
--                        is in good standing, and their image rows
--   authenticated        also reads all of its own listings (archived too);
--                        creates listings for itself while its account is
--                        active; edits or archives its own, unarchived
--                        listings; adds and removes photos of its own listings
--   service_role         full access for future server-side maintenance
--
-- Listings are archived, never deleted by users, so later borrow history can
-- keep pointing at them. Archiving is one-way.
--
-- Reservation logic (dates, double booking) is Phase 2B and not modelled here;
-- `availability` is a simple flag the owner controls.

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------

create type public.listing_category as enum (
  'tools', 'electronics', 'home', 'outdoor', 'kitchen', 'sports', 'books', 'other'
);

create type public.listing_condition as enum ('excellent', 'good', 'fair');

create type public.listing_availability as enum ('available', 'unavailable');

-- ---------------------------------------------------------------------------
-- listings
-- ---------------------------------------------------------------------------

create table public.listings (
  id                    uuid primary key default gen_random_uuid(),
  owner_id              uuid not null references public.profiles (id) on delete cascade,
  title                 text not null check (char_length(title) between 3 and 80),
  description           text not null check (char_length(description) between 10 and 2000),
  category              public.listing_category not null,
  condition             public.listing_condition not null,
  -- Indicative replacement value in whole Pakistani rupees. Informational
  -- only: no deposit or payment is taken.
  replacement_value_pkr integer check (replacement_value_pkr is null or replacement_value_pkr between 0 and 10000000),
  borrowing_terms       text check (borrowing_terms is null or char_length(borrowing_terms) between 1 and 1000),
  -- Approximate area chosen by the owner (e.g. "UAF Hostel 3"). Never an
  -- address or coordinates.
  area                  text check (area is null or char_length(area) between 2 and 80),
  availability          public.listing_availability not null default 'available',
  teach_me_enabled      boolean not null default false,
  tags                  text[] not null default '{}'
                        check (cardinality(tags) <= 5 and array_position(tags, null) is null),
  archived_at           timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  -- Target of listing_images' composite foreign key, which ties each image to
  -- the listing's owner.
  constraint listings_id_owner_unique unique (id, owner_id)
);

comment on table public.listings is 'Items offered for lending. Archived (never deleted) by owners.';

-- Discovery: newest unarchived listings, optionally by category.
create index listings_active_created_idx on public.listings (created_at desc) where archived_at is null;
create index listings_active_category_idx on public.listings (category, created_at desc) where archived_at is null;
-- "My listings".
create index listings_owner_idx on public.listings (owner_id, created_at desc);

-- ---------------------------------------------------------------------------
-- listing_images
-- ---------------------------------------------------------------------------

create table public.listing_images (
  id           uuid primary key default gen_random_uuid(),
  listing_id   uuid not null,
  owner_id     uuid not null,
  -- Object name in the "listing-images" bucket: <owner_id>/<listing_id>/<uuid>.<ext>
  storage_path text not null unique
               check (storage_path ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|png|webp)$'),
  content_type text not null check (content_type in ('image/jpeg', 'image/png', 'image/webp')),
  size_bytes   integer not null check (size_bytes between 1 and 5242880),
  created_at   timestamptz not null default now(),
  constraint listing_images_listing_owner_fk
    foreign key (listing_id, owner_id) references public.listings (id, owner_id) on delete cascade,
  -- The path must sit in the owner's and the listing's folder, which is what
  -- the Storage policies check.
  constraint listing_images_path_matches_listing
    check (split_part(storage_path, '/', 1) = owner_id::text and split_part(storage_path, '/', 2) = listing_id::text)
);

comment on table public.listing_images is 'Photo metadata for listings. Files are in Storage bucket listing-images.';

create index listing_images_listing_idx on public.listing_images (listing_id, created_at);

-- ---------------------------------------------------------------------------
-- Functions
-- ---------------------------------------------------------------------------

-- Whether an owner's listings may appear in public discovery. SECURITY
-- DEFINER because callers cannot read other users' profiles; it reveals one
-- boolean and nothing else.
create function public.listing_owner_is_listable(owner uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles p
     where p.id = owner and p.account_status in ('active', 'restricted')
  );
$$;

-- Display name shown on a listing. Only for the caller or users who
-- currently have a listing on show, so it cannot be used to look up
-- arbitrary accounts.
create function public.listing_owner_name(owner uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select p.display_name
    from public.profiles p
   where p.id = owner
     and (owner = (select auth.uid())
          or exists (select 1 from public.listings l where l.owner_id = owner and l.archived_at is null));
$$;

-- Archiving is one-way and stamped by the server clock; ownership and
-- creation time never change.
create function public.listings_guard_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.owner_id is distinct from old.owner_id or new.created_at is distinct from old.created_at then
    raise exception 'owner_id and created_at cannot change' using errcode = 'check_violation';
  end if;
  if old.archived_at is not null then
    raise exception 'listing is archived' using errcode = 'check_violation';
  end if;
  if new.archived_at is not null then
    new.archived_at := pg_catalog.now();
  end if;
  return new;
end;
$$;

-- At most 5 photos per listing. The advisory lock serialises concurrent
-- uploads to the same listing so two cannot both pass the count.
create function public.listing_images_enforce_limit()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(new.listing_id::text, 0));
  if (select pg_catalog.count(*) from public.listing_images where listing_id = new.listing_id) >= 5 then
    raise exception 'listing_image_limit' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

-- Discovery query used by GET /items and GET /items/:id. SECURITY INVOKER:
-- it sees exactly the rows the caller's RLS policies allow. Returns
-- {"total": n, "items": [...]} so the total is known even past the last page.
create function public.search_listings(
  p_query            text default null,
  p_category         public.listing_category default null,
  p_condition        public.listing_condition default null,
  p_availability     public.listing_availability default null,
  p_owner_id         uuid default null,
  p_id               uuid default null,
  p_include_archived boolean default false,
  p_sort             text default 'newest',
  p_limit            integer default 20,
  p_offset           integer default 0
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with terms as (
    -- Every word of the query must appear somewhere in the listing.
    select pg_catalog.array_remove(
             pg_catalog.regexp_split_to_array(pg_catalog.lower(pg_catalog.btrim(coalesce(p_query, ''))), '\s+'),
             ''
           ) as words
  ),
  matches as (
    select l.*
      from public.listings l, terms t
     where (p_id is null or l.id = p_id)
       and (p_category is null or l.category = p_category)
       and (p_condition is null or l.condition = p_condition)
       and (p_availability is null or l.availability = p_availability)
       and (p_owner_id is null or l.owner_id = p_owner_id)
       -- Archived listings only for their owner, and only when asked for.
       and (l.archived_at is null or (p_include_archived and l.owner_id = (select auth.uid())))
       and not exists (
         select 1 from pg_catalog.unnest(t.words) w
          where pg_catalog.strpos(
                  pg_catalog.lower(l.title || ' ' || l.description || ' ' || pg_catalog.array_to_string(l.tags, ' ')),
                  w
                ) = 0
       )
  ),
  page as (
    select m.*,
           pg_catalog.row_number() over (
             order by
               case when p_sort = 'title' then pg_catalog.lower(m.title) end asc,
               case when p_sort = 'oldest' then m.created_at end asc,
               case when p_sort not in ('title', 'oldest') then m.created_at end desc,
               m.id
           ) as ord
      from matches m
     order by ord
     limit least(greatest(p_limit, 1), 50)
    offset greatest(p_offset, 0)
  )
  select pg_catalog.jsonb_build_object(
    'total', (select pg_catalog.count(*) from matches),
    'items', coalesce(
      (select pg_catalog.jsonb_agg(
                pg_catalog.jsonb_build_object(
                  'id', p.id,
                  'owner_id', p.owner_id,
                  'owner_display_name', public.listing_owner_name(p.owner_id),
                  'title', p.title,
                  'description', p.description,
                  'category', p.category,
                  'condition', p.condition,
                  'replacement_value_pkr', p.replacement_value_pkr,
                  'borrowing_terms', p.borrowing_terms,
                  'area', p.area,
                  'availability', p.availability,
                  'teach_me_enabled', p.teach_me_enabled,
                  'tags', p.tags,
                  'archived_at', p.archived_at,
                  'created_at', p.created_at,
                  'updated_at', p.updated_at
                ) order by p.ord)
         from page p),
      '[]'::jsonb
    )
  );
$$;

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

create trigger listings_set_updated_at
  before update on public.listings
  for each row execute function public.set_updated_at();

create trigger listings_guard_update
  before update on public.listings
  for each row execute function public.listings_guard_update();

create trigger listing_images_enforce_limit
  before insert on public.listing_images
  for each row execute function public.listing_images_enforce_limit();

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

revoke all on table public.listings, public.listing_images from public, anon, authenticated, service_role;

grant select on table public.listings to anon, authenticated;
grant insert (owner_id, title, description, category, condition, replacement_value_pkr, borrowing_terms, area,
              availability, teach_me_enabled, tags)
  on table public.listings to authenticated;
grant update (title, description, category, condition, replacement_value_pkr, borrowing_terms, area,
              availability, teach_me_enabled, tags, archived_at)
  on table public.listings to authenticated;

grant select on table public.listing_images to anon, authenticated;
grant insert (listing_id, owner_id, storage_path, content_type, size_bytes) on table public.listing_images to authenticated;
grant delete on table public.listing_images to authenticated;

grant select, insert, update, delete on table public.listings, public.listing_images to service_role;

revoke execute on function
  public.listing_owner_is_listable(uuid),
  public.listing_owner_name(uuid),
  public.listings_guard_update(),
  public.listing_images_enforce_limit(),
  public.search_listings(text, public.listing_category, public.listing_condition, public.listing_availability,
                         uuid, uuid, boolean, text, integer, integer)
  from public, anon, authenticated;

-- Needed by the RLS policies and search_listings, which run as the caller.
grant execute on function
  public.listing_owner_is_listable(uuid),
  public.listing_owner_name(uuid),
  public.search_listings(text, public.listing_category, public.listing_condition, public.listing_availability,
                         uuid, uuid, boolean, text, integer, integer)
  to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Row-Level Security
-- ---------------------------------------------------------------------------

alter table public.listings enable row level security;
alter table public.listing_images enable row level security;

create policy "listings: anyone can read listings on show"
  on public.listings for select
  to anon, authenticated
  using (archived_at is null and public.listing_owner_is_listable(owner_id));

create policy "listings: owner can read own"
  on public.listings for select
  to authenticated
  using (owner_id = (select auth.uid()));

-- Only active accounts publish. The caller can read its own profile row, so
-- this subquery needs no elevated rights.
create policy "listings: active owner can create"
  on public.listings for insert
  to authenticated
  with check (
    owner_id = (select auth.uid())
    and exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.account_status = 'active')
  );

-- Restricted accounts may still archive or mark items unavailable; the API
-- limits them to that. Suspended and deletion-pending accounts change nothing.
create policy "listings: owner in good standing can update unarchived"
  on public.listings for update
  to authenticated
  using (
    owner_id = (select auth.uid())
    and archived_at is null
    and exists (select 1 from public.profiles p
                 where p.id = (select auth.uid()) and p.account_status in ('active', 'restricted'))
  )
  with check (owner_id = (select auth.uid()));

-- Visible exactly when the listing is (the subquery runs under listings' RLS).
create policy "listing_images: readable with their listing"
  on public.listing_images for select
  to anon, authenticated
  using (exists (select 1 from public.listings l where l.id = listing_id));

create policy "listing_images: active owner can add to own unarchived listing"
  on public.listing_images for insert
  to authenticated
  with check (
    owner_id = (select auth.uid())
    and exists (select 1 from public.listings l
                 where l.id = listing_id and l.owner_id = (select auth.uid()) and l.archived_at is null)
    and exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.account_status = 'active')
  );

create policy "listing_images: owner can remove"
  on public.listing_images for delete
  to authenticated
  using (owner_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- Storage: private bucket, files under <owner_id>/<listing_id>/
-- ---------------------------------------------------------------------------

-- Private: files are served only through short-lived signed URLs, which
-- Storage issues only to callers the select policy below allows. The size and
-- type limits are enforced by Storage itself as well as by the API.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('listing-images', 'listing-images', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

create policy "listing-images: owner can upload to own unarchived listing"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'listing-images'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and exists (
      select 1 from public.listings l
       where l.id::text = (storage.foldername(objects.name))[2]
         and l.owner_id = (select auth.uid())
         and l.archived_at is null
    )
  );

-- Images of listings the caller may see, plus anything in the caller's own
-- folder (needed to remove a file whose row is already gone).
create policy "listing-images: read images of visible listings"
  on storage.objects for select
  to anon, authenticated
  using (
    bucket_id = 'listing-images'
    and (
      exists (select 1 from public.listing_images i where i.storage_path = objects.name)
      or (storage.foldername(name))[1] = (select auth.uid())::text
    )
  );

create policy "listing-images: owner can delete own files"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'listing-images' and (storage.foldername(name))[1] = (select auth.uid())::text);
