// Database tests for 20261026120000_phone_verification.sql on PGlite. They
// check that only the server can record phone results, that a result needs a
// matching request, and that a number is verified for one account at a time.
import { beforeAll, describe, expect, test } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { asRole, asUser, createAuthUser, createMigratedDb, sqlState } from './pglite.js';

const INSUFFICIENT_PRIVILEGE = '42501';

let db: PGlite;

beforeAll(async () => {
  db = await createMigratedDb();
});

const one = async <T>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0] as T;

// Calls a function as the backend does (secret key = service_role).
const asServer = (sql: string, params: unknown[] = []) =>
  asRoleCommitted('service_role', sql, params);

// asRole rolls back; these tests need the server's writes to persist, so run
// the statement in its own committed transaction with the role set.
async function asRoleCommitted(role: string, sql: string, params: unknown[]) {
  return db.transaction(async (tx) => {
    await tx.exec(`set local role ${role}`);
    return (await tx.query(sql, params)).rows;
  });
}

const state = (userId: string) =>
  one<{
    status: string;
    verified_at: unknown;
    phone_e164: string | null;
    phone_verified_at: unknown;
    pending_phone_e164: string | null;
    phone_otp_sent_at: unknown;
  }>(
    `select v.status, v.verified_at, p.phone_e164, p.phone_verified_at, p.pending_phone_e164, p.phone_otp_sent_at
       from public.profiles p
       join public.user_verifications v on v.user_id = p.id and v.verification_type = 'phone'
      where p.id = $1`,
    [userId],
  );

const begin = (u: string, cooldown = 60) => asServer('select public.phone_verification_begin($1, $2) as wait', [u, cooldown]);
const pending = (u: string, phone: string, resend = false) =>
  asServer('select public.phone_verification_pending($1, $2, $3)', [u, phone, resend]);
const complete = (u: string, phone: string) =>
  asServer('select public.phone_verification_complete($1, $2, now())', [u, phone]);

describe('requesting a code', () => {
  test('moves a new user to pending without marking anything verified', async () => {
    const u = await createAuthUser(db);
    expect((await begin(u))[0]).toEqual({ wait: 0 });
    await pending(u, '+923001234567');
    expect(await state(u)).toMatchObject({
      status: 'pending',
      verified_at: null,
      phone_e164: null,
      phone_verified_at: null,
      pending_phone_e164: '+923001234567',
    });
  });

  test('the resend cooldown makes a second request wait, and release lifts it', async () => {
    const u = await createAuthUser(db);
    expect((await begin(u, 60))[0]).toEqual({ wait: 0 });
    const [second] = (await begin(u, 60)) as { wait: number }[];
    expect(second?.wait).toBeGreaterThan(55);
    expect(second?.wait).toBeLessThanOrEqual(60);

    await asServer('select public.phone_verification_release($1)', [u]);
    expect((await begin(u, 60))[0]).toEqual({ wait: 0 });
  });

  test('suspended and deletion-pending accounts cannot reserve a send', async () => {
    for (const status of ['suspended', 'deletion_pending']) {
      const u = await createAuthUser(db);
      await db.query(`update public.profiles set account_status = $2::public.account_status where id = $1`, [u, status]);
      expect(await sqlState(begin(u))).toBe('PV403');
    }
  });

  test('audits the request without the number or code', async () => {
    const u = await createAuthUser(db);
    await pending(u, '+923001234568');
    const event = await one<{ metadata: Record<string, unknown>; actor_user_id: string }>(
      `select metadata, actor_user_id from public.audit_events
        where event_type = 'verification.phone_code_requested' and actor_user_id = $1`,
      [u],
    );
    expect(event.metadata).toEqual({ change_of_verified_number: false });
    expect(JSON.stringify(event.metadata)).not.toContain('923001234568');
  });
});

describe('recording a confirmed number', () => {
  test('marks the number verified only when it matches the requested number', async () => {
    const u = await createAuthUser(db);
    await pending(u, '+923001234569');
    expect(await sqlState(complete(u, '+923009999999'))).toBe('PV409');
    expect((await state(u)).status).toBe('pending');

    await complete(u, '+923001234569');
    const s = await state(u);
    expect(s).toMatchObject({ status: 'verified', phone_e164: '+923001234569', pending_phone_e164: null, phone_otp_sent_at: null });
    expect(s.verified_at).not.toBeNull();
    expect(s.phone_verified_at).not.toBeNull();
  });

  test('refuses when no code was ever requested', async () => {
    const u = await createAuthUser(db);
    expect(await sqlState(complete(u, '+923001234570'))).toBe('PV409');
    expect((await state(u)).status).toBe('not_started');
  });

  test("one user's result never touches another user's record", async () => {
    const [a, b] = [await createAuthUser(db), await createAuthUser(db)];
    await pending(a, '+923001234571');
    await pending(b, '+923001234572');
    await complete(a, '+923001234571');
    expect((await state(b)).status).toBe('pending');
    // b cannot complete a's number: b never requested it.
    expect(await sqlState(complete(b, '+923001234571'))).toBe('PV409');
  });

  test('changing a verified number keeps it verified until the new one is confirmed', async () => {
    const u = await createAuthUser(db);
    await pending(u, '+923001234573');
    await complete(u, '+923001234573');

    await pending(u, '+923001234574');
    expect(await state(u)).toMatchObject({ status: 'verified', phone_e164: '+923001234573', pending_phone_e164: '+923001234574' });

    await complete(u, '+923001234574');
    expect(await state(u)).toMatchObject({ status: 'verified', phone_e164: '+923001234574', pending_phone_e164: null });
    const changed = await one<{ n: number }>(
      `select count(*)::int as n from public.audit_events where event_type = 'verification.phone_changed' and actor_user_id = $1`,
      [u],
    );
    expect(changed.n).toBe(1);
  });

  test('a stale claim on the number by another account is withdrawn', async () => {
    const [a, b] = [await createAuthUser(db), await createAuthUser(db)];
    await pending(a, '+923001234575');
    await complete(a, '+923001234575');
    // a later changed number directly in Supabase Auth; Auth then let b take it.
    await pending(b, '+923001234575');
    await complete(b, '+923001234575');

    expect(await state(a)).toMatchObject({ status: 'revoked', phone_verified_at: null });
    expect(await state(b)).toMatchObject({ status: 'verified', phone_e164: '+923001234575' });
    const n = await one<{ n: number }>(
      `select count(*)::int as n from public.profiles where phone_e164 = '+923001234575' and phone_verified_at is not null`,
    );
    expect(n.n).toBe(1);
  });

  test('a revoked or expired verification can be verified again', async () => {
    const u = await createAuthUser(db);
    await pending(u, '+923001234576');
    await complete(u, '+923001234576');
    await asServer('select public.phone_verification_revoke($1)', [u]);
    expect(await state(u)).toMatchObject({ status: 'revoked', phone_verified_at: null });

    await pending(u, '+923001234576');
    expect((await state(u)).status).toBe('pending');
    await complete(u, '+923001234576');
    expect((await state(u)).status).toBe('verified');
  });

  test('a rejected code is audited and leaves the status unchanged', async () => {
    const u = await createAuthUser(db);
    await pending(u, '+923001234577');
    await asServer(`select public.phone_verification_failed($1, 'invalid_or_expired_code')`, [u]);
    expect((await state(u)).status).toBe('pending');
    const event = await one<{ outcome: string; metadata: unknown }>(
      `select outcome, metadata from public.audit_events where event_type = 'verification.phone_code_rejected' and actor_user_id = $1`,
      [u],
    );
    expect(event).toEqual({ outcome: 'failure', metadata: { reason: 'invalid_or_expired_code' } });
    expect(await sqlState(asServer(`select public.phone_verification_failed($1, 'the code was 123456')`, [u]))).toBe('23514');
  });
});

describe('clients', () => {
  const calls = [
    `select public.phone_verification_begin($1, 0)`,
    `select public.phone_verification_release($1)`,
    `select public.phone_verification_pending($1, '+923001234580', false)`,
    `select public.phone_verification_complete($1, '+923001234580', now())`,
    `select public.phone_verification_failed($1, 'invalid_or_expired_code')`,
    `select public.phone_verification_revoke($1)`,
  ];

  test.each(calls)('cannot call %s', async (sql) => {
    const u = await createAuthUser(db);
    expect(await sqlState(asUser(db, u, (tx) => tx.query(sql, [u])))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await sqlState(asRole(db, 'anon', null, (tx) => tx.query(sql, [u])))).toBe(INSUFFICIENT_PRIVILEGE);
  });

  test.each([
    ['pending_phone_e164', `pending_phone_e164 = '+923001234581'`],
    ['phone_otp_sent_at', `phone_otp_sent_at = null`],
    ['phone_e164', `phone_e164 = '+923001234581'`],
    ['phone_verified_at', `phone_verified_at = now()`],
  ])('cannot write %s', async (_col, assignment) => {
    const u = await createAuthUser(db);
    expect(await sqlState(asUser(db, u, (tx) => tx.query(`update public.profiles set ${assignment} where id = $1`, [u])))).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
  });

  test('cannot mark their own phone verified', async () => {
    const u = await createAuthUser(db);
    const sql = `update public.user_verifications set status = 'verified', verified_at = now()
                  where user_id = $1 and verification_type = 'phone'`;
    expect(await sqlState(asUser(db, u, (tx) => tx.query(sql, [u])))).toBe(INSUFFICIENT_PRIVILEGE);
    expect((await state(u)).status).toBe('not_started');
  });

  test('can read their own pending number but not anyone else’s', async () => {
    const [a, b] = [await createAuthUser(db), await createAuthUser(db)];
    await pending(a, '+923001234582');
    await pending(b, '+923001234583');
    const rows = await asUser(db, a, async (tx) =>
      (await tx.query<{ pending_phone_e164: string }>('select pending_phone_e164 from public.profiles')).rows,
    );
    expect(rows).toEqual([{ pending_phone_e164: '+923001234582' }]);
  });
});
