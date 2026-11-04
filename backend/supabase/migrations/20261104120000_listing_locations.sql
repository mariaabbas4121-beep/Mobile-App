-- NeighborShare listing locations and nearby discovery (Phase 3A)
--
-- Where an item can be collected, without revealing where its owner lives.
--
--   listing_locations         the precise pickup point a lender chose. Only
--                             the owner can read it; nobody can write it
--                             directly (see set_listing_location()).
--   location_privacy_offsets  one secret, random displacement per owner.
--                             Nobody but the database can read it.
--   listings.public_latitude  the point shown to everyone: the precise point
--   listings.public_longitude moved 200-400 m in the owner's secret direction,
--                             then rounded to 3 decimals (about 110 m).
--   listings.city             the city an item is in, for city-wide browsing
--                             and for listings without a pickup point.
--
-- Privacy design:
--   * Distances and radius filters are computed from the PUBLIC point. The
--     search accepts arbitrary coordinates and radii, so measuring from the
--     precise point would let anyone trilaterate it by probing. Measuring
--     from the public point reveals nothing beyond the point itself.
--   * The offset is per owner, not per listing, so averaging several
--     listings from the same home does not converge on it, and it never
--     changes, so moving the pin back and forth reveals nothing either.
--   * The offset is random and stored privately; it cannot be recomputed
--     from public data.
--
-- Distance is the great-circle (haversine) distance on a sphere of radius
-- 6371.0088 km, prefiltered by a latitude/longitude bounding box that a
-- plain B-tree index serves. No PostGIS is needed.
--
-- Errors (mapped by the API):
--   NSL01 listing not found, not yours, or archived
--   42501 account may not change listings
--   22023 coordinates out of range

-- ---------------------------------------------------------------------------
-- Columns on listings
-- ---------------------------------------------------------------------------

alter table public.listings
  add column city             text check (city is null or char_length(city) between 2 and 80),
  -- Written only by set_listing_location() / clear_listing_location().
  add column public_latitude  double precision,
  add column public_longitude double precision,
  add constraint listings_public_point_pair check ((public_latitude is null) = (public_longitude is null)),
  add constraint listings_public_point_range
    check (public_latitude is null or (public_latitude between -90 and 90 and public_longitude between -180 and 180));

comment on column public.listings.public_latitude is
  'Approximate public pickup point (offset 200-400 m, rounded). Never the precise location.';

-- Nearby search: bounding-box range scans on listings that are on show.
create index listings_public_point_idx on public.listings (public_latitude, public_longitude)
  where archived_at is null and public_latitude is not null;
-- City-wide browsing.
create index listings_city_idx on public.listings (pg_catalog.lower(city), created_at desc) where archived_at is null;

-- Existing listings take their owner's profile city. Their triggers are
-- paused so updated_at and the archive guard are not touched by this.
alter table public.listings disable trigger listings_set_updated_at;
alter table public.listings disable trigger listings_guard_update;
update public.listings l
   set city = pg_catalog.btrim(p.city)
  from public.profiles p
 where p.id = l.owner_id
   and l.city is null
   and p.city is not null
   and char_length(pg_catalog.btrim(p.city)) between 2 and 80;
alter table public.listings enable trigger listings_set_updated_at;
alter table public.listings enable trigger listings_guard_update;

-- ---------------------------------------------------------------------------
-- Private tables
-- ---------------------------------------------------------------------------

create table public.listing_locations (
  listing_id uuid primary key,
  owner_id   uuid not null,
  latitude   double precision not null check (latitude between -90 and 90),
  longitude  double precision not null check (longitude between -180 and 180),
  updated_at timestamptz not null default now(),
  constraint listing_locations_listing_owner_fk
    foreign key (listing_id, owner_id) references public.listings (id, owner_id) on delete cascade
);

comment on table public.listing_locations is
  'Precise pickup point of a listing. Readable by its owner only.';

create table public.location_privacy_offsets (
  owner_id   uuid primary key references public.profiles (id) on delete cascade,
  -- Direction (radians) and distance (metres) the public point is moved.
  bearing    double precision not null check (bearing >= 0 and bearing < 2 * pi()),
  distance_m double precision not null check (distance_m between 200 and 400)
);

comment on table public.location_privacy_offsets is
  'Secret per-owner displacement for public listing points. No API role can read it.';

-- ---------------------------------------------------------------------------
-- Functions
-- ---------------------------------------------------------------------------

-- Great-circle distance in kilometres.
create function public.distance_km(lat1 double precision, lng1 double precision, lat2 double precision, lng2 double precision)
returns double precision
language sql
immutable
strict
parallel safe
set search_path = ''
as $$
  select 2 * 6371.0088 * pg_catalog.asin(least(1.0, pg_catalog.sqrt(
           pg_catalog.power(pg_catalog.sin(pg_catalog.radians(lat2 - lat1) / 2), 2)
           + pg_catalog.cos(pg_catalog.radians(lat1)) * pg_catalog.cos(pg_catalog.radians(lat2))
             * pg_catalog.power(pg_catalog.sin(pg_catalog.radians(lng2 - lng1) / 2), 2)
         )));
$$;

-- The public point for a precise point and an offset: moved, then rounded
-- to 3 decimals, latitude clamped and longitude wrapped into range.
create function public.listing_public_point(
  p_latitude double precision, p_longitude double precision, p_bearing double precision, p_distance_m double precision,
  out latitude double precision, out longitude double precision
)
language sql
immutable
strict
set search_path = ''
as $$
  select pg_catalog.round(greatest(-90.0, least(90.0,
           p_latitude + p_distance_m * pg_catalog.cos(p_bearing) / 111320.0))::numeric, 3)::double precision,
         pg_catalog.round(((p_longitude
           + p_distance_m * pg_catalog.sin(p_bearing)
             / (111320.0 * greatest(0.01, pg_catalog.cos(pg_catalog.radians(p_latitude))))
           + 540.0)::numeric % 360.0) - 180.0, 3)::double precision;
$$;

-- Sets the pickup point of the caller's own, unarchived listing. Returns
-- the precise point (for the owner) and the public one.
create function public.set_listing_location(p_listing_id uuid, p_latitude double precision, p_longitude double precision)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := auth.uid();
  o public.location_privacy_offsets;
  pub record;
begin
  if p_latitude is null or p_longitude is null
     or p_latitude not between -90 and 90 or p_longitude not between -180 and 180
     or p_latitude = 'NaN'::double precision or p_longitude = 'NaN'::double precision then
    raise exception 'coordinates out of range' using errcode = '22023';
  end if;
  if me is null or not exists (
    select 1 from public.listings l where l.id = p_listing_id and l.owner_id = me and l.archived_at is null
  ) then
    raise exception 'listing_not_found' using errcode = 'NSL01';
  end if;
  if not exists (select 1 from public.profiles p where p.id = me and p.account_status = 'active') then
    raise exception 'account may not change listings' using errcode = '42501';
  end if;

  insert into public.location_privacy_offsets (owner_id, bearing, distance_m)
  values (me, pg_catalog.random() * 2 * pi() * 0.999999, 200 + pg_catalog.random() * 200)
  on conflict (owner_id) do nothing;
  select * into o from public.location_privacy_offsets where owner_id = me;
  select * into pub from public.listing_public_point(p_latitude, p_longitude, o.bearing, o.distance_m);

  insert into public.listing_locations (listing_id, owner_id, latitude, longitude, updated_at)
  values (p_listing_id, me, p_latitude, p_longitude, pg_catalog.now())
  on conflict (listing_id) do update
    set latitude = excluded.latitude, longitude = excluded.longitude, updated_at = excluded.updated_at;

  update public.listings
     set public_latitude = pub.latitude, public_longitude = pub.longitude
   where id = p_listing_id;

  return pg_catalog.jsonb_build_object(
    'latitude', p_latitude, 'longitude', p_longitude,
    'public_latitude', pub.latitude, 'public_longitude', pub.longitude,
    'updated_at', pg_catalog.now()
  );
end;
$$;

-- Removes the pickup point; the listing stays visible city-wide.
create function public.clear_listing_location(p_listing_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := auth.uid();
begin
  if me is null or not exists (
    select 1 from public.listings l where l.id = p_listing_id and l.owner_id = me and l.archived_at is null
  ) then
    raise exception 'listing_not_found' using errcode = 'NSL01';
  end if;
  if not exists (select 1 from public.profiles p where p.id = me and p.account_status in ('active', 'restricted')) then
    raise exception 'account may not change listings' using errcode = '42501';
  end if;
  delete from public.listing_locations where listing_id = p_listing_id;
  update public.listings set public_latitude = null, public_longitude = null where id = p_listing_id;
  return found;
end;
$$;

-- Discovery, replacing the Phase 2A version. New, optional parameters:
--   p_latitude, p_longitude, p_radius_km  nearby: only listings whose public
--       point lies within the radius (listings without one are excluded),
--       with distance_km; p_sort 'distance' orders nearest first
--   p_city  city-wide: listings whose city matches, case-insensitively
-- Called without them it behaves exactly as before.
drop function public.search_listings(text, public.listing_category, public.listing_condition,
                                     public.listing_availability, uuid, uuid, boolean, text, integer, integer);

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
  p_offset           integer default 0,
  p_latitude         double precision default null,
  p_longitude        double precision default null,
  p_radius_km        double precision default null,
  p_city             text default null
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
  origin as (
    -- Nearby only with a complete, in-range origin and a radius of 0.1..50 km.
    select p_latitude as lat, p_longitude as lng,
           least(greatest(p_radius_km, 0.1), 50.0) as radius,
           least(greatest(p_radius_km, 0.1), 50.0) / 111.32 as dlat,
           least(greatest(p_radius_km, 0.1), 50.0)
             / (111.32 * greatest(0.01, pg_catalog.cos(pg_catalog.radians(p_latitude)))) as dlng
     where p_latitude between -90 and 90 and p_longitude between -180 and 180 and p_radius_km is not null
  ),
  matches as (
    select l.*,
           case when o.lat is not null
                then public.distance_km(o.lat, o.lng, l.public_latitude, l.public_longitude) end as distance
      from public.listings l
      cross join terms t
      left join origin o on true
     where (p_id is null or l.id = p_id)
       and (p_category is null or l.category = p_category)
       and (p_condition is null or l.condition = p_condition)
       and (p_availability is null or l.availability = p_availability)
       and (p_owner_id is null or l.owner_id = p_owner_id)
       -- Archived listings only for their owner, and only when asked for.
       and (l.archived_at is null or (p_include_archived and l.owner_id = (select auth.uid())))
       and (p_city is null or pg_catalog.lower(l.city) = pg_catalog.lower(pg_catalog.btrim(p_city)))
       -- Nearby: given coordinates that are invalid match nothing, never everything.
       and (p_latitude is null and p_longitude is null
            or (o.lat is not null
                and l.public_latitude between o.lat - o.dlat and o.lat + o.dlat
                -- The longitude box is skipped where it would wrap around ±180.
                and (o.lng - o.dlng < -180 or o.lng + o.dlng > 180 or o.dlng >= 180
                     or l.public_longitude between o.lng - o.dlng and o.lng + o.dlng)
                and public.distance_km(o.lat, o.lng, l.public_latitude, l.public_longitude) <= o.radius))
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
               case when p_sort = 'distance' then m.distance end asc nulls last,
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
                  'city', p.city,
                  'public_latitude', p.public_latitude,
                  'public_longitude', p.public_longitude,
                  -- Rounded to 100 m for display.
                  'distance_km', pg_catalog.round(p.distance::numeric, 1),
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
-- Privileges
-- ---------------------------------------------------------------------------

-- City is an ordinary owner-editable field; the public point is not.
grant insert (city) on table public.listings to authenticated;
grant update (city) on table public.listings to authenticated;

revoke all on table public.listing_locations, public.location_privacy_offsets
  from public, anon, authenticated, service_role;
-- Owners read their own precise point (RLS below). All writes go through
-- the functions above.
grant select (listing_id, latitude, longitude, updated_at) on table public.listing_locations to authenticated;
grant select, insert, update, delete on table public.listing_locations to service_role;
-- The offsets are read by nobody but the database itself.
grant select, insert, update, delete on table public.location_privacy_offsets to service_role;

revoke execute on function
  public.distance_km(double precision, double precision, double precision, double precision),
  public.listing_public_point(double precision, double precision, double precision, double precision),
  public.set_listing_location(uuid, double precision, double precision),
  public.clear_listing_location(uuid),
  public.search_listings(text, public.listing_category, public.listing_condition, public.listing_availability,
                         uuid, uuid, boolean, text, integer, integer,
                         double precision, double precision, double precision, text)
  from public, anon, authenticated;

grant execute on function public.distance_km(double precision, double precision, double precision, double precision)
  to anon, authenticated;
grant execute on function
  public.search_listings(text, public.listing_category, public.listing_condition, public.listing_availability,
                         uuid, uuid, boolean, text, integer, integer,
                         double precision, double precision, double precision, text)
  to anon, authenticated;
grant execute on function
  public.set_listing_location(uuid, double precision, double precision),
  public.clear_listing_location(uuid)
  to authenticated;

-- ---------------------------------------------------------------------------
-- Row-Level Security
-- ---------------------------------------------------------------------------

alter table public.listing_locations enable row level security;
alter table public.location_privacy_offsets enable row level security;

create policy "listing_locations: owner can read own"
  on public.listing_locations for select
  to authenticated
  using (owner_id = (select auth.uid()));

-- location_privacy_offsets: RLS on and no policies, so no API role sees a row.
