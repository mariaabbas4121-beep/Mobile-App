// The real Supabase SDK and adapters, pointed at a port where nothing is
// listening, to check that an unreachable Supabase produces safe 503s rather
// than crashes or leaked internals. No real Supabase project is involved.
import { describe, expect, test } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { createSupabaseClients } from '../../src/config/supabase.js';
import { createSupabaseAuthGateway } from '../../src/auth/supabase-auth.gateway.js';
import { createSupabaseProfileRepository } from '../../src/auth/supabase-profile.repository.js';
import { AppError } from '../../src/lib/errors.js';
import { silentLogger, testConfig, VALID_TOKEN } from '../helpers.js';

// Port 9 (discard) on loopback: connections are refused immediately.
const config = testConfig({
  supabase: { url: 'http://127.0.0.1:9', publishableKey: 'sb_publishable_unit_test_placeholder_key', secretKey: undefined },
});
const clients = createSupabaseClients(config);
// A short deadline keeps the test fast; production uses AUTH_OPERATION_DEADLINE_MS.
const gateway = createSupabaseAuthGateway(clients, config, silentLogger, { deadlineMs: 1500 });
const profiles = createSupabaseProfileRepository(clients, silentLogger);
const app = createApp({ config, logger: silentLogger, authGateway: gateway, profiles });

const SAFE_BODY_KEYS = ['code', 'message', 'requestId', 'success'];

describe('Supabase unreachable', () => {
  test.each([
    ['login', () => request(app).post('/api/v1/auth/login').send({ email: 'a@example.test', password: 'pw' })],
    ['signup', () => request(app).post('/api/v1/auth/signup').send({ email: 'a@example.test', password: 'correct1horse' })],
    ['refresh', () => request(app).post('/api/v1/auth/refresh').send({ refreshToken: 'r' })],
    ['me', () => request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${VALID_TOKEN}`)],
  ])('%s returns 503 AUTH_UNAVAILABLE promptly with no internals', async (_label, call) => {
    const started = Date.now();
    const res = await call();
    expect(Date.now() - started).toBeLessThan(5000);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('AUTH_UNAVAILABLE');
    expect(Object.keys(res.body).sort()).toEqual(SAFE_BODY_KEYS);
    expect(JSON.stringify(res.body)).not.toMatch(/127\.0\.0\.1|ECONNREFUSED|fetch failed/i);
  }, 20_000);

  test('resend still reports the outage rather than pretending to succeed', async () => {
    const res = await request(app).post('/api/v1/auth/email/resend').send({ email: 'a@example.test' });
    expect(res.status).toBe(503);
  }, 20_000);

  test('database reads fail with 503 DATABASE_UNAVAILABLE', async () => {
    const err = await profiles.getProfile(VALID_TOKEN, '00000000-0000-4000-8000-00000000000a').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).status).toBe(503);
    expect((err as AppError).code).toBe('DATABASE_UNAVAILABLE');
  }, 20_000);

  test('the health check is unaffected', async () => {
    expect((await request(app).get('/api/v1/health')).status).toBe(200);
  });
});
