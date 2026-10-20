// Live authorization checks against the development/test project.
//
// Two layers are checked separately:
//   - the API (profile route, account-status guard)
//   - the database itself, by calling Supabase's REST endpoint directly with
//     a user's own access token, bypassing this API entirely, as a malicious
//     client holding a valid token could.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { adminClient, integrationConfig, liveApp, TestUsers } from './setup.js';
import type { Config } from '../../src/config/env.js';

let config: Config;
let app: Express;
let admin: SupabaseClient;
let users: TestUsers;

interface Account {
  id: string;
  token: string;
  db: SupabaseClient; // direct database access as this user (RLS applies)
}

beforeAll(() => {
  config = integrationConfig();
  app = liveApp(config);
  admin = adminClient(config);
  users = new TestUsers(admin);
});

afterAll(async () => {
  await users?.cleanup();
});

async function account(displayName?: string): Promise<Account> {
  const u = await users.create({ confirmed: true, ...(displayName ? { displayName } : {}) });
  const res = await request(app).post('/api/v1/auth/login').send({ email: u.email, password: u.password });
  expect(res.status).toBe(200);
  const token = res.body.data.session.accessToken as string;
  const db = createClient(config.supabase.url, config.supabase.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  return { id: u.id, token, db };
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

async function setStatus(userId: string, status: string) {
  const { error } = await admin.from('profiles').update({ account_status: status }).eq('id', userId);
  expect(error).toBeNull();
}

describe('profile completion through the API (live)', () => {
  test('filling required fields completes the profile server-side', async () => {
    const a = await account();
    const res = await request(app)
      .patch('/api/v1/profile/me')
      .set(bearer(a.token))
      .send({ displayName: 'Hamza', city: 'Islamabad', neighborhood: 'F-7' });
    expect(res.status).toBe(200);
    expect(res.body.data.profile.profileCompletedAt).not.toBeNull();

    const status = await request(app).get('/api/v1/auth/status').set(bearer(a.token));
    expect(status.body.data.milestones.profile_complete).toBe(true);
    expect(status.body.data.profile.missingFields).toEqual([]);

    // Clearing a required field un-completes it.
    await request(app).patch('/api/v1/profile/me').set(bearer(a.token)).send({ city: null });
    const after = await request(app).get('/api/v1/auth/status').set(bearer(a.token));
    expect(after.body.data.milestones.profile_complete).toBe(false);
  });

  test('protected fields are refused by the API', async () => {
    const a = await account();
    const res = await request(app).patch('/api/v1/profile/me').set(bearer(a.token)).send({ accountStatus: 'active' });
    expect(res.status).toBe(400);
  });
});

describe('account status enforcement (live)', () => {
  test('a suspended user cannot edit through the API or directly, and cannot reactivate', async () => {
    const a = await account('Before Suspension');
    await setStatus(a.id, 'suspended');

    const api = await request(app).patch('/api/v1/profile/me').set(bearer(a.token)).send({ displayName: 'After' });
    expect(api.status).toBe(403);
    expect(api.body.code).toBe('ACCOUNT_SUSPENDED');

    // Still able to see their status and sign out.
    const status = await request(app).get('/api/v1/auth/status').set(bearer(a.token));
    expect(status.body.data.accountStatus).toBe('suspended');

    // Directly against the database: RLS matches no row, so nothing changes.
    const direct = await a.db.from('profiles').update({ display_name: 'After' }).eq('id', a.id).select();
    expect(direct.error).toBeNull();
    expect(direct.data).toEqual([]);

    const reactivate = await a.db.from('profiles').update({ account_status: 'active' }).eq('id', a.id);
    expect(reactivate.error?.code).toBe('42501');

    const { data } = await admin.from('profiles').select('display_name, account_status').eq('id', a.id).single();
    expect(data).toEqual({ display_name: 'Before Suspension', account_status: 'suspended' });

    // The status change itself was audited.
    const { count } = await admin
      .from('audit_events')
      .select('id', { count: 'exact', head: true })
      .eq('event_type', 'account.status_changed')
      .eq('entity_id', a.id);
    expect(count).toBe(1);
  });

  test('suspension takes effect on the next request, not at token expiry', async () => {
    const a = await account();
    expect((await request(app).patch('/api/v1/profile/me').set(bearer(a.token)).send({ bio: 'one' })).status).toBe(200);
    await setStatus(a.id, 'deletion_pending');
    const res = await request(app).patch('/api/v1/profile/me').set(bearer(a.token)).send({ bio: 'two' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ACCOUNT_DELETION_PENDING');
  });
});

describe('database access control with a user token (live, bypassing the API)', () => {
  let a: Account;
  let b: Account;

  beforeAll(async () => {
    a = await account('User A');
    b = await account('User B');
  });

  test("user A cannot read user B's profile or verifications", async () => {
    const profiles = await a.db.from('profiles').select('id');
    expect(profiles.error).toBeNull();
    expect(profiles.data).toEqual([{ id: a.id }]);

    const other = await a.db.from('profiles').select('*').eq('id', b.id);
    expect(other.data).toEqual([]);

    const verifications = await a.db.from('user_verifications').select('user_id');
    expect(new Set(verifications.data?.map((r) => r.user_id))).toEqual(new Set([a.id]));
  });

  test("user A cannot update user B's profile", async () => {
    const res = await a.db.from('profiles').update({ display_name: 'Hijacked' }).eq('id', b.id).select();
    expect(res.data).toEqual([]);
    const { data } = await admin.from('profiles').select('display_name').eq('id', b.id).single();
    expect(data?.display_name).toBe('User B');
  });

  test.each([
    ['account_status', { account_status: 'active' }],
    ['phone_verified_at', { phone_verified_at: new Date().toISOString() }],
    ['phone_e164', { phone_e164: '+923001234567' }],
    ['profile_completed_at', { profile_completed_at: new Date().toISOString() }],
  ])('user cannot write protected column %s', async (_col, change) => {
    const res = await a.db.from('profiles').update(change).eq('id', a.id);
    expect(res.error?.code).toBe('42501');
  });

  test('user cannot create, verify or delete their own verification records', async () => {
    const update = await a.db
      .from('user_verifications')
      .update({ status: 'verified', verified_at: new Date().toISOString() })
      .eq('user_id', a.id)
      .eq('verification_type', 'identity');
    expect(update.error?.code).toBe('42501');

    const insert = await a.db
      .from('user_verifications')
      .insert({ user_id: a.id, verification_type: 'identity', status: 'verified', verified_at: new Date().toISOString() });
    expect(insert.error?.code).toBe('42501');

    const del = await a.db.from('user_verifications').delete().eq('user_id', a.id);
    expect(del.error?.code).toBe('42501');

    const { data } = await admin
      .from('user_verifications')
      .select('status')
      .eq('user_id', a.id)
      .eq('verification_type', 'identity')
      .single();
    expect(data?.status).toBe('not_started');
  });

  test('user cannot read, write or delete audit events', async () => {
    expect((await a.db.from('audit_events').select('id')).error?.code).toBe('42501');
    expect((await a.db.from('audit_events').insert({ event_type: 'fake.event', outcome: 'success' })).error?.code).toBe('42501');
    expect((await a.db.from('audit_events').delete().gt('id', 0)).error?.code).toBe('42501');
  });

  test('user cannot create profiles or call internal functions', async () => {
    expect((await a.db.from('profiles').insert({ id: crypto.randomUUID() })).error?.code).toBe('42501');
    const rpc = await a.db.rpc('verification_transition_allowed', { from_status: 'pending', to_status: 'verified' });
    expect(rpc.error).not.toBeNull();
  });

  test('anonymous clients (publishable key only) cannot read any table', async () => {
    const anon = createClient(config.supabase.url, config.supabase.publishableKey, { auth: { persistSession: false } });
    for (const table of ['profiles', 'user_verifications', 'audit_events']) {
      expect((await anon.from(table).select('*')).error?.code).toBe('42501');
    }
  });
});
