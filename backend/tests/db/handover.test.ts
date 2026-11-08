// Database tests for 20261108120000_pickup_handover.sql on PGlite: only the
// borrower authorizes, only the lender verifies and confirms, codes are
// stored hashed, single-use and time-limited, a handover happens once, and
// evidence and history are visible to the two participants only.
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

async function readyUser(name: string): Promise<string> {
  const id = await createAuthUser(db);
  await db.query(`update public.profiles set display_name = $2 where id = $1`, [id, name]);
  return id;
}

// One statement as `userId` (authenticated), committed.
async function as<T = Record<string, unknown>>(userId: string, sql: string, params: unknown[] = []): Promise<T[]> {
  return db.transaction(async (tx) => {
    await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [userId]);
    await tx.exec(`set local role authenticated`);
    return (await tx.query<T>(sql, params)).rows;
  });
}

async function scenario(status: 'pending' | 'accepted' | 'declined' | 'cancelled' = 'accepted') {
  const [lender, borrower, outsider] = [await readyUser('Lender'), await readyUser('Borrower'), await readyUser('Outsider')];
  const { rows } = await db.query<{ id: string }>(
    `insert into public.listings (owner_id, title, description, category, condition)
     values ($1, 'Camping tent', 'Four person tent, waterproof.', 'outdoor', 'good') returning id`,
    [lender],
  );
  const [req] = await as<{ id: string }>(
    borrower,
    `insert into public.borrow_requests (listing_id, borrower_id, start_date, end_date) values ($1, $2, $3, $4) returning id`,
    [rows[0]!.id, borrower, day(1), day(2)],
  );
  const requestId = req!.id;
  if (status !== 'pending') {
    await as(status === 'cancelled' ? borrower : lender, `update public.borrow_requests set status = $2::public.borrow_request_status where id = $1`, [
      requestId,
      status,
    ]);
  }
  return { lender, borrower, outsider, requestId };
}

type Json = Record<string, any>;

const authorize = (userId: string, requestId: string, code = newCode(), name = 'Ali Khan', phone: string | null = '03001234567') =>
  as<{ r: Json }>(userId, `select public.create_pickup_authorization($1, $2, $3, $4, 'Comes after 5', 24) as r`, [
    requestId,
    hash(code),
    name,
    phone,
  ]).then((rows) => ({ code, authorization: rows[0]!.r }));

const verify = (userId: string, requestId: string, code: string) =>
  as<{ r: Json }>(userId, `select public.verify_pickup_code($1, $2) as r`, [requestId, hash(code)]).then((r) => r[0]!.r);

const confirm = (userId: string, requestId: string, method: string, code: string | null, notes: string | null = null) =>
  as<{ id: string }>(userId, `select public.confirm_handover($1, $2, $3, $4) as id`, [requestId, method, code === null ? null : hash(code), notes]).then(
    (r) => r[0]!.id,
  );

const revoke = (userId: string, requestId: string, authorizationId: string) =>
  as<{ r: Json }>(userId, `select public.revoke_pickup_authorization($1, $2) as r`, [requestId, authorizationId]).then((r) => r[0]!.r);

const state = (userId: string, requestId: string) =>
  as<{ r: Json | null }>(userId, `select public.get_handover_state($1) as r`, [requestId]).then((r) => r[0]!.r);

const events = (requestId: string) =>
  db.query<{ kind: string; actor_id: string }>(`select kind, actor_id from public.handover_events where borrow_request_id = $1 order by id`, [requestId]).then(
    (r) => r.rows,
  );

describe('creating a pickup authorization', () => {
  test('the borrower authorizes for an accepted request; only a hash of the code is stored, and it is audited', async () => {
    const { borrower, requestId } = await scenario();
    const { code, authorization } = await authorize(borrower, requestId);
    expect(authorization).toMatchObject({ status: 'active', operation: 'pickup', recipient_name: 'Ali Khan', recipient_phone: '03001234567', note: 'Comes after 5' });
    expect(authorization).not.toHaveProperty('token_hash');
    const hours = (Date.parse(authorization.expires_at) - Date.parse(authorization.created_at)) / 3_600_000;
    expect(hours).toBeCloseTo(24, 5);

    const { rows } = await db.query<Json>(`select * from public.pickup_authorizations where id = $1`, [authorization.id]);
    expect(rows[0]!.token_hash).toBe(hash(code));
    expect(JSON.stringify(rows[0])).not.toContain(code);
    expect(await events(requestId)).toEqual([{ kind: 'authorization_created', actor_id: borrower }]);
  });

  test('nobody else can: outsiders see no request, the lender is refused, and only accepted requests qualify', async () => {
    const { lender, outsider, requestId } = await scenario();
    expect(await sqlState(authorize(outsider, requestId))).toBe('NSH01');
    expect(await sqlState(authorize(lender, requestId))).toBe('42501');
    for (const status of ['pending', 'declined', 'cancelled'] as const) {
      const s = await scenario(status);
      expect(await sqlState(authorize(s.borrower, s.requestId))).toBe('NSH03');
    }
  });

  test('one active authorization at a time; revoking allows a new, distinct one for the same person', async () => {
    const { borrower, lender, requestId } = await scenario();
    const first = await authorize(borrower, requestId);
    expect(await sqlState(authorize(borrower, requestId))).toBe('NSH05');
    expect(await sqlState(revoke(lender, requestId, first.authorization.id))).toBe('42501');
    expect(await revoke(borrower, requestId, first.authorization.id)).toMatchObject({ status: 'revoked' });
    expect(await sqlState(revoke(borrower, requestId, first.authorization.id))).toBe('NSH06');
    const second = await authorize(borrower, requestId);
    expect(second.authorization.id).not.toBe(first.authorization.id);
    expect(second.authorization.recipient_name).toBe(first.authorization.recipient_name);
    expect((await events(requestId)).map((e) => e.kind)).toEqual(['authorization_created', 'authorization_revoked', 'authorization_created']);
  });

  test('the tables cannot be read or written directly by app users', async () => {
    const { borrower, lender, requestId } = await scenario();
    await authorize(borrower, requestId);
    for (const user of [borrower, lender]) {
      for (const table of ['pickup_authorizations', 'handovers', 'handover_events']) {
        expect(await sqlState(as(user, `select * from public.${table}`))).toBe('42501');
      }
      expect(await sqlState(as(user, `update public.pickup_authorizations set status = 'active'`))).toBe('42501');
      expect(
        await sqlState(as(user, `insert into public.handovers (borrow_request_id, method, confirmed_by) values ($1, 'personal', $2)`, [requestId, user])),
      ).toBe('42501');
    }
  });
});

describe('verifying and redeeming a code', () => {
  test('only the lender can check a code; checking changes nothing', async () => {
    const { borrower, lender, outsider, requestId } = await scenario();
    const { code } = await authorize(borrower, requestId);
    expect(await sqlState(verify(outsider, requestId, code))).toBe('NSH01');
    expect(await sqlState(verify(borrower, requestId, code))).toBe('42501');
    expect(await verify(lender, requestId, code)).toMatchObject({ status: 'active', recipient_name: 'Ali Khan' });
    expect(await verify(lender, requestId, code)).toMatchObject({ status: 'active' });
    expect((await state(lender, requestId))!.handover).toBeNull();
  });

  test('a wrong code, or one for another request, is simply invalid', async () => {
    const a = await scenario();
    const b = await scenario();
    const { code } = await authorize(a.borrower, a.requestId);
    expect(await sqlState(verify(a.lender, a.requestId, newCode()))).toBe('NSH07');
    // b's lender has the code of a's request.
    expect(await sqlState(verify(b.lender, b.requestId, code))).toBe('NSH07');
    expect(await sqlState(confirm(b.lender, b.requestId, 'authorized', code))).toBe('NSH07');
  });

  test('the correct lender redeems once: handover recorded with the recipient, code used, all audited', async () => {
    const { borrower, lender, requestId } = await scenario();
    const { code, authorization } = await authorize(borrower, requestId);
    const handoverId = await confirm(lender, requestId, 'authorized', code, 'Small scratch on the left pole');
    const s = (await state(borrower, requestId))!;
    expect(s.handover).toMatchObject({
      id: handoverId,
      method: 'authorized',
      authorization_id: authorization.id,
      recipient_name: 'Ali Khan',
      recipient_phone: '03001234567',
      condition_notes: 'Small scratch on the left pole',
      confirmed_by: { id: lender, display_name: 'Lender' },
    });
    expect(s.authorizations[0]).toMatchObject({ status: 'redeemed' });
    expect(JSON.stringify(s)).not.toContain('token_hash');
    // The request itself is unchanged: still accepted.
    expect(s.request_status).toBe('accepted');
    expect((await events(requestId)).map((e) => e.kind)).toEqual(['authorization_created', 'authorization_redeemed', 'handover_confirmed']);

    // Replay: the request is already handed over.
    expect(await sqlState(confirm(lender, requestId, 'authorized', code))).toBe('NSH04');
    expect(await sqlState(verify(lender, requestId, code))).toBe('NSH04');
    expect(await sqlState(authorize(borrower, requestId))).toBe('NSH04');
  });

  test('a used code is reported as used where the request is somehow still open to it', async () => {
    const { borrower, lender, requestId } = await scenario();
    const { code } = await authorize(borrower, requestId);
    await confirm(lender, requestId, 'authorized', code);
    // Simulate an inconsistent state to reach the per-code check directly.
    await db.query(`delete from public.handovers where borrow_request_id = $1`, [requestId]);
    expect(await sqlState(verify(lender, requestId, code))).toBe('NSH09');
  });

  test('revoked and expired codes are refused, both when checked and when confirming', async () => {
    const { borrower, lender, requestId } = await scenario();
    const revoked = await authorize(borrower, requestId);
    await revoke(borrower, requestId, revoked.authorization.id);
    expect(await sqlState(verify(lender, requestId, revoked.code))).toBe('NSH08');
    expect(await sqlState(confirm(lender, requestId, 'authorized', revoked.code))).toBe('NSH08');

    const expiring = await authorize(borrower, requestId);
    await db.query(
      `update public.pickup_authorizations set created_at = now() - interval '25 hours', expires_at = now() - interval '1 hour' where id = $1`,
      [expiring.authorization.id],
    );
    expect(await sqlState(verify(lender, requestId, expiring.code))).toBe('NSH10');
    expect(await sqlState(confirm(lender, requestId, 'authorized', expiring.code))).toBe('NSH10');
    const listed = (await state(borrower, requestId))!.authorizations as Json[];
    expect(listed.find((a) => a.id === expiring.authorization.id)).toMatchObject({ status: 'expired' });
    // A lapsed code does not block a replacement.
    expect((await authorize(borrower, requestId)).authorization.status).toBe('active');
  });

  test('two simultaneous confirmations record exactly one handover', async () => {
    const { borrower, lender, requestId } = await scenario();
    const { code } = await authorize(borrower, requestId);
    const results = await Promise.allSettled([
      confirm(lender, requestId, 'authorized', code),
      confirm(lender, requestId, 'authorized', code),
      confirm(lender, requestId, 'personal', null),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const { rows } = await db.query(`select * from public.handovers where borrow_request_id = $1`, [requestId]);
    expect(rows).toHaveLength(1);
  });
});

describe('personal pickup', () => {
  test('the lender confirms; any unused authorization stops working; it cannot happen twice', async () => {
    const { borrower, lender, requestId } = await scenario();
    const { code } = await authorize(borrower, requestId);
    expect(await sqlState(confirm(borrower, requestId, 'personal', null))).toBe('42501');
    await confirm(lender, requestId, 'personal', null);
    const s = (await state(lender, requestId))!;
    expect(s.handover).toMatchObject({ method: 'personal', recipient_name: null, authorization_id: null });
    expect(s.authorizations[0]).toMatchObject({ status: 'revoked' });
    expect(await sqlState(confirm(lender, requestId, 'personal', null))).toBe('NSH04');
    expect(await sqlState(confirm(lender, requestId, 'authorized', code))).toBe('NSH04');
  });

  test('not for requests that are not accepted, and the method must make sense', async () => {
    const pending = await scenario('pending');
    expect(await sqlState(confirm(pending.lender, pending.requestId, 'personal', null))).toBe('NSH03');
    const { lender, requestId } = await scenario();
    expect(await sqlState(confirm(lender, requestId, 'delivery', null))).toBe('22023');
    expect(await sqlState(confirm(lender, requestId, 'authorized', null))).toBe('22023');
    expect(await sqlState(confirm(lender, requestId, 'personal', newCode()))).toBe('22023');
  });
});

describe('visibility', () => {
  test('state and history are for the two participants only', async () => {
    const { borrower, lender, outsider, requestId } = await scenario();
    await authorize(borrower, requestId);
    expect(await state(outsider, requestId)).toBeNull();
    expect((await state(lender, requestId))!.authorizations).toHaveLength(1);

    const list = (u: string) => as<{ r: Json[] }>(u, `select public.list_handover_events(50) as r`).then((r) => r[0]!.r);
    expect((await list(borrower)).map((e) => e.request.id)).toContain(requestId);
    const forLender = (await list(lender)).find((e) => e.request.id === requestId)!;
    expect(forLender).toMatchObject({ kind: 'authorization_created', recipient_name: 'Ali Khan', request: { viewer_role: 'lender' } });
    expect((await list(outsider)).some((e) => e.request.id === requestId)).toBe(false);
  });
});

describe('condition evidence', () => {
  async function handedOver() {
    const s = await scenario();
    const handoverId = await confirm(s.lender, s.requestId, 'personal', null);
    return { ...s, handoverId };
  }

  const addPhoto = (userId: string, requestId: string, handoverId: string) =>
    as(userId, `insert into public.handover_photos (handover_id, borrow_request_id, storage_path, content_type) values ($1, $2, $3, 'image/jpeg') returning id`, [
      handoverId,
      requestId,
      `${requestId}/${handoverId}/${randomBytes(8).toString('hex')}.jpg`,
    ]);

  test('only the confirming lender adds photos, at most 5', async () => {
    const { borrower, lender, outsider, requestId, handoverId } = await handedOver();
    expect(await sqlState(addPhoto(borrower, requestId, handoverId))).toBe('42501');
    expect(await sqlState(addPhoto(outsider, requestId, handoverId))).toBe('42501');
    for (let i = 0; i < 5; i++) await addPhoto(lender, requestId, handoverId);
    expect(await sqlState(addPhoto(lender, requestId, handoverId))).toBe('NSH11');
  });

  test('no photos once 24 hours have passed', async () => {
    const { lender, requestId, handoverId } = await handedOver();
    await db.query(`update public.handovers set confirmed_at = now() - interval '25 hours' where id = $1`, [handoverId]);
    expect(await sqlState(addPhoto(lender, requestId, handoverId))).toBe('NSH12');
  });

  test('photo records and files are readable by the two participants only', async () => {
    const { borrower, lender, outsider, requestId, handoverId } = await handedOver();
    await addPhoto(lender, requestId, handoverId);
    const path = `${requestId}/${handoverId}/file.jpg`;
    await db.query(`insert into storage.objects (bucket_id, name) values ('handover-evidence', $1)`, [path]);

    const rows = (u: string) => as(u, `select id from public.handover_photos where borrow_request_id = $1`, [requestId]);
    const files = (u: string) => as(u, `select name from storage.objects where bucket_id = 'handover-evidence' and name = $1`, [path]);
    expect(await rows(borrower)).toHaveLength(1);
    expect(await rows(lender)).toHaveLength(1);
    expect(await rows(outsider)).toHaveLength(0);
    expect(await files(borrower)).toHaveLength(1);
    expect(await files(outsider)).toHaveLength(0);
    expect((await state(borrower, requestId))!.handover.photos).toHaveLength(1);

    const bucket = await db.query<{ public: boolean }>(`select public from storage.buckets where id = 'handover-evidence'`);
    expect(bucket.rows[0]!.public).toBe(false);
  });

  test('only the confirming lender may upload files, into that handover’s folder', async () => {
    const { borrower, lender, requestId, handoverId } = await handedOver();
    const upload = (u: string, name: string) => as(u, `insert into storage.objects (bucket_id, name) values ('handover-evidence', $1)`, [name]);
    expect(await sqlState(upload(borrower, `${requestId}/${handoverId}/a.jpg`))).toBe('42501');
    expect(await sqlState(upload(lender, `${requestId}/${requestId}/a.jpg`))).toBe('42501');
    expect(await sqlState(upload(lender, `${requestId}/${handoverId}/a.jpg`))).toBeUndefined();
  });
});
