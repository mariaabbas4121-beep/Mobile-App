// Database tests for 20261105120000_browse_exclude_owner.sql on PGlite:
// search_listings can leave one owner's listings out, in every kind of
// search, and behaves as before without the new parameter.
import { beforeAll, describe, expect, test } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createAuthUser, createMigratedDb } from './pglite.js';

let db: PGlite;
let me: string;
let other: string;
const UAF = { lat: 31.431, lng: 73.07 };

async function as<T = Record<string, unknown>>(userId: string | null, sql: string, params: unknown[] = []): Promise<T[]> {
  return db.transaction(async (tx) => {
    await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [userId ?? '']);
    await tx.exec(`set local role ${userId ? 'authenticated' : 'anon'}`);
    return (await tx.query<T>(sql, params)).rows;
  });
}

const search = (args: Record<string, unknown>, userId: string | null) => {
  const names = Object.keys(args);
  const sql = `select public.search_listings(${names.map((n, i) => `${n} => $${i + 1}`).join(', ')}) as r`;
  return as<{ r: { total: number; items: { id: string; owner_id: string; title: string }[] } }>(userId, sql, Object.values(args)).then(
    (rows) => rows[0]!.r,
  );
};

async function seed(ownerId: string, title: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into public.listings (owner_id, title, description, category, condition, city)
     values ($1, $2, 'A useful item to borrow.', 'tools', 'good', 'Faisalabad') returning id`,
    [ownerId, title],
  );
  const id = rows[0]!.id;
  await as(ownerId, `select public.set_listing_location($1, $2, $3)`, [id, UAF.lat, UAF.lng]);
  return id;
}

beforeAll(async () => {
  db = await createMigratedDb();
  [me, other] = [await createAuthUser(db), await createAuthUser(db)];
  for (const u of [me, other]) await db.query(`update public.profiles set display_name = 'User' where id = $1`, [u]);
  await seed(me, 'My drill');
  await seed(me, 'My ladder');
  await seed(other, 'Their drill');
  await seed(other, 'Their tent');
  await seed(other, 'Their saw');
});

describe('p_exclude_owner_id', () => {
  test('leaves the owner out of plain, word, nearby and city searches, with matching totals', async () => {
    const cases: Record<string, unknown>[] = [
      {},
      { p_query: 'drill' },
      { p_latitude: UAF.lat, p_longitude: UAF.lng, p_radius_km: 3, p_sort: 'distance' },
      { p_city: 'faisalabad' },
    ];
    for (const args of cases) {
      const r = await search({ ...args, p_exclude_owner_id: me }, me);
      expect(r.items.length).toBeGreaterThan(0);
      expect(r.items.every((i) => i.owner_id === other)).toBe(true);
      expect(r.total).toBe(r.items.length);
    }
  });

  test('pages count only the remaining listings', async () => {
    const first = await search({ p_exclude_owner_id: me, p_limit: 2 }, me);
    const second = await search({ p_exclude_owner_id: me, p_limit: 2, p_offset: 2 }, me);
    expect(first.total).toBe(3);
    expect([...first.items, ...second.items].map((i) => i.title).sort()).toEqual(['Their drill', 'Their saw', 'Their tent']);
  });

  test('without it, or excluding someone else, the owner’s listings are still visible to others', async () => {
    expect((await search({}, me)).total).toBe(5);
    const forOther = await search({ p_exclude_owner_id: other }, other);
    expect(forOther.items.map((i) => i.title).sort()).toEqual(['My drill', 'My ladder']);
    expect((await search({}, null)).total).toBe(5);
  });

  test('anonymous callers can use the new signature', async () => {
    expect((await search({ p_exclude_owner_id: me }, null)).total).toBe(3);
  });
});
