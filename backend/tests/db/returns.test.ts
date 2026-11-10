// Database tests for 20261110120000_returns_extensions.sql on PGlite: only
// the borrower initiates and authorizes, only the lender verifies and
// confirms receipt, return codes are separate from pickup codes, a return
// is confirmed once, evidence is private, and only an approved extension
// moves the due date.
import { createHash, randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, test } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { createAuthUser, createMigratedDb, sqlState } from './pglite.js';

let db: PGlite;
let today: string;

beforeAll(async () => {
  db = await createMigratedDb();
  today = (await db.query<{ d: string }>(`select public.borrow_today()::text as d`)).rows[0]!.d;
});

const day = (n: number) => {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const newCode = () => randomBytes(20).toString('hex');
const hash = (code: string) => createHash('sha256').update(code).digest('hex');
type Json = Record<string, any>;

async function readyUser(name: string): Promise<string> {
  const id = await createAuthUser(db);
  await db.query(`update public.profiles set display_name = $2 where id = $1`, [id, name]);
  return id;
}

async function as<T = Record<string, unknown>>(userId: string, sql: string, params: unknown[] = []): Promise<T[]> {
  return db.transaction(async (tx) => {
    await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [userId]);
    await tx.exec(`set local role authenticated`);
    return (await tx.query<T>(sql, params)).rows;
  });
}

const one = <T = Json>(userId: string, sql: string, params: unknown[] = []) => as<{ r: T }>(userId, sql, params).then((rows) => rows[0]!.r);

// Accepted (and by default picked up in person) request between a lender and a borrower.
async function scenario(opts: { pickedUp?: boolean; status?: 'pending' | 'accepted'; start?: number; end?: number } = {}) {
  const [lender, borrower, outsider] = [await readyUser('Lender'), await readyUser('Borrower'), await readyUser('Outsider')];
  const { rows } = await db.query<{ id: string }>(
    `insert into public.listings (owner_id, title, description, category, condition)
     values ($1, 'Camping tent', 'Four person tent, waterproof.', 'outdoor', 'good') returning id`,
    [lender],
  );
  const listing = rows[0]!.id;
  const [req] = await as<{ id: string }>(
    borrower,
    `insert into public.borrow_requests (listing_id, borrower_id, start_date, end_date) values ($1, $2, $3, $4) returning id`,
    [listing, borrower, day(opts.start ?? 1), day(opts.end ?? 3)],
  );
  const requestId = req!.id;
  if ((opts.status ?? 'accepted') === 'accepted') {
    await as(lender, `update public.borrow_requests set status = 'accepted' where id = $1`, [requestId]);
    if (opts.pickedUp ?? true) await as(lender, `select public.confirm_handover($1, 'personal', null, null)`, [requestId]);
  }
  return { lender, borrower, outsider, listing, requestId };
}

const initiate = (u: string, id: string, method = 'personal', provider: string | null = null, reference: string | null = null) =>
  one<string>(u, `select public.initiate_return($1, $2, $3, $4, 'Leaving at the gate') as r`, [id, method, provider, reference]);
const authorizeReturn = (u: string, id: string, code = newCode(), name = 'Bilal') =>
  one(u, `select public.create_return_authorization($1, $2, $3, '03001112233', 'My cousin', 24) as r`, [id, hash(code), name]).then(
    (authorization) => ({ code, authorization }),
  );
const verifyReturn = (u: string, id: string, code: string) => one(u, `select public.verify_return_code($1, $2) as r`, [id, hash(code)]);
const confirmReturn = (u: string, id: string, method: string, code: string | null, notes: string | null = null) =>
  one<string>(u, `select public.confirm_return($1, $2, $3, $4) as r`, [id, method, code === null ? null : hash(code), notes]);
const revokeReturn = (u: string, id: string, authId: string) => one(u, `select public.revoke_return_authorization($1, $2) as r`, [id, authId]);
const state = (u: string, id: string) => one<Json | null>(u, `select public.get_return_state($1) as r`, [id]);
const requestExtension = (u: string, id: string, date: string, reason: string | null = 'Trip got longer') =>
  one(u, `select public.request_extension($1, $2::date, $3) as r`, [id, date, reason]);
const decide = (u: string, id: string, extId: string, decision: string) =>
  one(u, `select public.decide_extension($1, $2, $3) as r`, [id, extId, decision]);
const kinds = (id: string) =>
  db.query<{ kind: string }>(`select kind from public.return_events where borrow_request_id = $1 order by id`, [id]).then((r) => r.rows.map((x) => x.kind));

// Moves a request's dates into the past (tests only), bypassing the trigger.
async function backdate(requestId: string, start: number, end: number) {
  await db.exec(`alter table public.borrow_requests disable trigger borrow_requests_before_update`);
  await db.query(`update public.borrow_requests set start_date = $2, end_date = $3 where id = $1`, [requestId, day(start), day(end)]);
  await db.exec(`alter table public.borrow_requests enable trigger borrow_requests_before_update`);
}

describe('initiating a return', () => {
  test('the borrower initiates in person or by delivery; it is awaiting the lender, not returned', async () => {
    const { borrower, lender, requestId } = await scenario();
    await initiate(borrower, requestId, 'delivery', 'TCS', 'TRK-123');
    let s = (await state(lender, requestId))!;
    expect(s.return).toMatchObject({ method: 'delivery', delivery_provider: 'TCS', delivery_reference: 'TRK-123', delivery_note: 'Leaving at the gate', confirmed_at: null });
    await initiate(borrower, requestId, 'personal');
    s = (await state(lender, requestId))!;
    expect(s.return).toMatchObject({ method: 'personal', delivery_provider: null, confirmed_at: null });
    expect(await kinds(requestId)).toEqual(['return_initiated', 'return_initiated']);
  });

  test('only the borrower, only after pickup, only for accepted requests', async () => {
    const { lender, outsider, requestId } = await scenario();
    expect(await sqlState(initiate(lender, requestId))).toBe('42501');
    expect(await sqlState(initiate(outsider, requestId))).toBe('NSH01');
    const notPicked = await scenario({ pickedUp: false });
    expect(await sqlState(initiate(notPicked.borrower, notPicked.requestId))).toBe('NSR01');
    const pending = await scenario({ status: 'pending' });
    expect(await sqlState(initiate(pending.borrower, pending.requestId))).toBe('NSH03');
    const s = await scenario();
    expect(await sqlState(initiate(s.borrower, s.requestId, 'authorized'))).toBe('22023');
  });

  test('app users cannot read or write the return tables directly', async () => {
    const { borrower, lender, requestId } = await scenario();
    await initiate(borrower, requestId);
    for (const u of [borrower, lender]) {
      for (const t of ['item_returns', 'due_date_extensions', 'return_events']) {
        expect(await sqlState(as(u, `select * from public.${t}`))).toBe('42501');
      }
      expect(await sqlState(as(u, `update public.item_returns set confirmed_at = now()`))).toBe('42501');
    }
    expect(await sqlState(as(borrower, `update public.borrow_requests set end_date = $2 where id = $1`, [requestId, day(10)]))).toBe('42501');
  });
});

describe('return authorizations', () => {
  test('the borrower authorizes; only a hash is stored; a replacement revokes the previous code atomically', async () => {
    const { borrower, lender, requestId } = await scenario();
    const first = await authorizeReturn(borrower, requestId);
    expect(first.authorization).toMatchObject({ operation: 'return', status: 'active', recipient_name: 'Bilal' });
    const { rows } = await db.query<Json>(`select token_hash from public.pickup_authorizations where id = $1`, [first.authorization.id]);
    expect(rows[0]!.token_hash).toBe(hash(first.code));
    expect((await state(lender, requestId))!.return).toMatchObject({ method: 'authorized', confirmed_at: null });

    const second = await authorizeReturn(borrower, requestId, newCode(), 'Bilal');
    const listed = (await state(borrower, requestId))!.authorizations as Json[];
    expect(listed.map((a) => [a.id, a.status])).toEqual([
      [second.authorization.id, 'active'],
      [first.authorization.id, 'revoked'],
    ]);
    expect(await sqlState(verifyReturn(lender, requestId, first.code))).toBe('NSH08');
    expect(await kinds(requestId)).toEqual(['return_initiated', 'return_authorization_created', 'return_authorization_revoked', 'return_authorization_created']);
  });

  test('the lender cannot authorize; revoke is borrower-only and only for active codes', async () => {
    const { borrower, lender, outsider, requestId } = await scenario();
    expect(await sqlState(authorizeReturn(lender, requestId))).toBe('42501');
    expect(await sqlState(authorizeReturn(outsider, requestId))).toBe('NSH01');
    const { authorization } = await authorizeReturn(borrower, requestId);
    expect(await sqlState(revokeReturn(lender, requestId, authorization.id))).toBe('42501');
    expect(await revokeReturn(borrower, requestId, authorization.id)).toMatchObject({ status: 'revoked' });
    expect(await sqlState(revokeReturn(borrower, requestId, authorization.id))).toBe('NSR04');
  });

  test('pickup and return codes never work for each other', async () => {
    const s = await scenario({ pickedUp: false });
    const pickupCode = newCode();
    await as(s.borrower, `select public.create_pickup_authorization($1, $2, 'Ali', null, null, 24)`, [s.requestId, hash(pickupCode)]);
    await as(s.lender, `select public.confirm_handover($1, 'authorized', $2, null)`, [s.requestId, hash(pickupCode)]);
    // A (used) pickup code is not a return code.
    expect(await sqlState(verifyReturn(s.lender, s.requestId, pickupCode))).toBe('NSH07');

    const { code: returnCode } = await authorizeReturn(s.borrower, s.requestId);
    expect(await sqlState(verifyReturn(s.lender, s.requestId, returnCode))).toBeUndefined();
    // ...and a return code is not a pickup code: at the pickup lookup it matches nothing.
    const asPickup = await sqlState(
      as(s.lender, `select public.usable_pickup_authorization($1, $2, false)`, [s.requestId, hash(returnCode)]),
    );
    expect(asPickup).toBe('42501');
    const lookup = await db.query(`select (public.usable_authorization($1, $2, 'pickup', false)).id`, [s.requestId, hash(returnCode)]).catch(
      (e: { code?: string }) => e.code,
    );
    expect(lookup).toBe('NSH07');
    // The pickup state lists pickup authorizations only.
    const pickup = await one<Json>(s.borrower, `select public.get_handover_state($1) as r`, [s.requestId]);
    expect((pickup.authorizations as Json[]).every((a) => a.operation === 'pickup')).toBe(true);
    // Revoking through the pickup function cannot touch a return code.
    const ret = (await state(s.borrower, s.requestId))!.authorizations[0];
    expect(await sqlState(as(s.borrower, `select public.revoke_pickup_authorization($1, $2)`, [s.requestId, ret.id]))).toBe('NSH01');
  });
});

describe('confirming receipt', () => {
  test('the lender verifies (no change), then confirms with the code: recorded once with the recipient', async () => {
    const { borrower, lender, outsider, requestId } = await scenario();
    const { code, authorization } = await authorizeReturn(borrower, requestId);
    expect(await sqlState(verifyReturn(borrower, requestId, code))).toBe('42501');
    expect(await sqlState(verifyReturn(outsider, requestId, code))).toBe('NSH01');
    expect(await verifyReturn(lender, requestId, code)).toMatchObject({ recipient_name: 'Bilal', status: 'active' });
    expect((await state(lender, requestId))!.return.confirmed_at).toBeNull();

    expect(await sqlState(confirmReturn(borrower, requestId, 'authorized', code))).toBe('42501');
    await confirmReturn(lender, requestId, 'authorized', code, 'Pole slightly bent');
    const s = (await state(borrower, requestId))!;
    expect(s.return).toMatchObject({
      method: 'authorized',
      authorization_id: authorization.id,
      recipient_name: 'Bilal',
      recipient_phone: '03001112233',
      condition_notes: 'Pole slightly bent',
      confirmed_by: { id: lender, display_name: 'Lender' },
    });
    expect(s.authorizations[0]).toMatchObject({ status: 'redeemed' });
    expect(s.request_status).toBe('accepted');
    expect(JSON.stringify(s)).not.toContain('token_hash');

    expect(await sqlState(confirmReturn(lender, requestId, 'authorized', code))).toBe('NSR03');
    expect(await sqlState(confirmReturn(lender, requestId, 'personal', null))).toBe('NSR03');
    expect(await sqlState(verifyReturn(lender, requestId, code))).toBe('NSR03');
    expect(await sqlState(initiate(borrower, requestId))).toBe('NSR03');
  });

  test('invalid, expired, revoked and other requests’ codes are refused', async () => {
    const a = await scenario();
    const b = await scenario();
    const { code } = await authorizeReturn(a.borrower, a.requestId);
    expect(await sqlState(verifyReturn(a.lender, a.requestId, newCode()))).toBe('NSH07');
    await initiate(b.borrower, b.requestId);
    expect(await sqlState(confirmReturn(b.lender, b.requestId, 'authorized', code))).toBe('NSH07');

    const expiring = await authorizeReturn(a.borrower, a.requestId);
    await db.query(`update public.pickup_authorizations set created_at = now() - interval '25 hours', expires_at = now() - interval '1 hour' where id = $1`, [
      expiring.authorization.id,
    ]);
    expect(await sqlState(verifyReturn(a.lender, a.requestId, expiring.code))).toBe('NSH10');
    expect(await sqlState(confirmReturn(a.lender, a.requestId, 'authorized', expiring.code))).toBe('NSH10');
    expect(await sqlState(verifyReturn(a.lender, a.requestId, code))).toBe('NSH08');
  });

  test('personal and delivery receipt need an initiated return, and retire an unused code', async () => {
    const { borrower, lender, requestId } = await scenario();
    expect(await sqlState(confirmReturn(lender, requestId, 'personal', null))).toBe('NSR02');
    const { code } = await authorizeReturn(borrower, requestId);
    await confirmReturn(lender, requestId, 'delivery', null);
    const s = (await state(borrower, requestId))!;
    expect(s.return).toMatchObject({ method: 'delivery', authorization_id: null, recipient_name: null });
    expect(s.authorizations[0]).toMatchObject({ status: 'revoked' });
    expect(await sqlState(verifyReturn(lender, requestId, code))).toBe('NSR03');
    expect(await sqlState(confirmReturn(lender, requestId, 'courier', null))).toBe('22023');
  });

  test('simultaneous confirmations record exactly one receipt', async () => {
    const { borrower, lender, requestId } = await scenario();
    const { code } = await authorizeReturn(borrower, requestId);
    const results = await Promise.allSettled([
      confirmReturn(lender, requestId, 'authorized', code),
      confirmReturn(lender, requestId, 'authorized', code),
      confirmReturn(lender, requestId, 'personal', null),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const { rows } = await db.query(`select * from public.item_returns where borrow_request_id = $1 and confirmed_at is not null`, [requestId]);
    expect(rows).toHaveLength(1);
  });
});

describe('return evidence', () => {
  async function returned() {
    const s = await scenario();
    await initiate(s.borrower, s.requestId);
    const returnId = await confirmReturn(s.lender, s.requestId, 'personal', null);
    return { ...s, returnId };
  }
  const addPhoto = (u: string, requestId: string, returnId: string) =>
    as(u, `insert into public.return_photos (return_id, borrow_request_id, storage_path, content_type) values ($1, $2, $3, 'image/jpeg') returning id`, [
      returnId,
      requestId,
      `${requestId}/${returnId}/${randomBytes(6).toString('hex')}.jpg`,
    ]);

  test('only the confirming lender, at most 5, never before confirmation', async () => {
    const s = await scenario();
    const returnId = await initiate(s.borrower, s.requestId);
    expect(await sqlState(addPhoto(s.lender, s.requestId, returnId))).toBe('NSR02');
    const { borrower, lender, outsider, requestId, returnId: done } = await returned();
    expect(await sqlState(addPhoto(borrower, requestId, done))).toBe('42501');
    expect(await sqlState(addPhoto(outsider, requestId, done))).toBe('42501');
    for (let i = 0; i < 5; i++) await addPhoto(lender, requestId, done);
    expect(await sqlState(addPhoto(lender, requestId, done))).toBe('NSH11');
  });

  test('no photos after 24 hours; records and files are for the participants only; the bucket is private', async () => {
    const { borrower, lender, outsider, requestId, returnId } = await returned();
    await addPhoto(lender, requestId, returnId);
    const path = `${requestId}/${returnId}/file.jpg`;
    await db.query(`insert into storage.objects (bucket_id, name) values ('return-evidence', $1)`, [path]);
    const files = (u: string) => as(u, `select name from storage.objects where bucket_id = 'return-evidence' and name = $1`, [path]);
    expect(await files(borrower)).toHaveLength(1);
    expect(await files(lender)).toHaveLength(1);
    expect(await files(outsider)).toHaveLength(0);
    expect(await as(outsider, `select id from public.return_photos where borrow_request_id = $1`, [requestId])).toHaveLength(0);
    expect(await sqlState(as(borrower, `insert into storage.objects (bucket_id, name) values ('return-evidence', $1)`, [`${requestId}/${returnId}/x.jpg`]))).toBe('42501');
    expect((await db.query<{ public: boolean }>(`select public from storage.buckets where id = 'return-evidence'`)).rows[0]!.public).toBe(false);

    await db.query(`update public.item_returns set confirmed_at = now() - interval '25 hours' where id = $1`, [returnId]);
    expect(await sqlState(addPhoto(lender, requestId, returnId))).toBe('NSH12');
  });
});

describe('due-date extensions', () => {
  test('the borrower asks; pending changes nothing; approval moves the due date; history kept', async () => {
    const { borrower, lender, requestId } = await scenario({ end: 3 });
    const ext = await requestExtension(borrower, requestId, day(6));
    expect(ext).toMatchObject({ status: 'pending', previous_end_date: day(3), requested_end_date: day(6) });
    expect((await state(lender, requestId))!.due_date).toBe(day(3));
    expect(await sqlState(requestExtension(borrower, requestId, day(7)))).toBe('NSE02');

    expect(await sqlState(decide(borrower, requestId, ext.id, 'approved'))).toBe('42501');
    const approved = await decide(lender, requestId, ext.id, 'approved');
    expect(approved).toMatchObject({ status: 'approved', decided_by: lender, overdue_at_decision: false });
    const s = (await state(borrower, requestId))!;
    expect(s).toMatchObject({ due_date: day(6), original_due_date: day(3) });
    expect(await sqlState(decide(lender, requestId, ext.id, 'rejected'))).toBe('NSE04');
    // The calendar shows the extended booking.
    const booked = (await db.query<{ r: Json[] }>(`select public.listing_booked_ranges(l.id) as r from public.borrow_requests b join public.listings l on l.id = b.listing_id where b.id = $1`, [requestId])).rows[0]!.r;
    expect(booked).toEqual([{ start_date: day(1), end_date: day(6) }]);
    expect(await kinds(requestId)).toEqual(['extension_requested', 'extension_approved']);
  });

  test('rejection leaves the due date unchanged', async () => {
    const { borrower, lender, requestId } = await scenario({ end: 3 });
    const ext = await requestExtension(borrower, requestId, day(5));
    expect(await decide(lender, requestId, ext.id, 'rejected')).toMatchObject({ status: 'rejected' });
    expect((await state(borrower, requestId))!.due_date).toBe(day(3));
    // A new request is possible after a decision.
    expect((await requestExtension(borrower, requestId, day(4))).status).toBe('pending');
  });

  test('invalid dates and other people are refused', async () => {
    const { borrower, lender, outsider, requestId } = await scenario({ start: 1, end: 3 });
    expect(await sqlState(requestExtension(lender, requestId, day(6)))).toBe('42501');
    expect(await sqlState(requestExtension(outsider, requestId, day(6)))).toBe('NSH01');
    for (const bad of [day(3), day(2), day(31)]) {
      expect(await sqlState(requestExtension(borrower, requestId, bad))).toBe('NSE03');
    }
    expect((await requestExtension(borrower, requestId, day(30))).status).toBe('pending');
    const pending = await scenario({ status: 'pending' });
    expect(await sqlState(requestExtension(pending.borrower, pending.requestId, day(6)))).toBe('NSH03');
  });

  test('cannot extend over someone else’s booking, at request or at approval', async () => {
    const s = await scenario({ start: 1, end: 3 });
    const other = await readyUser('Other');
    const [next] = await as<{ id: string }>(
      other,
      `insert into public.borrow_requests (listing_id, borrower_id, start_date, end_date) values ($1, $2, $3, $4) returning id`,
      [s.listing, other, day(6), day(7)],
    );
    // Asked for while the days were free, then someone else booked them.
    const ext = await requestExtension(s.borrower, s.requestId, day(6));
    await as(s.lender, `update public.borrow_requests set status = 'accepted' where id = $1`, [next!.id]);
    expect(await sqlState(decide(s.lender, s.requestId, ext.id, 'approved'))).toBe('NSE05');
    expect((await state(s.borrower, s.requestId))!.due_date).toBe(day(3));
    await decide(s.lender, s.requestId, ext.id, 'rejected');
    expect(await sqlState(requestExtension(s.borrower, s.requestId, day(7)))).toBe('NSE05');
  });

  test('overdue follows the approved due date, and an approval does not erase that it was late', async () => {
    const { borrower, lender, requestId } = await scenario({ start: 1, end: 3 });
    await backdate(requestId, -5, -2);
    let s = (await state(borrower, requestId))!;
    expect(s).toMatchObject({ overdue: true, due_date: day(-2), today });
    const ext = await requestExtension(borrower, requestId, day(2));
    expect(ext.requested_while_overdue).toBe(true);
    expect((await state(lender, requestId))!.overdue).toBe(true);
    const approved = await decide(lender, requestId, ext.id, 'approved');
    expect(approved).toMatchObject({ overdue_at_decision: true });
    s = (await state(borrower, requestId))!;
    expect(s).toMatchObject({ overdue: false, due_date: day(2), original_due_date: day(-2) });
    expect(s.extensions[0]).toMatchObject({ requested_while_overdue: true, overdue_at_decision: true });
  });

  test('not overdue before pickup or after the return', async () => {
    const notPicked = await scenario({ pickedUp: false });
    await backdate(notPicked.requestId, -5, -2);
    expect((await state(notPicked.borrower, notPicked.requestId))!.overdue).toBe(false);
    const s = await scenario();
    await backdate(s.requestId, -5, -2);
    await initiate(s.borrower, s.requestId);
    await confirmReturn(s.lender, s.requestId, 'personal', null);
    expect((await state(s.borrower, s.requestId))!.overdue).toBe(false);
    expect(await sqlState(requestExtension(s.borrower, s.requestId, day(3)))).toBe('NSR03');
  });

  test('the due date still cannot be changed any other way', async () => {
    const { requestId } = await scenario();
    expect(await sqlState(db.query(`update public.borrow_requests set end_date = end_date + 1 where id = $1`, [requestId]))).toBe('NSB05');
  });
});

describe('visibility', () => {
  test('state and events are for the two participants only', async () => {
    const { borrower, lender, outsider, requestId } = await scenario();
    await authorizeReturn(borrower, requestId);
    expect(await state(outsider, requestId)).toBeNull();
    const events = (u: string) => one<Json[]>(u, `select public.list_return_events(50) as r`);
    expect((await events(lender)).find((e) => e.request.id === requestId)).toMatchObject({
      kind: 'return_authorization_created',
      recipient_name: 'Bilal',
      request: { viewer_role: 'lender' },
    });
    expect((await events(outsider)).some((e) => e.request.id === requestId)).toBe(false);
  });
});
