// Database tests for 20261028120000_listings.sql on PGlite. They check that
// Row-Level Security alone keeps users to their own listings and photos, that
// discovery hides archived listings and suspended owners, and that the
// search function filters, paginates and sorts.
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, test } from 'vitest';
import type { PGlite, Transaction } from '@electric-sql/pglite';
import { asRole, asUser, createAuthUser, createMigratedDb, sqlState } from './pglite.js';

const INSUFFICIENT_PRIVILEGE = '42501';
const CHECK_VIOLATION = '23514';

let db: PGlite;

beforeAll(async () => {
  db = await createMigratedDb();
});

interface ListingInput {
  title?: string;
  description?: string;
  category?: string;
  condition?: string;
  availability?: string;
  tags?: string[];
  archived?: boolean;
}

// Inserted directly (as the table owner), committed, for read tests.
async function seedListing(ownerId: string, input: ListingInput = {}): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into public.listings (owner_id, title, description, category, condition, availability, tags, archived_at)
     values ($1, $2, $3, $4::public.listing_category, $5::public.listing_condition,
             $6::public.listing_availability, $7, case when $8 then now() end)
     returning id`,
    [
      ownerId,
      input.title ?? 'Power drill',
      input.description ?? 'A cordless drill with a full set of bits.',
      input.category ?? 'tools',
      input.condition ?? 'good',
      input.availability ?? 'available',
      input.tags ?? [],
      input.archived ?? false,
    ],
  );
  return rows[0]!.id;
}

async function readyUser(): Promise<string> {
  const id = await createAuthUser(db);
  await db.query(`update public.profiles set display_name = 'Owner ' || left($1::text, 4) where id = $1`, [id]);
  return id;
}

const insertAs = (tx: Transaction, ownerId: string) =>
  tx.query<{ id: string }>(
    `insert into public.listings (owner_id, title, description, category, condition)
     values ($1, 'Camping tent', 'Four-person tent, waterproof.', 'outdoor', 'good') returning id`,
    [ownerId],
  );

type SearchResult = { total: number; items: { id: string; title: string; owner_display_name: string | null }[] };

async function search(
  role: 'anon' | 'authenticated',
  userId: string | null,
  args: Record<string, unknown> = {},
): Promise<SearchResult> {
  const names = Object.keys(args);
  const sql = `select public.search_listings(${names.map((n, i) => `${n} => $${i + 1}`).join(', ')}) as r`;
  return asRole(db, role, userId, async (tx) => (await tx.query<{ r: SearchResult }>(sql, Object.values(args))).rows[0]!.r);
}

describe('creating listings', () => {
  test('an active user creates a listing for themself', async () => {
    const u = await readyUser();
    const rows = await asUser(db, u, async (tx) => (await insertAs(tx, u)).rows);
    expect(rows).toHaveLength(1);
  });

  test('nobody can create a listing for someone else', async () => {
    const [u, other] = [await readyUser(), await readyUser()];
    expect(await sqlState(asUser(db, u, (tx) => insertAs(tx, other)))).toBe(INSUFFICIENT_PRIVILEGE);
  });

  test('anonymous callers cannot create listings', async () => {
    const u = await readyUser();
    expect(await sqlState(asRole(db, 'anon', null, (tx) => insertAs(tx, u)))).toBe(INSUFFICIENT_PRIVILEGE);
  });

  test('restricted and suspended accounts cannot create listings', async () => {
    for (const status of ['restricted', 'suspended', 'deletion_pending']) {
      const u = await readyUser();
      await db.query(`update public.profiles set account_status = $2::public.account_status where id = $1`, [u, status]);
      expect(await sqlState(asUser(db, u, (tx) => insertAs(tx, u))), status).toBe(INSUFFICIENT_PRIVILEGE);
    }
  });

  test('column rules reject bad values', async () => {
    const u = await readyUser();
    const bad = (sql: string) => sqlState(asUser(db, u, (tx) => tx.query(sql, [u])));
    expect(
      await bad(`insert into public.listings (owner_id, title, description, category, condition)
                 values ($1, 'ab', 'A long enough description', 'tools', 'good')`),
    ).toBe(CHECK_VIOLATION);
    expect(
      await bad(`insert into public.listings (owner_id, title, description, category, condition, replacement_value_pkr)
                 values ($1, 'Drill', 'A long enough description', 'tools', 'good', -5)`),
    ).toBe(CHECK_VIOLATION);
    expect(
      await bad(`insert into public.listings (owner_id, title, description, category, condition, tags)
                 values ($1, 'Drill', 'A long enough description', 'tools', 'good', array['a','b','c','d','e','f'])`),
    ).toBe(CHECK_VIOLATION);
  });

  test('archived_at cannot be chosen at creation', async () => {
    const u = await readyUser();
    const state = await sqlState(
      asUser(db, u, (tx) =>
        tx.query(
          `insert into public.listings (owner_id, title, description, category, condition, archived_at)
           values ($1, 'Drill', 'A long enough description', 'tools', 'good', now())`,
          [u],
        ),
      ),
    );
    expect(state).toBe(INSUFFICIENT_PRIVILEGE);
  });
});

describe('updating and archiving', () => {
  test('the owner edits fields and the change is visible', async () => {
    const u = await readyUser();
    const id = await seedListing(u);
    const rows = await asUser(db, u, async (tx) =>
      (await tx.query(`update public.listings set title = 'Bosch drill', availability = 'unavailable' where id = $1 returning title, availability`, [id])).rows,
    );
    expect(rows).toEqual([{ title: 'Bosch drill', availability: 'unavailable' }]);
  });

  test("another user's update matches no rows", async () => {
    const [owner, other] = [await readyUser(), await readyUser()];
    const id = await seedListing(owner);
    const rows = await asUser(db, other, async (tx) =>
      (await tx.query(`update public.listings set title = 'Stolen' where id = $1 returning id`, [id])).rows,
    );
    expect(rows).toEqual([]);
  });

  test('ownership cannot be transferred', async () => {
    const [owner, other] = [await readyUser(), await readyUser()];
    const id = await seedListing(owner);
    const state = await sqlState(asUser(db, owner, (tx) => tx.query(`update public.listings set owner_id = $2 where id = $1`, [id, other])));
    expect(state).toBe(INSUFFICIENT_PRIVILEGE);
  });

  test('archiving uses the server clock and is final', async () => {
    const u = await readyUser();
    const id = await seedListing(u);
    await db.transaction(async (tx) => {
      await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [u]);
      await tx.exec('set local role authenticated');
      const { rows } = await tx.query<{ archived_at: Date }>(
        `update public.listings set archived_at = '2000-01-01' where id = $1 returning archived_at`,
        [id],
      );
      expect(rows[0]!.archived_at.getFullYear()).toBeGreaterThan(2000);
    });
    // The update policy no longer matches an archived listing...
    const rows = await asUser(db, u, async (tx) =>
      (await tx.query(`update public.listings set archived_at = null where id = $1 returning id`, [id])).rows,
    );
    expect(rows).toEqual([]);
    // ...and the trigger refuses even the table owner.
    expect(await sqlState(db.query(`update public.listings set archived_at = null where id = $1`, [id]))).toBe(CHECK_VIOLATION);
  });

  test('users cannot delete listing rows', async () => {
    const u = await readyUser();
    const id = await seedListing(u);
    expect(await sqlState(asUser(db, u, (tx) => tx.query(`delete from public.listings where id = $1`, [id])))).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
  });

  test('suspended owners cannot edit; restricted owners can', async () => {
    const [suspended, restricted] = [await readyUser(), await readyUser()];
    const a = await seedListing(suspended);
    const b = await seedListing(restricted);
    await db.query(`update public.profiles set account_status = 'suspended' where id = $1`, [suspended]);
    await db.query(`update public.profiles set account_status = 'restricted' where id = $1`, [restricted]);
    const update = (u: string, id: string) =>
      asUser(db, u, async (tx) => (await tx.query(`update public.listings set availability = 'unavailable' where id = $1 returning id`, [id])).rows);
    expect(await update(suspended, a)).toEqual([]);
    expect(await update(restricted, b)).toHaveLength(1);
  });
});

describe('discovery', () => {
  test('anonymous callers see listings on show, with the owner display name', async () => {
    const u = await readyUser();
    const id = await seedListing(u, { title: 'Unique anon-visible ladder' });
    const r = await search('anon', null, { p_id: id });
    expect(r.total).toBe(1);
    expect(r.items[0]).toMatchObject({ id, title: 'Unique anon-visible ladder' });
    expect(r.items[0]!.owner_display_name).toMatch(/^Owner /);
  });

  test('archived listings are hidden from others but the owner can ask for them', async () => {
    const [owner, other] = [await readyUser(), await readyUser()];
    const id = await seedListing(owner, { archived: true });
    expect((await search('anon', null, { p_id: id, p_include_archived: true })).total).toBe(0);
    expect((await search('authenticated', other, { p_id: id, p_include_archived: true })).total).toBe(0);
    expect((await search('authenticated', owner, { p_id: id })).total).toBe(0);
    expect((await search('authenticated', owner, { p_id: id, p_include_archived: true })).total).toBe(1);
  });

  test("a suspended owner's listings leave discovery", async () => {
    const u = await readyUser();
    const id = await seedListing(u);
    await db.query(`update public.profiles set account_status = 'suspended' where id = $1`, [u]);
    expect((await search('anon', null, { p_id: id })).total).toBe(0);
  });

  test('public reads expose no private profile columns', async () => {
    const u = await readyUser();
    await seedListing(u);
    expect(await sqlState(asRole(db, 'anon', null, (tx) => tx.query(`select * from public.profiles`)))).toBe(INSUFFICIENT_PRIVILEGE);
    const r = await search('anon', null, { p_owner_id: u });
    expect(Object.keys(r.items[0]!).sort()).toEqual([
      'archived_at', 'area', 'availability', 'borrowing_terms', 'category', 'condition', 'created_at', 'description',
      'id', 'owner_display_name', 'owner_id', 'replacement_value_pkr', 'tags', 'teach_me_enabled', 'title', 'updated_at',
    ]);
  });

  test('listing_owner_name does not reveal users without listings', async () => {
    const lonely = await readyUser();
    const name = await asRole(db, 'anon', null, async (tx) =>
      (await tx.query<{ n: string | null }>(`select public.listing_owner_name($1) as n`, [lonely])).rows[0]!.n,
    );
    expect(name).toBeNull();
  });

  describe('search, filters and pagination', () => {
    let owner: string;
    beforeAll(async () => {
      owner = await readyUser();
      await seedListing(owner, { title: 'Zeta camera', description: 'Canon DSLR with kit lens.', category: 'electronics', condition: 'excellent' });
      await seedListing(owner, { title: 'Alpha tent', description: 'Waterproof four person tent.', category: 'outdoor', tags: ['Camping'] });
      await seedListing(owner, { title: 'Mid drill', description: 'Bosch cordless drill set.', category: 'tools', availability: 'unavailable' });
    });
    const mine = (args: Record<string, unknown> = {}) => search('anon', null, { p_owner_id: owner, ...args });

    test('matches every word, case-insensitively, across title, description and tags', async () => {
      expect((await mine({ p_query: 'CANON lens' })).items.map((i) => i.title)).toEqual(['Zeta camera']);
      expect((await mine({ p_query: 'camping' })).items.map((i) => i.title)).toEqual(['Alpha tent']);
      expect((await mine({ p_query: 'canon tent' })).total).toBe(0);
    });

    test('treats wildcard characters literally', async () => {
      expect((await mine({ p_query: '%' })).total).toBe(0);
      expect((await mine({ p_query: '_' })).total).toBe(0);
    });

    test('filters by category, condition and availability', async () => {
      expect((await mine({ p_category: 'outdoor' })).items.map((i) => i.title)).toEqual(['Alpha tent']);
      expect((await mine({ p_condition: 'excellent' })).items.map((i) => i.title)).toEqual(['Zeta camera']);
      expect((await mine({ p_availability: 'unavailable' })).items.map((i) => i.title)).toEqual(['Mid drill']);
    });

    test('paginates with a total that survives past the last page', async () => {
      const first = await mine({ p_sort: 'title', p_limit: 2, p_offset: 0 });
      expect(first.total).toBe(3);
      expect(first.items.map((i) => i.title)).toEqual(['Alpha tent', 'Mid drill']);
      const second = await mine({ p_sort: 'title', p_limit: 2, p_offset: 2 });
      expect(second.items.map((i) => i.title)).toEqual(['Zeta camera']);
      const beyond = await mine({ p_sort: 'title', p_limit: 2, p_offset: 10 });
      expect(beyond).toEqual({ total: 3, items: [] });
    });

    test('sorts newest first by default and oldest on request', async () => {
      expect((await mine()).items.map((i) => i.title)).toEqual(['Mid drill', 'Alpha tent', 'Zeta camera']);
      expect((await mine({ p_sort: 'oldest' })).items.map((i) => i.title)).toEqual(['Zeta camera', 'Alpha tent', 'Mid drill']);
    });

    test('caps the page size at 50', async () => {
      // Would error or return everything if the cap were missing; here it
      // simply limits the result.
      expect((await mine({ p_limit: 100000 })).items.length).toBeLessThanOrEqual(50);
    });
  });
});

describe('listing images', () => {
  const pathFor = (owner: string, listing: string) => `${owner}/${listing}/${randomUUID()}.jpg`;
  const addImage = (tx: Transaction, owner: string, listing: string, path = pathFor(owner, listing)) =>
    tx.query(
      `insert into public.listing_images (listing_id, owner_id, storage_path, content_type, size_bytes)
       values ($1, $2, $3, 'image/jpeg', 1000) returning id`,
      [listing, owner, path],
    );

  test('the owner adds photos to their own listing', async () => {
    const u = await readyUser();
    const l = await seedListing(u);
    const rows = await asUser(db, u, async (tx) => (await addImage(tx, u, l)).rows);
    expect(rows).toHaveLength(1);
  });

  test("nobody adds photos to another user's listing", async () => {
    const [owner, other] = [await readyUser(), await readyUser()];
    const l = await seedListing(owner);
    // Claiming to be the owner fails RLS; claiming to be themself fails the
    // composite foreign key / path rule.
    expect(await sqlState(asUser(db, other, (tx) => addImage(tx, owner, l)))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await sqlState(asUser(db, other, (tx) => addImage(tx, other, l, pathFor(other, l))))).toBeDefined();
  });

  test('a path outside the listing folder is rejected', async () => {
    const u = await readyUser();
    const [l, elsewhere] = [await seedListing(u), await seedListing(u)];
    expect(await sqlState(asUser(db, u, (tx) => addImage(tx, u, l, pathFor(u, elsewhere))))).toBe(CHECK_VIOLATION);
  });

  test('photos cannot be added to archived listings', async () => {
    const u = await readyUser();
    const l = await seedListing(u, { archived: true });
    expect(await sqlState(asUser(db, u, (tx) => addImage(tx, u, l)))).toBe(INSUFFICIENT_PRIVILEGE);
  });

  test('at most five photos per listing', async () => {
    const u = await readyUser();
    const l = await seedListing(u);
    for (let i = 0; i < 5; i++) {
      await db.query(
        `insert into public.listing_images (listing_id, owner_id, storage_path, content_type, size_bytes)
         values ($1, $2, $3, 'image/jpeg', 1000)`,
        [l, u, pathFor(u, l)],
      );
    }
    expect(await sqlState(asUser(db, u, (tx) => addImage(tx, u, l)))).toBe(CHECK_VIOLATION);
  });

  test("other users cannot delete someone's photos", async () => {
    const [owner, other] = [await readyUser(), await readyUser()];
    const l = await seedListing(owner);
    const { rows } = await db.query<{ id: string }>(
      `insert into public.listing_images (listing_id, owner_id, storage_path, content_type, size_bytes)
       values ($1, $2, $3, 'image/jpeg', 1000) returning id`,
      [l, owner, pathFor(owner, l)],
    );
    const deleted = await asUser(db, other, async (tx) =>
      (await tx.query(`delete from public.listing_images where id = $1 returning id`, [rows[0]!.id])).rows,
    );
    expect(deleted).toEqual([]);
  });

  test('image rows are visible exactly when their listing is', async () => {
    const u = await readyUser();
    const [shown, archived] = [await seedListing(u), await seedListing(u)];
    for (const l of [shown, archived]) {
      await db.query(
        `insert into public.listing_images (listing_id, owner_id, storage_path, content_type, size_bytes)
         values ($1, $2, $3, 'image/jpeg', 1000)`,
        [l, u, pathFor(u, l)],
      );
    }
    await db.query(`update public.listings set archived_at = now() where id = $1`, [archived]);
    const visible = await asRole(db, 'anon', null, async (tx) =>
      (await tx.query<{ listing_id: string }>(`select listing_id from public.listing_images where listing_id = any($1)`, [[shown, archived]])).rows,
    );
    expect(visible.map((r) => r.listing_id)).toEqual([shown]);
  });
});

describe('storage policies for the listing-images bucket', () => {
  const upload = (tx: Transaction, name: string) =>
    tx.query(`insert into storage.objects (bucket_id, name) values ('listing-images', $1)`, [name]);

  test('the bucket exists and is private with size and type limits', async () => {
    const { rows } = await db.query(`select public, file_size_limit, allowed_mime_types from storage.buckets where id = 'listing-images'`);
    expect(rows).toEqual([{ public: false, file_size_limit: 5242880, allowed_mime_types: ['image/jpeg', 'image/png', 'image/webp'] }]);
  });

  test('owners upload only into their own listing folder', async () => {
    const [owner, other] = [await readyUser(), await readyUser()];
    const l = await seedListing(owner);
    expect(await sqlState(asUser(db, owner, (tx) => upload(tx, `${owner}/${l}/${randomUUID()}.jpg`)))).toBeUndefined();
    expect(await sqlState(asUser(db, other, (tx) => upload(tx, `${owner}/${l}/${randomUUID()}.jpg`)))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await sqlState(asUser(db, other, (tx) => upload(tx, `${other}/${l}/${randomUUID()}.jpg`)))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await sqlState(asRole(db, 'anon', null, (tx) => upload(tx, `${owner}/${l}/${randomUUID()}.jpg`)))).toBe(INSUFFICIENT_PRIVILEGE);
  });

  test('files are readable only when referenced by a visible listing image', async () => {
    const u = await readyUser();
    const l = await seedListing(u);
    const [referenced, orphan] = [`${u}/${l}/${randomUUID()}.jpg`, `${u}/${l}/${randomUUID()}.jpg`];
    await db.query(`insert into storage.objects (bucket_id, name) values ('listing-images', $1), ('listing-images', $2)`, [referenced, orphan]);
    await db.query(
      `insert into public.listing_images (listing_id, owner_id, storage_path, content_type, size_bytes) values ($1, $2, $3, 'image/jpeg', 10)`,
      [l, u, referenced],
    );
    const anonSees = await asRole(db, 'anon', null, async (tx) =>
      (await tx.query<{ name: string }>(`select name from storage.objects where name = any($1)`, [[referenced, orphan]])).rows.map((r) => r.name),
    );
    expect(anonSees).toEqual([referenced]);
    const ownerSees = await asUser(db, u, async (tx) =>
      (await tx.query(`select name from storage.objects where name = any($1)`, [[referenced, orphan]])).rows,
    );
    expect(ownerSees).toHaveLength(2);
  });

  test("users cannot delete another user's files", async () => {
    const [owner, other] = [await readyUser(), await readyUser()];
    const l = await seedListing(owner);
    const name = `${owner}/${l}/${randomUUID()}.jpg`;
    await db.query(`insert into storage.objects (bucket_id, name) values ('listing-images', $1)`, [name]);
    const deleted = await asUser(db, other, async (tx) =>
      (await tx.query(`delete from storage.objects where name = $1 returning name`, [name])).rows,
    );
    expect(deleted).toEqual([]);
  });
});
