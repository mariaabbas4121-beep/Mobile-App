// Database tests for 20261104120000_listing_locations.sql on PGlite: the
// precise pickup point stays private, the public point is displaced and
// stable, and nearby search filters by radius and sorts by distance.
import { beforeAll, describe, expect, test } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createAuthUser, createMigratedDb, sqlState } from './pglite.js';

let db: PGlite;

// The pilot area: University of Agriculture, Faisalabad.
const UAF = { lat: 31.431, lng: 73.07 };
const LAHORE = { lat: 31.5204, lng: 74.3587 };

// A point `north` and `east` kilometres from `from`.
const move = (from: { lat: number; lng: number }, north: number, east = 0) => ({
  lat: from.lat + north / 111.32,
  lng: from.lng + east / (111.32 * Math.cos((from.lat * Math.PI) / 180)),
});

const haversineKm = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
  const r = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lng - a.lng) / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(h)));
};

let legacyOwner: string;
let legacyListing: string;

beforeAll(async () => {
  db = await createMigratedDb({
    // A listing that exists before this migration, owned by someone with a city.
    '20261104120000_listing_locations.sql': async (d) => {
      legacyOwner = await createAuthUser(d);
      await d.query(`update public.profiles set display_name = 'Old', city = ' Faisalabad ' where id = $1`, [legacyOwner]);
      const { rows } = await d.query<{ id: string; updated_at: string }>(
        `insert into public.listings (owner_id, title, description, category, condition)
         values ($1, 'Old ladder', 'Listed before locations existed.', 'tools', 'good') returning id`,
        [legacyOwner],
      );
      legacyListing = rows[0]!.id;
    },
  });
});

async function readyUser(): Promise<string> {
  const id = await createAuthUser(db);
  await db.query(`update public.profiles set display_name = 'User' where id = $1`, [id]);
  return id;
}

async function seedListing(ownerId: string, opts: { title?: string; city?: string | null; category?: string } = {}): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into public.listings (owner_id, title, description, category, condition, city)
     values ($1, $2, 'A useful item to borrow.', $3::public.listing_category, 'good', $4) returning id`,
    [ownerId, opts.title ?? 'Item', opts.category ?? 'tools', opts.city === undefined ? 'Faisalabad' : opts.city],
  );
  return rows[0]!.id;
}

// One statement as `userId` (authenticated; null = anon), committed.
async function as<T = Record<string, unknown>>(userId: string | null, sql: string, params: unknown[] = []): Promise<T[]> {
  return db.transaction(async (tx) => {
    await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [userId ?? '']);
    await tx.exec(`set local role ${userId ? 'authenticated' : 'anon'}`);
    return (await tx.query<T>(sql, params)).rows;
  });
}

const setLocation = (userId: string | null, listingId: string, p: { lat: number; lng: number }) =>
  as<{ r: Record<string, number> }>(userId, `select public.set_listing_location($1, $2, $3) as r`, [listingId, p.lat, p.lng]).then(
    (rows) => rows[0]!.r,
  );

// A fixed offset (300 m due north) makes public points predictable here.
const fixOffset = (ownerId: string) =>
  db.query(`insert into public.location_privacy_offsets (owner_id, bearing, distance_m) values ($1, 0, 300)
            on conflict (owner_id) do update set bearing = 0, distance_m = 300`, [ownerId]);

interface SearchItem {
  id: string;
  title: string;
  distance_km: number | null;
  public_latitude: number | null;
  public_longitude: number | null;
  city: string | null;
}

const search = (args: Record<string, unknown>, userId: string | null = null) => {
  const names = Object.keys(args);
  const sql = `select public.search_listings(${names.map((n, i) => `${n} => $${i + 1}`).join(', ')}) as r`;
  return as<{ r: { total: number; items: SearchItem[] } }>(userId, sql, Object.values(args)).then((rows) => rows[0]!.r);
};

describe('privacy of the precise point', () => {
  test('only the owner can read the precise point; nobody can read the offsets', async () => {
    const [owner, other] = [await readyUser(), await readyUser()];
    const listing = await seedListing(owner);
    await setLocation(owner, listing, UAF);

    expect(await as(owner, `select latitude, longitude from public.listing_locations where listing_id = $1`, [listing])).toEqual([
      { latitude: UAF.lat, longitude: UAF.lng },
    ]);
    expect(await as(other, `select latitude from public.listing_locations where listing_id = $1`, [listing])).toEqual([]);
    expect(await sqlState(as(null, `select * from public.listing_locations`))).toBe('42501');
    for (const who of [owner, null]) {
      expect(await sqlState(as(who, `select * from public.location_privacy_offsets`))).toBe('42501');
    }
  });

  test('public results carry only the displaced point, 150-460 m from the precise one, rounded to 3 decimals', async () => {
    const owner = await readyUser();
    const listing = await seedListing(owner);
    const r = await setLocation(owner, listing, UAF);
    const item = (await search({ p_id: listing })).items[0]!;
    expect(item.public_latitude).toBe(r.public_latitude);
    expect(item).not.toHaveProperty('latitude');
    const shift = haversineKm(UAF, { lat: item.public_latitude!, lng: item.public_longitude! });
    expect(shift).toBeGreaterThan(0.15);
    expect(shift).toBeLessThan(0.46);
    expect(Number(item.public_latitude!.toFixed(3))).toBe(item.public_latitude);
    expect(Number(item.public_longitude!.toFixed(3))).toBe(item.public_longitude);
  });

  test('the public point is stable: re-saving the same spot, or another listing at it, gives the same point', async () => {
    const owner = await readyUser();
    const [a, b] = [await seedListing(owner), await seedListing(owner)];
    const first = await setLocation(owner, a, UAF);
    await setLocation(owner, a, move(UAF, 1));
    const again = await setLocation(owner, a, UAF);
    const other = await setLocation(owner, b, UAF);
    expect([again.public_latitude, again.public_longitude]).toEqual([first.public_latitude, first.public_longitude]);
    expect([other.public_latitude, other.public_longitude]).toEqual([first.public_latitude, first.public_longitude]);
  });

  test('nobody can write the public point or the precise point directly', async () => {
    const owner = await readyUser();
    const listing = await seedListing(owner);
    expect(await sqlState(as(owner, `update public.listings set public_latitude = 1, public_longitude = 1 where id = $1`, [listing]))).toBe(
      '42501',
    );
    expect(
      await sqlState(
        as(owner, `insert into public.listing_locations (listing_id, owner_id, latitude, longitude) values ($1, $2, 1, 1)`, [listing, owner]),
      ),
    ).toBe('42501');
  });

  test('only the owner of an unarchived listing, with an active account, can set its point', async () => {
    const [owner, other] = [await readyUser(), await readyUser()];
    const listing = await seedListing(owner);
    expect(await sqlState(setLocation(other, listing, UAF))).toBe('NSL01');
    expect(await sqlState(setLocation(null, listing, UAF))).toBe('42501');
    expect(await sqlState(setLocation(owner, listing, { lat: 91, lng: 0 }))).toBe('22023');
    expect(await sqlState(setLocation(owner, listing, { lat: 0, lng: -181 }))).toBe('22023');

    await db.query(`update public.profiles set account_status = 'suspended' where id = $1`, [owner]);
    expect(await sqlState(setLocation(owner, listing, UAF))).toBe('42501');
    await db.query(`update public.profiles set account_status = 'active' where id = $1`, [owner]);

    await as(owner, `update public.listings set archived_at = now() where id = $1`, [listing]);
    expect(await sqlState(setLocation(owner, listing, UAF))).toBe('NSL01');
  });

  test('clearing removes both points; the listing stays visible city-wide', async () => {
    const owner = await readyUser();
    const listing = await seedListing(owner, { city: 'Clearville' });
    await setLocation(owner, listing, UAF);
    expect(await as(owner, `select public.clear_listing_location($1) as ok`, [listing])).toEqual([{ ok: true }]);
    expect(await as(owner, `select listing_id from public.listing_locations where listing_id = $1`, [listing])).toEqual([]);
    const item = (await search({ p_city: 'clearville' })).items[0]!;
    expect(item).toMatchObject({ id: listing, public_latitude: null, public_longitude: null });
    expect(await sqlState(as(await readyUser(), `select public.clear_listing_location($1)`, [listing]))).toBe('NSL01');
  });
});

describe('nearby search', () => {
  const ids: Record<string, string> = {};
  let owner: string;
  // Unique search word so listings from other tests do not interfere.
  const q = 'nearbytest';

  beforeAll(async () => {
    owner = await readyUser();
    await fixOffset(owner);
    const place = async (name: string, at: { lat: number; lng: number } | null, category = 'tools') => {
      ids[name] = await seedListing(owner, { title: `${name} ${q}`, category });
      if (at) await setLocation(owner, ids[name]!, at);
    };
    // Public points are 300 m further north than these.
    await place('one', move(UAF, 1.0));
    await place('east', move(UAF, -0.3, 2.0), 'kitchen');
    await place('four', move(UAF, 4.0));
    await place('eight', move(UAF, 8.0));
    await place('lahore', LAHORE);
    await place('unplaced', null);
  });

  const nearby = (radius: number, extra: Record<string, unknown> = {}) =>
    search({ p_query: q, p_latitude: UAF.lat, p_longitude: UAF.lng, p_radius_km: radius, p_sort: 'distance', ...extra });

  test('3 km returns only listings within 3 km, nearest first, with a rounded distance', async () => {
    const r = await nearby(3);
    expect(r.items.map((i) => i.title)).toEqual([`one ${q}`, `east ${q}`]);
    expect(r.total).toBe(2);
    expect(r.items[0]!.distance_km).toBe(1.3);
    for (const item of r.items) {
      const exact = haversineKm(UAF, { lat: item.public_latitude!, lng: item.public_longitude! });
      expect(exact).toBeLessThanOrEqual(3);
      expect(item.distance_km).toBe(Math.round(exact * 10) / 10);
    }
  });

  test('widening the radius adds the next listings; a distant city never appears', async () => {
    expect((await nearby(5)).items.map((i) => i.title)).toEqual([`one ${q}`, `east ${q}`, `four ${q}`]);
    expect((await nearby(10)).items.map((i) => i.title)).toEqual([`one ${q}`, `east ${q}`, `four ${q}`, `eight ${q}`]);
    expect((await nearby(50)).items.map((i) => i.title)).not.toContain(`lahore ${q}`);
    // The radius is capped at 50 km, so even a huge one excludes Lahore (~120 km).
    expect((await nearby(100000)).items.map((i) => i.title)).not.toContain(`lahore ${q}`);
  });

  test('listings without a pickup point are excluded from nearby but shown without coordinates', async () => {
    expect((await nearby(50)).items.map((i) => i.title)).not.toContain(`unplaced ${q}`);
    const all = await search({ p_query: q });
    expect(all.items.map((i) => i.title)).toContain(`unplaced ${q}`);
    expect(all.items.every((i) => i.distance_km === null)).toBe(true);
    // Unchanged default: newest first.
    expect(all.items[0]!.title).toBe(`unplaced ${q}`);
  });

  test('other filters still apply within the radius', async () => {
    expect((await nearby(5, { p_category: 'kitchen' })).items.map((i) => i.title)).toEqual([`east ${q}`]);
  });

  test('pagination keeps distance order', async () => {
    const first = await nearby(10, { p_limit: 2, p_offset: 0 });
    const second = await nearby(10, { p_limit: 2, p_offset: 2 });
    expect([...first.items, ...second.items].map((i) => i.title)).toEqual([`one ${q}`, `east ${q}`, `four ${q}`, `eight ${q}`]);
    expect(first.total).toBe(4);
  });

  test('incomplete or invalid coordinates match nothing rather than everything', async () => {
    expect((await search({ p_query: q, p_latitude: 95, p_longitude: UAF.lng, p_radius_km: 3 })).items).toEqual([]);
    expect((await search({ p_query: q, p_latitude: UAF.lat, p_radius_km: 3 })).items).toEqual([]);
    expect((await search({ p_query: q, p_latitude: UAF.lat, p_longitude: UAF.lng })).items).toEqual([]);
  });

  test('archived listings and owners not in good standing are never nearby', async () => {
    const other = await readyUser();
    const listing = await seedListing(other, { title: `gone ${q}` });
    await setLocation(other, listing, UAF);
    expect((await nearby(3)).items.map((i) => i.title)).toContain(`gone ${q}`);
    await db.query(`update public.profiles set account_status = 'suspended' where id = $1`, [other]);
    expect((await nearby(3)).items.map((i) => i.title)).not.toContain(`gone ${q}`);
    await db.query(`update public.profiles set account_status = 'active' where id = $1`, [other]);
    await as(other, `update public.listings set archived_at = now() where id = $1`, [listing]);
    expect((await nearby(3)).items.map((i) => i.title)).not.toContain(`gone ${q}`);
  });

  test('a search across the antimeridian still finds nearby listings', async () => {
    const other = await readyUser();
    await fixOffset(other);
    const listing = await seedListing(other, { title: `fiji ${q}` });
    await setLocation(other, listing, { lat: -17.0, lng: 179.99 });
    const r = await search({ p_query: q, p_latitude: -17.0, p_longitude: -179.99, p_radius_km: 5, p_sort: 'distance' });
    expect(r.items.map((i) => i.title)).toEqual([`fiji ${q}`]);
  });
});

describe('city-wide browsing', () => {
  test('matches the city case-insensitively and includes listings without a pickup point', async () => {
    const owner = await readyUser();
    const placed = await seedListing(owner, { city: 'Multan' });
    await setLocation(owner, placed, { lat: 30.1575, lng: 71.5249 });
    const unplaced = await seedListing(owner, { city: 'Multan' });
    await seedListing(owner, { city: 'Karachi' });
    const r = await search({ p_city: '  MULTAN ' });
    expect(r.items.map((i) => i.id).sort()).toEqual([placed, unplaced].sort());
  });

  test('city is owner-editable; existing listings took their owner’s profile city', async () => {
    const owner = await readyUser();
    const listing = await seedListing(owner, { city: null });
    await as(owner, `update public.listings set city = 'Lahore' where id = $1`, [listing]);
    expect((await search({ p_id: listing })).items[0]!.city).toBe('Lahore');

    const legacy = (await search({ p_id: legacyListing })).items[0]!;
    expect(legacy.city).toBe('Faisalabad');
    expect(legacyOwner).toBeTruthy();
  });
});
