// Live signup and reliability checks against the development/test project.
//
// Supabase's signup rejects reserved test domains, so a real new-account
// signup needs a real mailbox and sends a real confirmation email. That test
// is opt-in: set INTEGRATION_SIGNUP_EMAIL in backend/.env to an address you
// own (with Supabase's built-in mailer it must belong to a project team
// member). It is skipped if that address already has an account, so it can
// never delete a real account during cleanup.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import { adminClient, anonClient, integrationConfig, liveApp, TestUsers } from './setup.js';
import type { Config } from '../../src/config/env.js';

let config: Config;
let app: Express;
let admin: SupabaseClient;
let users: TestUsers;

beforeAll(() => {
  config = integrationConfig();
  app = liveApp(config);
  admin = adminClient(config);
  users = new TestUsers(admin);
});

afterAll(async () => {
  await users?.cleanup();
});

// Supabase applies its email-sending rate limit to every signup call (only a
// few per hour with the built-in mailer). When it is hit, the API correctly
// answers 429 RATE_LIMITED, but the behaviour under test cannot be observed,
// so the test is skipped (reported as skipped, never as passed).
const EMAIL_LIMIT_HINT =
  'Supabase email-send rate limit reached; raise it under Authentication -> Rate Limits on the dev project, configure custom SMTP, or retry later';

function skipIfSupabaseLimited(ctx: { skip: (note?: string) => never }, ...responses: { status: number; body: { code?: string } }[]) {
  for (const r of responses) {
    if (r.status === 429) {
      expect(r.body.code).toBe('RATE_LIMITED');
      ctx.skip(EMAIL_LIMIT_HINT);
    }
  }
}

async function usersWithEmail(email: string) {
  const { data, error } = await admin.auth.admin.listUsers({ perPage: 1000 });
  if (error) throw new Error(`listUsers failed: ${error.code}`);
  return data.users.filter((u) => u.email === email.toLowerCase());
}

async function rowCounts(userId: string) {
  const [p, v] = await Promise.all([
    admin.from('profiles').select('id', { count: 'exact', head: true }).eq('id', userId),
    admin.from('user_verifications').select('id', { count: 'exact', head: true }).eq('user_id', userId),
  ]);
  return { profiles: p.count, verifications: v.count };
}

describe('duplicate registration (live)', () => {
  test('signing up an existing confirmed email returns the generic 202 and creates nothing', async (ctx) => {
    const existing = await users.create({ confirmed: true, displayName: 'Original' });
    const res = await request(app).post('/api/v1/auth/signup').send({ email: existing.email, password: 'Another-pass-1', displayName: 'Imposter' });
    skipIfSupabaseLimited(ctx, res);

    expect(res.status).toBe(202);
    expect(res.body.data.emailConfirmationRequired).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain(existing.id);

    expect(await usersWithEmail(existing.email)).toHaveLength(1);
    expect(await rowCounts(existing.id)).toEqual({ profiles: 1, verifications: 3 });
    const { data } = await admin.from('profiles').select('display_name').eq('id', existing.id).single();
    expect(data?.display_name).toBe('Original');

    // The original password still works; the duplicate attempt changed nothing.
    expect((await request(app).post('/api/v1/auth/login').send({ email: existing.email, password: existing.password })).status).toBe(200);
    expect((await request(app).post('/api/v1/auth/login').send({ email: existing.email, password: 'Another-pass-1' })).status).toBe(401);
  });

  test('concurrent duplicate signups stay consistent', async (ctx) => {
    const existing = await users.create({ confirmed: true });
    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        request(app).post('/api/v1/auth/signup').send({ email: existing.email, password: 'Racing-pass-1' }),
      ),
    );
    // Consistency must hold whatever Supabase answered.
    expect(await usersWithEmail(existing.email)).toHaveLength(1);
    expect(await rowCounts(existing.id)).toEqual({ profiles: 1, verifications: 3 });
    skipIfSupabaseLimited(ctx, ...responses);
    expect(responses.map((r) => r.status)).toEqual([202, 202, 202, 202, 202]);
  });
});

describe('Supabase-side validation (live)', () => {
  test('an address Supabase refuses is reported as a clean 400, with no user created', async (ctx) => {
    const email = TestUsers.email(); // reserved .test domain
    const res = await request(app).post('/api/v1/auth/signup').send({ email, password: 'Valid-pass-123' });
    expect(await usersWithEmail(email)).toHaveLength(0);
    skipIfSupabaseLimited(ctx, res);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_EMAIL');
    expect(Object.keys(res.body).sort()).toEqual(['code', 'message', 'requestId', 'success']);
    expect(await usersWithEmail(email)).toHaveLength(0);
  });
});

describe('email confirmation retries (live)', () => {
  test('redeeming a confirmation link twice is refused and records one verification', async () => {
    const email = TestUsers.email();
    const password = TestUsers.password();
    const { data, error } = await admin.auth.admin.generateLink({ type: 'signup', email, password });
    expect(error).toBeNull();
    users.track(data.user!.id);
    const tokenHash = data.properties?.hashed_token as string;

    const first = await anonClient(config).auth.verifyOtp({ type: 'email', token_hash: tokenHash });
    expect(first.error).toBeNull();
    const second = await anonClient(config).auth.verifyOtp({ type: 'email', token_hash: tokenHash });
    expect(second.error).not.toBeNull();

    const { count } = await admin
      .from('audit_events')
      .select('id', { count: 'exact', head: true })
      .eq('event_type', 'verification.status_changed')
      .eq('metadata->>user_id', data.user!.id)
      .eq('metadata->>to', 'verified');
    expect(count).toBe(1);

    const { data: row } = await admin
      .from('user_verifications')
      .select('status')
      .eq('user_id', data.user!.id)
      .eq('verification_type', 'email')
      .single();
    expect(row?.status).toBe('verified');
  });

  test('re-confirming an already confirmed user through the admin API changes nothing', async () => {
    const u = await users.create({ confirmed: true });
    const before = await admin.from('user_verifications').select('verified_at').eq('user_id', u.id).eq('verification_type', 'email').single();
    const { error } = await admin.auth.admin.updateUserById(u.id, { email_confirm: true });
    expect(error).toBeNull();
    const after = await admin.from('user_verifications').select('verified_at').eq('user_id', u.id).eq('verification_type', 'email').single();
    expect(after.data?.verified_at).toBe(before.data?.verified_at);
  });
});

const signupEmail = process.env.INTEGRATION_SIGNUP_EMAIL?.trim().toLowerCase();

describe.skipIf(!signupEmail)('real signup with email delivery (live, opt-in)', () => {
  test('creates an unconfirmed user with a profile and sends a confirmation email', async (ctx) => {
    const email = signupEmail as string;
    if ((await usersWithEmail(email)).length > 0) {
      ctx.skip('INTEGRATION_SIGNUP_EMAIL already has an account; refusing to touch it');
    }

    const res = await request(app).post('/api/v1/auth/signup').send({ email, password: TestUsers.password(), displayName: 'Opt In' });
    const created = await usersWithEmail(email);
    for (const u of created) users.track(u.id); // removed again in afterAll
    skipIfSupabaseLimited(ctx, res);

    if (res.status === 503) {
      expect(res.body.code).toBe('EMAIL_DELIVERY_UNAVAILABLE');
      throw new Error('Supabase could not send the email: configure custom SMTP or use a team-member address');
    }
    expect(res.status).toBe(202);
    expect(created).toHaveLength(1);
    expect(created[0]?.email_confirmed_at ?? null).toBeNull();
    expect(created[0]?.confirmation_sent_at).toBeTruthy();
    expect(await rowCounts(created[0]!.id)).toEqual({ profiles: 1, verifications: 3 });

    // A retried signup (e.g. the user tapped twice) does not duplicate anything.
    const retry = await request(app).post('/api/v1/auth/signup').send({ email, password: TestUsers.password() });
    expect([202, 429]).toContain(retry.status);
    expect(await usersWithEmail(email)).toHaveLength(1);

    const login = await request(app).post('/api/v1/auth/login').send({ email, password: 'irrelevant-1' });
    expect(login.status).toBe(401);
  });
});
