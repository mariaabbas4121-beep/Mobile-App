// Database tests for supabase/migrations, run on PGlite with a stub of the
// Supabase auth schema and roles. They check the migration's own logic:
// provisioning, transitions, grants and RLS. Live behaviour on the hosted
// project is checked separately by the integration suite.
import { beforeAll, describe, expect, test } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { asRole, asUser, createAuthUser, createMigratedDb, sqlState } from './pglite.js';

const INSUFFICIENT_PRIVILEGE = '42501';
const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';

let db: PGlite;

beforeAll(async () => {
  db = await createMigratedDb();
});

const one = async <T>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0] as T;

describe('profile provisioning', () => {
  test('signup creates one profile, three verification rows and an audit event', async () => {
    const id = await createAuthUser(db, { metadata: { display_name: '  Ayesha  ' } });

    const profile = await one<{ display_name: string; account_status: string; profile_completed_at: unknown }>(
      'select * from public.profiles where id = $1',
      [id],
    );
    expect(profile).toMatchObject({ display_name: 'Ayesha', account_status: 'active', profile_completed_at: null });

    const rows = (
      await db.query<{ verification_type: string; status: string; verified_at: unknown }>(
        'select verification_type, status, verified_at from public.user_verifications where user_id = $1 order by verification_type',
        [id],
      )
    ).rows;
    expect(rows).toEqual([
      { verification_type: 'email', status: 'pending', verified_at: null },
      { verification_type: 'phone', status: 'not_started', verified_at: null },
      { verification_type: 'identity', status: 'not_started', verified_at: null },
    ]);

    const events = await one<{ n: number }>(
      `select count(*)::int as n from public.audit_events where entity_id = $1 and event_type = 'auth.user_registered'`,
      [id],
    );
    expect(events.n).toBe(1);
  });

  test('an already-confirmed user (e.g. OAuth) starts with email verified', async () => {
    const id = await createAuthUser(db, { confirmed: true });
    const row = await one<{ status: string; verified_at: unknown }>(
      `select status, verified_at from public.user_verifications where user_id = $1 and verification_type = 'email'`,
      [id],
    );
    expect(row.status).toBe('verified');
    expect(row.verified_at).not.toBeNull();
  });

  test('a user without an email has email verification not_started', async () => {
    const id = await createAuthUser(db, { email: null });
    const row = await one<{ status: string }>(
      `select status from public.user_verifications where user_id = $1 and verification_type = 'email'`,
      [id],
    );
    expect(row.status).toBe('not_started');
  });

  test.each([
    ['too short', { display_name: 'A' }],
    ['too long', { display_name: 'x'.repeat(200) }],
    ['not a string', { display_name: { nested: true } }],
    ['missing', {}],
  ])('invalid signup metadata (%s) never blocks signup', async (_label, metadata) => {
    const id = await createAuthUser(db, { metadata });
    const profile = await one<{ display_name: unknown }>('select display_name from public.profiles where id = $1', [id]);
    expect(profile.display_name).toBeNull();
  });

  test('a duplicate auth user insert fails without creating duplicate rows', async () => {
    const id = await createAuthUser(db);
    expect(await sqlState(db.query('insert into auth.users (id, email) values ($1, $2)', [id, 'dup@example.test']))).toBe(
      UNIQUE_VIOLATION,
    );
    const counts = await one<{ p: number; v: number }>(
      `select (select count(*) from public.profiles where id = $1)::int as p,
              (select count(*) from public.user_verifications where user_id = $1)::int as v`,
      [id],
    );
    expect(counts).toEqual({ p: 1, v: 3 });
  });
});

describe('email confirmation', () => {
  test('confirming in auth.users marks email verified once and audits the change', async () => {
    const id = await createAuthUser(db);
    await db.query('update auth.users set email_confirmed_at = now() where id = $1', [id]);
    // A repeated confirmation event must not change anything.
    await db.query('update auth.users set email_confirmed_at = now() where id = $1', [id]);

    const row = await one<{ status: string; provider_name: string; verified_at: unknown }>(
      `select status, provider_name, verified_at from public.user_verifications where user_id = $1 and verification_type = 'email'`,
      [id],
    );
    expect(row).toMatchObject({ status: 'verified', provider_name: 'supabase_auth' });
    expect(row.verified_at).not.toBeNull();

    const audit = await one<{ n: number }>(
      `select count(*)::int as n from public.audit_events
        where event_type = 'verification.status_changed' and metadata->>'user_id' = $1 and metadata->>'to' = 'verified'`,
      [id],
    );
    expect(audit.n).toBe(1);
  });
});

describe('verification transitions (server-side)', () => {
  test('rejects transitions outside the allowed graph, even for the database owner', async () => {
    const id = await createAuthUser(db);
    const update = (status: string) =>
      db.query(
        `update public.user_verifications set status = $2::public.verification_status, verified_at = now()
          where user_id = $1 and verification_type = 'identity'`,
        [id, status],
      );
    expect(await sqlState(update('rejected'))).toBe(CHECK_VIOLATION); // not_started -> rejected
    expect(await sqlState(update('pending'))).toBeUndefined();
    expect(await sqlState(update('verified'))).toBeUndefined();
    expect(await sqlState(update('pending'))).toBe(CHECK_VIOLATION); // verified -> pending
    expect(await sqlState(update('revoked'))).toBeUndefined();
  });

  test('a verified status requires verified_at', async () => {
    const id = await createAuthUser(db);
    const state = await sqlState(
      db.query(
        `update public.user_verifications set status = 'verified', verified_at = null
          where user_id = $1 and verification_type = 'phone'`,
        [id],
      ),
    );
    expect(state).toBe(CHECK_VIOLATION);
  });

  test('a provider reference cannot be attached to two users', async () => {
    const [a, b] = [await createAuthUser(db), await createAuthUser(db)];
    const attach = (user: string) =>
      db.query(
        `update public.user_verifications set status = 'pending', provider_name = 'acme_kyc', provider_reference = 'ref-123'
          where user_id = $1 and verification_type = 'identity'`,
        [user],
      );
    expect(await sqlState(attach(a))).toBeUndefined();
    expect(await sqlState(attach(b))).toBe(UNIQUE_VIOLATION);
  });
});

describe('authenticated users (RLS and grants)', () => {
  test('can read only their own profile and verifications', async () => {
    const [a, b] = [await createAuthUser(db), await createAuthUser(db)];
    const visible = await asUser(db, a, async (tx) => ({
      profiles: (await tx.query<{ id: string }>('select id from public.profiles')).rows.map((r) => r.id),
      verifications: (await tx.query<{ user_id: string }>('select user_id from public.user_verifications')).rows.map(
        (r) => r.user_id,
      ),
      other: (await tx.query('select * from public.profiles where id = $1', [b])).rows,
    }));
    expect(visible.profiles).toEqual([a]);
    expect(new Set(visible.verifications)).toEqual(new Set([a]));
    expect(visible.other).toEqual([]);
  });

  test('can update permitted fields and completing them sets profile_completed_at', async () => {
    const a = await createAuthUser(db);
    const row = await asUser(db, a, async (tx) => {
      await tx.query(
        `update public.profiles set display_name = 'Bilal', city = 'Lahore', neighborhood = 'Gulberg', bio = 'Hi'
          where id = $1`,
        [a],
      );
      return (await tx.query<{ profile_completed_at: unknown }>('select profile_completed_at from public.profiles where id = $1', [a]))
        .rows[0];
    });
    expect(row?.profile_completed_at).not.toBeNull();
  });

  test("cannot update another user's profile", async () => {
    const [a, b] = [await createAuthUser(db), await createAuthUser(db)];
    const affected = await asUser(db, a, async (tx) =>
      (await tx.query(`update public.profiles set display_name = 'Hijacked' where id = $1`, [b])).affectedRows,
    );
    expect(affected).toBe(0);
    const name = await one<{ display_name: unknown }>('select display_name from public.profiles where id = $1', [b]);
    expect(name.display_name).toBeNull();
  });

  test.each([
    ['account_status', `account_status = 'active'`],
    ['status_reason', `status_reason = 'x'`],
    ['phone_e164', `phone_e164 = '+923001234567'`],
    ['phone_verified_at', `phone_verified_at = now()`],
    ['profile_completed_at', `profile_completed_at = now()`],
    ['id', `id = gen_random_uuid()`],
  ])('cannot modify protected column %s', async (_col, assignment) => {
    const a = await createAuthUser(db);
    const state = await sqlState(
      asUser(db, a, (tx) => tx.query(`update public.profiles set ${assignment} where id = $1`, [a])),
    );
    expect(state).toBe(INSUFFICIENT_PRIVILEGE);
  });

  test('cannot insert or delete profiles', async () => {
    const a = await createAuthUser(db);
    expect(await sqlState(asUser(db, a, (tx) => tx.query('insert into public.profiles (id) values ($1)', [a])))).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
    expect(await sqlState(asUser(db, a, (tx) => tx.query('delete from public.profiles where id = $1', [a])))).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
  });

  test('cannot create or change their own verification results', async () => {
    const a = await createAuthUser(db);
    const attempts = [
      `update public.user_verifications set status = 'verified', verified_at = now() where user_id = '${a}'`,
      `insert into public.user_verifications (user_id, verification_type, status, verified_at)
         values ('${a}', 'identity', 'verified', now())`,
      `delete from public.user_verifications where user_id = '${a}'`,
    ];
    for (const sql of attempts) {
      expect(await sqlState(asUser(db, a, (tx) => tx.query(sql)))).toBe(INSUFFICIENT_PRIVILEGE);
    }
  });

  test('cannot read or write audit events', async () => {
    const a = await createAuthUser(db);
    for (const sql of [
      'select * from public.audit_events',
      `insert into public.audit_events (event_type, outcome) values ('x.y', 'success')`,
      'delete from public.audit_events',
    ]) {
      expect(await sqlState(asUser(db, a, (tx) => tx.query(sql)))).toBe(INSUFFICIENT_PRIVILEGE);
    }
  });

  test('cannot call internal functions', async () => {
    const a = await createAuthUser(db);
    const state = await sqlState(
      asUser(db, a, (tx) => tx.query(`select public.verification_transition_allowed('pending', 'verified')`)),
    );
    expect(state).toBe(INSUFFICIENT_PRIVILEGE);
  });

  test('a suspended user cannot edit their profile or reactivate themselves', async () => {
    const a = await createAuthUser(db);
    await db.query(`update public.profiles set account_status = 'suspended' where id = $1`, [a]);

    const affected = await asUser(db, a, async (tx) =>
      (await tx.query(`update public.profiles set display_name = 'Still here' where id = $1`, [a])).affectedRows,
    );
    expect(affected).toBe(0);
    expect(
      await sqlState(asUser(db, a, (tx) => tx.query(`update public.profiles set account_status = 'active' where id = $1`, [a]))),
    ).toBe(INSUFFICIENT_PRIVILEGE);

    const audit = await one<{ n: number }>(
      `select count(*)::int as n from public.audit_events where event_type = 'account.status_changed' and entity_id = $1`,
      [a],
    );
    expect(audit.n).toBe(1);
  });
});

describe('anonymous clients', () => {
  test.each(['profiles', 'user_verifications', 'audit_events'])('cannot read %s', async (table) => {
    expect(await sqlState(asRole(db, 'anon', null, (tx) => tx.query(`select * from public.${table}`)))).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
  });
});

describe('audit log integrity', () => {
  test('audit events cannot be updated or deleted, even by the service role', async () => {
    await createAuthUser(db);
    for (const sql of [`update public.audit_events set outcome = 'failure'`, 'delete from public.audit_events']) {
      expect(await sqlState(asRole(db, 'service_role', null, (tx) => tx.query(sql)))).not.toBeUndefined();
      expect(await sqlState(db.query(sql))).toBe(INSUFFICIENT_PRIVILEGE);
    }
  });

  test('only select and insert on audit_events are granted to the service role', async () => {
    const privs = await one<Record<string, boolean>>(
      `select ${['select', 'insert', 'update', 'delete', 'truncate']
        .map((p) => `has_table_privilege('service_role', 'public.audit_events', '${p}') as "${p}"`)
        .join(', ')}`,
    );
    expect(privs).toEqual({ select: true, insert: true, update: false, delete: false, truncate: false });
  });

  test('audit events cannot be truncated, even by the table owner', async () => {
    await createAuthUser(db);
    expect(await sqlState(asRole(db, 'service_role', null, (tx) => tx.query('truncate public.audit_events')))).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
    expect(await sqlState(db.query('truncate public.audit_events'))).toBe(INSUFFICIENT_PRIVILEGE);
  });

  test('the service role cannot truncate profiles or verifications', async () => {
    for (const table of ['profiles', 'user_verifications']) {
      const can = await one<{ t: boolean }>(`select has_table_privilege('service_role', 'public.${table}', 'truncate') as t`);
      expect(can.t).toBe(false);
    }
  });

  test('deleting a user removes their profile but keeps anonymised audit events', async () => {
    const a = await createAuthUser(db);
    await db.query('delete from auth.users where id = $1', [a]);
    const counts = await one<{ p: number; e: number; actor: number }>(
      `select (select count(*) from public.profiles where id = $1)::int as p,
              (select count(*) from public.audit_events where entity_id = $1)::int as e,
              (select count(*) from public.audit_events where actor_user_id = $1)::int as actor`,
      [a],
    );
    expect(counts).toEqual({ p: 0, e: 1, actor: 0 });
  });
});

describe('service role', () => {
  test('can manage verification state and account status', async () => {
    const a = await createAuthUser(db);
    await asRole(db, 'service_role', null, async (tx) => {
      await tx.query(`update public.profiles set account_status = 'restricted' where id = $1`, [a]);
      await tx.query(
        `update public.user_verifications set status = 'pending' where user_id = $1 and verification_type = 'phone'`,
        [a],
      );
      await tx.query(`insert into public.audit_events (event_type, outcome) values ('test.event', 'success')`);
    });
  });
});
