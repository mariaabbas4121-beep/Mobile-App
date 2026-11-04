-- NeighborShare: browse other people's listings only (Phase 3A.1)
--
-- Adds one optional parameter to search_listings:
--   p_exclude_owner_id  leave out this owner's listings. The API sets it to
--                       the signed-in caller's id (from the access token,
--                       never from the request) for "owner=others", so the
--                       Browse feed and map never show the caller's own items.
-- Called without it the function behaves exactly as before. No table,
-- column, policy or data changes: only the function is replaced.

drop function public.search_listings(text, public.listing_category, public.listing_condition, public.listing_availability,
                         uuid, uuid, boolean, text, integer, integer,
                         double precision, double precision, double precision, text);

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
  p_city             text default null,
  p_exclude_owner_id uuid default null
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
       -- Browsing: everyone else's listings, never the caller's own.
       and (p_exclude_owner_id is null or l.owner_id <> p_exclude_owner_id)
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

revoke execute on function
  public.search_listings(text, public.listing_category, public.listing_condition, public.listing_availability,
                         uuid, uuid, boolean, text, integer, integer,
                         double precision, double precision, double precision, text, uuid)
  from public, anon, authenticated;
grant execute on function
  public.search_listings(text, public.listing_category, public.listing_condition, public.listing_availability,
                         uuid, uuid, boolean, text, integer, integer,
                         double precision, double precision, double precision, text, uuid)
  to anon, authenticated;
