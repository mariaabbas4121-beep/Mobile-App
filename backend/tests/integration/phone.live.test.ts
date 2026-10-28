// Live phone verification checks against the development/test project.
//
// These never send an SMS. They check what can be checked without one:
//   - while the Phone provider is disabled, start refuses with 503 and
//     records nothing (skipped once the provider is enabled, so a routine
//     run cannot text a real number)
//   - with the phone migration applied, a user's own token cannot call the
//     phone_verification_* functions or write the phone columns directly.
// Delivery and a full OTP round trip are manual tests (docs/TESTING.md).
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { adminClient, integrationConfig, liveApp, TestUsers } from './setup.js';
import type { Config } from '../../src/config/env.js';

let config: Config;
let app: Express;
let users: TestUsers;
let phoneEnabled = false;
let migrationApplied = false;

// Reserved for fiction in many numbering plans; never a real subscriber.
const UNUSED_NUMBER = '+15555550123';

beforeAll(async () => {
  config = integrationConfig();
  app = liveApp(config);
  const admin = adminClient(config);
  users = new TestUsers(admin);

  const res = await fetch(`${config.supabase.url}/auth/v1/settings`, { headers: { apikey: config.supabase.publishableKey } });
  const settings = (await res.json()) as { external?: { phone?: boolean } };
  phoneEnabled = settings.external?.phone === true;

  const probe = await admin.from('profiles').select('pending_phone_e164').limit(1);
  migrationApplied = !probe.error;
});

afterAll(async () => {
  await users?.cleanup();
});

async function signedIn() {
  const u = await users.create({ confirmed: true });
  const res = await request(app).post('/api/v1/auth/login').send({ email: u.email, password: u.password });
  expect(res.status).toBe(200);
  const token = res.body.data.session.accessToken as string;
  const db: SupabaseClient = createClient(config.supabase.url, config.supabase.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  return { id: u.id, token, db };
}

describe('phone verification (live)', () => {
  test('with the Phone provider disabled, start returns 503 and sends nothing', async (ctx) => {
    if (phoneEnabled) ctx.skip();
    const { token } = await signedIn();
    const res = await request(app).post('/api/v1/verification/phone/start').set('Authorization', `Bearer ${token}`).send({ phone: UNUSED_NUMBER });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('PHONE_VERIFICATION_NOT_CONFIGURED');
    expect(res.body.details).toEqual({ reason: 'phone_provider_disabled' });
  });

  test('without the phone migration, the status endpoint names the missing migration', async (ctx) => {
    if (migrationApplied) ctx.skip();
    const { token } = await signedIn();
    const res = await request(app).get('/api/v1/verification/phone').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('PHONE_VERIFICATION_NOT_CONFIGURED');
    expect(res.body.details).toEqual({ reason: 'database_migration_missing' });
  });

  test("a user's own token cannot call the phone functions or write phone columns", async (ctx) => {
    if (!migrationApplied) ctx.skip();
    const { id, db } = await signedIn();
    const rpc = await db.rpc('phone_verification_complete', {
      p_user_id: id,
      p_phone: UNUSED_NUMBER,
      p_verified_at: new Date().toISOString(),
    });
    expect(rpc.error).not.toBeNull();

    const write = await db.from('profiles').update({ pending_phone_e164: UNUSED_NUMBER }).eq('id', id).select('id');
    expect(write.error?.code).toBe('42501');

    const row = await db.from('user_verifications').select('status').eq('verification_type', 'phone').single();
    expect(row.data?.status).toBe('not_started');
  });
});
