// Live checks of the auth endpoints against the configured Supabase
// development/test project. See setup.ts for the safety guard.
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

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

async function login(email: string, password: string) {
  const res = await request(app).post('/api/v1/auth/login').send({ email, password });
  expect(res.status).toBe(200);
  return res.body.data.session as { accessToken: string; refreshToken: string };
}

describe('login, current user and logout (live)', () => {
  test('full session lifecycle for a confirmed user', async () => {
    const u = await users.create({ confirmed: true, displayName: 'Live Tester' });

    const wrong = await request(app).post('/api/v1/auth/login').send({ email: u.email, password: 'wrong-password-1' });
    expect(wrong.status).toBe(401);
    expect(wrong.body.code).toBe('INVALID_CREDENTIALS');

    const session = await login(u.email.toUpperCase(), u.password);

    const me = await request(app).get('/api/v1/auth/me').set(bearer(session.accessToken));
    expect(me.status).toBe(200);
    expect(me.body.data.user).toMatchObject({ id: u.id, email: u.email });
    expect(me.body.data.user.emailConfirmedAt).not.toBeNull();
    // Provisioned by the database trigger, including the signup display name.
    expect(me.body.data.profile).toMatchObject({ id: u.id, displayName: 'Live Tester', accountStatus: 'active' });
    expect(Object.keys(me.body.data.user).sort()).toEqual(
      ['createdAt', 'email', 'emailConfirmedAt', 'id', 'lastSignInAt', 'providers'].sort(),
    );

    const status = await request(app).get('/api/v1/auth/status').set(bearer(session.accessToken));
    expect(status.status).toBe(200);
    expect(status.body.data).toMatchObject({
      accountStatus: 'active',
      stage: 'email_verified',
      nextStep: 'phone_verified',
      verifications: {
        email: { status: 'verified' },
        phone: { status: 'not_started' },
        identity: { status: 'not_started' },
      },
    });

    const refreshed = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: session.refreshToken });
    expect(refreshed.status).toBe(200);
    const newAccess = refreshed.body.data.session.accessToken as string;
    expect(newAccess).not.toBe(session.accessToken);

    const logout = await request(app).post('/api/v1/auth/logout').set(bearer(newAccess));
    expect(logout.status).toBe(204);

    // The session is revoked server-side, so its access token stops working
    // immediately rather than at expiry.
    const after = await request(app).get('/api/v1/auth/me').set(bearer(newAccess));
    expect(after.status).toBe(401);
    expect(after.body.code).toBe('INVALID_TOKEN');

    const reuse = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: refreshed.body.data.session.refreshToken });
    expect(reuse.status).toBe(401);
    expect(reuse.body.code).toBe('INVALID_REFRESH_TOKEN');

    // A revoked token can no longer reach logout (or any protected route).
    expect((await request(app).post('/api/v1/auth/logout').set(bearer(newAccess))).status).toBe(401);
  });

  test('global logout revokes every session of the user', async () => {
    const u = await users.create({ confirmed: true });
    const s1 = await login(u.email, u.password);
    const s2 = await login(u.email, u.password);

    expect((await request(app).post('/api/v1/auth/logout').set(bearer(s1.accessToken)).send({ scope: 'global' })).status).toBe(204);
    expect((await request(app).get('/api/v1/auth/me').set(bearer(s2.accessToken))).status).toBe(401);
  });

  test('a forged or tampered token is rejected', async () => {
    const u = await users.create({ confirmed: true });
    const { accessToken } = await login(u.email, u.password);
    const [h, p] = accessToken.split('.');
    const tampered = `${h}.${p}.${'A'.repeat(43)}`;
    const res = await request(app).get('/api/v1/auth/me').set(bearer(tampered));
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_TOKEN');
  });

  test('an unknown account gets the same 401 as a wrong password', async () => {
    const res = await request(app).post('/api/v1/auth/login').send({ email: TestUsers.email(), password: 'whatever-1' });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_CREDENTIALS');
  });
});

describe('email confirmation (live)', () => {
  test('an unconfirmed user cannot log in until the confirmation link is used', async () => {
    const email = TestUsers.email();
    const password = TestUsers.password();

    // Creates the user exactly as signUp does, but returns the confirmation
    // token instead of emailing it.
    const { data, error } = await admin.auth.admin.generateLink({ type: 'signup', email, password });
    expect(error).toBeNull();
    users.track(data.user!.id);
    const tokenHash = data.properties?.hashed_token;
    expect(tokenHash).toBeTruthy();

    const blocked = await request(app).post('/api/v1/auth/login').send({ email, password });
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('EMAIL_NOT_CONFIRMED');

    const { data: rows } = await admin
      .from('user_verifications')
      .select('status')
      .eq('user_id', data.user!.id)
      .eq('verification_type', 'email')
      .single();
    expect(rows?.status).toBe('pending');

    // What clicking the email link does.
    const verified = await anonClient(config).auth.verifyOtp({ type: 'email', token_hash: tokenHash as string });
    expect(verified.error).toBeNull();

    const session = await login(email, password);
    const status = await request(app).get('/api/v1/auth/status').set(bearer(session.accessToken));
    expect(status.body.data.verifications.email.status).toBe('verified');

    // The database trigger mirrored the confirmation.
    const { data: after } = await admin
      .from('user_verifications')
      .select('status, verified_at, provider_name')
      .eq('user_id', data.user!.id)
      .eq('verification_type', 'email')
      .single();
    expect(after).toMatchObject({ status: 'verified', provider_name: 'supabase_auth' });
    expect(after?.verified_at).not.toBeNull();
  });
});
