// Database tests for 20261102120000_borrow_requests.sql on PGlite: who may
// create and change requests, the lifecycle, the date window, and the
// exclusion constraint that keeps accepted reservations from overlapping.
//
// PGlite runs one connection, so two transactions cannot truly race here.
// The no-overlap guarantee comes from PostgreSQL's exclusion constraint,
// which serialises conflicting writes on a real server; these tests check
// that the constraint exists and rejects every overlapping accept.
import { beforeAll, describe, expect, test } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { asRole, asUser, createAuthUser, createMigratedDb, sqlState } from './pglite.js';

let db: PGlite;
let today: string;

beforeAll(async () => {
  db = await createMigratedDb();
  today = (await db.query<{ d: string }>(`select public.borrow_today()::text as d`)).rows[0]!.d;
});

// Calendar date `n` days from today (Pakistan), as YYYY-MM-DD.
const day = (n: number) => {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

async function readyUser(): Promise<string> {
  const id = await createAuthUser(db);
  await db.query(`update public.profiles set display_name = 'User ' || left($1::text, 4) where id = $1`, [id]);
  return id;
}

async function seedListing(ownerId: string, opts: { archived?: boolean; availability?: string } = {}): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into public.listings (owner_id, title, description, category, condition, availability, archived_at)
     values ($1, 'Camping tent', 'Four person tent, waterproof.', 'outdoor', 'good', $2::public.listing_availability,
             case when $3 then now() end)
     returning id`,
    [ownerId, opts.availability ?? 'available', opts.archived ?? false],
  );
  return rows[0]!.id;
}

// Runs one statement as `userId` (authenticated) and commits it.
async function as<T = Record<string, unknown>>(userId: string | null, sql: string, params: unknown[] = []): Promise<T[]> {
  return db.transaction(async (tx) => {
    await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [userId ?? '']);
    await tx.exec(`set local role ${userId ? 'authenticated' : 'service_role'}`);
    return (await tx.query<T>(sql, params)).rows;
  });
}

const request = (borrower: string, listing: string, start = day(1), end = day(3), message: string | null = null) =>
  as<{ id: string; lender_id: string; status: string }>(
    borrower,
    `insert into public.borrow_requests (listing_id, borrower_id, start_date, end_date, message)
     values ($1, $2, $3, $4, $5) returning id, lender_id, status`,
    [listing, borrower, start, end, message],
  ).then((r) => r[0]!);

const setStatus = (userId: string | null, id: string, status: string) =>
  as<{ status: string; decided_at: unknown; cancelled_at: unknown }>(
    userId,
    `update public.borrow_requests set status = $2::public.borrow_request_status where id = $1
     returning status, decided_at, cancelled_at`,
    [id, status],
  );

const statusOf = async (id: string) =>
  (await db.query<{ status: string }>(`select status from public.borrow_requests where id = $1`, [id])).rows[0]?.status;

describe('creating requests', () => {
  test('a borrower creates a pending request; the lender is filled from the listing', async () => {
    const [lender, borrower] = [await readyUser(), await readyUser()];
    const listing = await seedListing(lender);
    const r = await request(borrower, listing, day(1), day(3), 'Need it for a trip');
    expect(r).toMatchObject({ lender_id: lender, status: 'pending' });
  });

  test('client-chosen lender or status is impossible', async () => {
    const [lender, borrower, other] = [await readyUser(), await readyUser(), await readyUser()];
    const listing = await seedListing(lender);
    for (const col of ['lender_id', 'status']) {
      const value = col === 'lender_id' ? other : 'accepted';
      const state = await sqlState(
        as(borrower, `insert into public.borrow_requests (listing_id, borrower_id, start_date, end_date, ${col})
                      values ($1, $2, $3, $4, $5)`, [listing, borrower, day(1), day(2), value]),
      );
      expect(state, col).toBe('42501');
    }
  });

  test('nobody can create a request in someone else’s name', async () => {
    const [lender, borrower, impostor] = [await readyUser(), await readyUser(), await readyUser()];
    const listing = await seedListing(lender);
    const state = await sqlState(
      as(impostor, `insert into public.borrow_requests (listing_id, borrower_id, start_date, end_date) values ($1, $2, $3, $4)`,
         [listing, borrower, day(1), day(2)]),
    );
    expect(state).toBe('42501');
  });

  test('anonymous callers can neither read nor create', async () => {
    const lender = await readyUser();
    const listing = await seedListing(lender);
    expect(await sqlState(asRole(db, 'anon', null, (tx) => tx.query(`select * from public.borrow_requests`)))).toBe('42501');
    expect(await sqlState(asRole(db, 'anon', null, (tx) =>
      tx.query(`insert into public.borrow_requests (listing_id, borrower_id, start_date, end_date) values ($1, $2, $3, $4)`,
               [listing, lender, day(1), day(2)])))).toBe('42501');
  });

  test('own, archived and unavailable listings cannot be requested', async () => {
    const [lender, borrower] = [await readyUser(), await readyUser()];
    expect(await sqlState(request(lender, await seedListing(lender)))).toBe('NSB02');
    expect(await sqlState(request(borrower, await seedListing(lender, { archived: true })))).toBe('NSB01');
    expect(await sqlState(request(borrower, await seedListing(lender, { availability: 'unavailable' })))).toBe('NSB01');
  });

  test('a suspended lender’s listing cannot be requested; a suspended borrower cannot request', async () => {
    const [lender, borrower] = [await readyUser(), await readyUser()];
    const listing = await seedListing(lender);
    await db.query(`update public.profiles set account_status = 'suspended' where id = $1`, [lender]);
    expect(await sqlState(request(borrower, listing))).toBe('NSB01');

    const [lender2, suspended] = [await readyUser(), await readyUser()];
    await db.query(`update public.profiles set account_status = 'suspended' where id = $1`, [suspended]);
    expect(await sqlState(request(suspended, await seedListing(lender2)))).toBe('42501');
  });

  test.each([
    ['end before start', () => [day(3), day(1)], '23514'],
    ['longer than 30 days', () => [day(1), day(31)], '23514'],
    ['starting in the past', () => [day(-1), day(1)], 'NSB03'],
    ['starting more than 90 days ahead', () => [day(91), day(92)], 'NSB03'],
  ])('dates: %s is rejected', async (_name, range, code) => {
    const [lender, borrower] = [await readyUser(), await readyUser()];
    const [start, end] = range();
    expect(await sqlState(request(borrower, await seedListing(lender), start, end))).toBe(code);
  });

  test('same-day and exactly-30-day requests are allowed', async () => {
    const [lender, b1, b2] = [await readyUser(), await readyUser(), await readyUser()];
    const listing = await seedListing(lender);
    expect((await request(b1, listing, day(0), day(0))).status).toBe('pending');
    expect((await request(b2, listing, day(1), day(30))).status).toBe('pending');
  });

  test('one pending request per borrower per listing', async () => {
    const [lender, borrower] = [await readyUser(), await readyUser()];
    const listing = await seedListing(lender);
    await request(borrower, listing, day(1), day(2));
    expect(await sqlState(request(borrower, listing, day(5), day(6)))).toBe('23505');
  });

  test('a message is limited to 500 characters', async () => {
    const [lender, borrower] = [await readyUser(), await readyUser()];
    expect(await sqlState(request(borrower, await seedListing(lender), day(1), day(2), 'x'.repeat(501)))).toBe('23514');
  });
});

describe('lifecycle and permissions', () => {
  async function pending() {
    const [lender, borrower] = [await readyUser(), await readyUser()];
    const listing = await seedListing(lender);
    const { id } = await request(borrower, listing);
    return { lender, borrower, listing, id };
  }

  test('the lender accepts; the decision time is stamped', async () => {
    const { lender, id } = await pending();
    const [row] = await setStatus(lender, id, 'accepted');
    expect(row).toMatchObject({ status: 'accepted', cancelled_at: null });
    expect(row!.decided_at).not.toBeNull();
  });

  test('the lender declines', async () => {
    const { lender, id } = await pending();
    expect((await setStatus(lender, id, 'declined'))[0]?.status).toBe('declined');
  });

  test('the borrower cancels a pending request', async () => {
    const { borrower, id } = await pending();
    const [row] = await setStatus(borrower, id, 'cancelled');
    expect(row).toMatchObject({ status: 'cancelled', decided_at: null });
    expect(row!.cancelled_at).not.toBeNull();
  });

  test('the borrower cannot accept or decline; the lender cannot cancel', async () => {
    const { lender, borrower, id } = await pending();
    expect(await sqlState(setStatus(borrower, id, 'accepted'))).toBe('42501');
    expect(await sqlState(setStatus(borrower, id, 'declined'))).toBe('42501');
    expect(await sqlState(setStatus(lender, id, 'cancelled'))).toBe('42501');
    expect(await statusOf(id)).toBe('pending');
  });

  test('outsiders cannot see or change a request', async () => {
    const { id } = await pending();
    const outsider = await readyUser();
    expect(await asUser(db, outsider, async (tx) => (await tx.query(`select id from public.borrow_requests where id = $1`, [id])).rows)).toEqual([]);
    expect(await setStatus(outsider, id, 'accepted')).toEqual([]);
    expect(await statusOf(id)).toBe('pending');
  });

  test.each([
    ['accepted', 'declined'],
    ['accepted', 'cancelled'],
    ['declined', 'accepted'],
    ['cancelled', 'accepted'],
    ['accepted', 'pending'],
  ])('%s cannot become %s', async (first, next) => {
    const { lender, borrower, id } = await pending();
    await setStatus(first === 'cancelled' ? borrower : lender, id, first);
    const actor = next === 'cancelled' ? borrower : lender;
    expect(await sqlState(setStatus(actor, id, next))).toBe('NSB05');
    expect(await statusOf(id)).toBe(first);
  });

  test('dates, message and parties cannot be edited after creation', async () => {
    const { borrower, id } = await pending();
    expect(await sqlState(as(borrower, `update public.borrow_requests set end_date = end_date + 1 where id = $1`, [id]))).toBe('42501');
    // Even the service role cannot rewrite the request itself.
    expect(await sqlState(as(null, `update public.borrow_requests set end_date = end_date + 1 where id = $1`, [id]))).toBe('NSB05');
  });

  test('a suspended lender cannot accept; a restricted lender can decline but not accept', async () => {
    const a = await pending();
    await db.query(`update public.profiles set account_status = 'suspended' where id = $1`, [a.lender]);
    expect(await setStatus(a.lender, a.id, 'accepted')).toEqual([]);

    const b = await pending();
    await db.query(`update public.profiles set account_status = 'restricted' where id = $1`, [b.lender]);
    expect(await sqlState(setStatus(b.lender, b.id, 'accepted'))).toBe('42501');
    expect((await setStatus(b.lender, b.id, 'declined'))[0]?.status).toBe('declined');
  });

  test('archiving the listing declines its pending requests and blocks accepting', async () => {
    const { lender, listing, id } = await pending();
    await as(lender, `update public.listings set archived_at = now() where id = $1`, [listing]);
    expect(await statusOf(id)).toBe('declined');
  });

  test('users cannot delete requests', async () => {
    const { borrower, id } = await pending();
    expect(await sqlState(as(borrower, `delete from public.borrow_requests where id = $1`, [id]))).toBe('42501');
  });
});

describe('reservation safety', () => {
  test('two overlapping requests cannot both be accepted (inclusive end dates)', async () => {
    const [lender, b1, b2, b3] = [await readyUser(), await readyUser(), await readyUser(), await readyUser()];
    const listing = await seedListing(lender);
    const first = await request(b1, listing, day(2), day(4));
    const touching = await request(b2, listing, day(4), day(6)); // shares day 4
    const after = await request(b3, listing, day(5), day(7)); // starts the day after

    await setStatus(lender, first.id, 'accepted');
    expect(await sqlState(setStatus(lender, touching.id, 'accepted'))).toBe('23P01');
    expect(await statusOf(touching.id)).toBe('pending');
    expect((await setStatus(lender, after.id, 'accepted'))[0]?.status).toBe('accepted');
  });

  test('the constraint holds even for the service role (no code path can bypass it)', async () => {
    const [lender, b1, b2] = [await readyUser(), await readyUser(), await readyUser()];
    const listing = await seedListing(lender);
    const a = await request(b1, listing, day(10), day(12));
    const b = await request(b2, listing, day(11), day(11));
    await setStatus(null, a.id, 'accepted');
    expect(await sqlState(setStatus(null, b.id, 'accepted'))).toBe('23P01');
  });

  test('accepting both inside one transaction also fails, so batching cannot sneak past', async () => {
    const [lender, b1, b2] = [await readyUser(), await readyUser(), await readyUser()];
    const listing = await seedListing(lender);
    const a = await request(b1, listing, day(20), day(22));
    const b = await request(b2, listing, day(21), day(23));
    const state = await sqlState(
      db.transaction(async (tx) => {
        await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [lender]);
        await tx.exec('set local role authenticated');
        await tx.query(`update public.borrow_requests set status = 'accepted' where id = any($1)`, [[a.id, b.id]]);
      }),
    );
    expect(state).toBe('23P01');
    expect([await statusOf(a.id), await statusOf(b.id)]).toEqual(['pending', 'pending']);
  });

  test('new requests for already-reserved days are refused; other listings are unaffected', async () => {
    const [lender, b1, b2] = [await readyUser(), await readyUser(), await readyUser()];
    const [listing, other] = [await seedListing(lender), await seedListing(lender)];
    const a = await request(b1, listing, day(3), day(5));
    await setStatus(lender, a.id, 'accepted');
    expect(await sqlState(request(b2, listing, day(5), day(8)))).toBe('NSB04');
    expect((await request(b2, other, day(3), day(5))).status).toBe('pending');
  });

  test('declined and cancelled requests do not reserve anything', async () => {
    const [lender, b1, b2, b3] = [await readyUser(), await readyUser(), await readyUser(), await readyUser()];
    const listing = await seedListing(lender);
    const a = await request(b1, listing, day(40), day(42));
    const b = await request(b2, listing, day(40), day(42));
    await setStatus(lender, a.id, 'declined');
    await setStatus(b2, b.id, 'cancelled');
    const c = await request(b3, listing, day(41), day(41));
    expect((await setStatus(lender, c.id, 'accepted'))[0]?.status).toBe('accepted');
  });
});

describe('read helpers', () => {
  test('booked ranges show dates only, to anyone who can see the listing', async () => {
    const [lender, borrower] = [await readyUser(), await readyUser()];
    const listing = await seedListing(lender);
    const r = await request(borrower, listing, day(6), day(8));
    await setStatus(lender, r.id, 'accepted');
    const ranges = await asRole(db, 'anon', null, async (tx) =>
      (await tx.query<{ r: unknown }>(`select public.listing_booked_ranges($1) as r`, [listing])).rows[0]!.r,
    );
    expect(ranges).toEqual([{ start_date: day(6), end_date: day(8) }]);
  });

  test('list_borrow_requests returns only the caller’s side, with names and titles', async () => {
    const [lender, borrower, outsider] = [await readyUser(), await readyUser(), await readyUser()];
    const listing = await seedListing(lender);
    const r = await request(borrower, listing, day(1), day(2), 'Please!');
    const call = (user: string, role: string | null, id: string | null = null) =>
      as<{ j: { total: number; items: Array<Record<string, unknown>> } }>(
        user, `select public.list_borrow_requests(p_role => $1, p_id => $2) as j`, [role, id],
      ).then((rows) => rows[0]!.j);

    const incoming = await call(lender, 'lender');
    expect(incoming.total).toBe(1);
    expect(incoming.items[0]).toMatchObject({
      id: r.id,
      status: 'pending',
      message: 'Please!',
      listing: { id: listing, title: 'Camping tent', archived: false },
      borrower: { id: borrower, display_name: expect.stringMatching(/^User /) },
      lender: { id: lender },
    });
    expect((await call(lender, 'borrower')).total).toBe(0);
    expect((await call(borrower, 'borrower')).total).toBe(1);
    expect((await call(outsider, null, r.id)).total).toBe(0);
    // Not callable anonymously.
    expect(await sqlState(asRole(db, 'anon', null, (tx) => tx.query(`select public.list_borrow_requests()`)))).toBe('42501');
  });
});
