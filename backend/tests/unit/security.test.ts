// Stage E controls with Supabase replaced by fakes: rate limits, account
// status enforcement, role-based authorization and the profile update route.
import { describe, expect, test } from 'vitest';
import express from 'express';
import request from 'supertest';
import { pinoHttp } from 'pino-http';
import { DEFAULT_RATE_LIMITS, type RateLimitPolicy } from '../../src/middleware/rate-limit.middleware.js';
import { requireAuth, requireRole } from '../../src/middleware/auth.middleware.js';
import { errorHandler } from '../../src/middleware/error.middleware.js';
import { AppError } from '../../src/lib/errors.js';
import { VALID_TOKEN, fakeGateway, profileFor, silentLogger, testApp, userA } from '../helpers.js';

const bearer = { Authorization: `Bearer ${VALID_TOKEN}` };

const tight = (overrides: Partial<RateLimitPolicy>): RateLimitPolicy => ({ ...DEFAULT_RATE_LIMITS, ...overrides });
const rule = (limit: number) => ({ windowMs: 60_000, limit });

describe('rate limiting', () => {
  test('signup is limited per IP and returns a structured 429 with Retry-After', async () => {
    const { app, gateway } = testApp({ rateLimits: tight({ signupPerIp: rule(2) }) });
    const body = { email: 'a@example.test', password: 'correct1horse' };
    expect((await request(app).post('/api/v1/auth/signup').send(body)).status).toBe(202);
    expect((await request(app).post('/api/v1/auth/signup').send(body)).status).toBe(202);
    const blocked = await request(app).post('/api/v1/auth/signup').send(body);
    expect(blocked.status).toBe(429);
    expect(blocked.body).toMatchObject({ success: false, code: 'RATE_LIMITED' });
    expect(blocked.headers['retry-after']).toBeDefined();
    expect(blocked.headers['ratelimit']).toBeDefined();
    expect(gateway.signUp).toHaveBeenCalledTimes(2);
  });

  test('invalid payloads still count against the per-IP limit', async () => {
    const { app } = testApp({ rateLimits: tight({ signupPerIp: rule(1) }) });
    expect((await request(app).post('/api/v1/auth/signup').send({})).status).toBe(400);
    expect((await request(app).post('/api/v1/auth/signup').send({})).status).toBe(429);
  });

  test('failed logins are limited per account, across differently-cased emails', async () => {
    const { app, gateway } = testApp({ rateLimits: tight({ loginFailuresPerAccount: rule(2) }) });
    gateway.signIn.mockRejectedValue(AppError.unauthenticated('Invalid email or password', 'INVALID_CREDENTIALS'));
    expect((await request(app).post('/api/v1/auth/login').send({ email: 'a@example.test', password: 'x' })).status).toBe(401);
    expect((await request(app).post('/api/v1/auth/login').send({ email: 'A@Example.test', password: 'x' })).status).toBe(401);
    const blocked = await request(app).post('/api/v1/auth/login').send({ email: ' a@example.TEST', password: 'x' });
    expect(blocked.status).toBe(429);
    expect(gateway.signIn).toHaveBeenCalledTimes(2);

    // Another account from the same client is unaffected.
    expect((await request(app).post('/api/v1/auth/login').send({ email: 'b@example.test', password: 'x' })).status).toBe(401);
  });

  test('successful logins do not use up the per-account failure budget', async () => {
    const { app } = testApp({ rateLimits: tight({ loginFailuresPerAccount: rule(1) }) });
    for (let i = 0; i < 3; i++) {
      expect((await request(app).post('/api/v1/auth/login').send({ email: 'a@example.test', password: 'pw' })).status).toBe(200);
    }
  });

  test('login is limited per IP regardless of account', async () => {
    const { app } = testApp({ rateLimits: tight({ loginPerIp: rule(2) }) });
    await request(app).post('/api/v1/auth/login').send({ email: 'a@example.test', password: 'pw' });
    await request(app).post('/api/v1/auth/login').send({ email: 'b@example.test', password: 'pw' });
    expect((await request(app).post('/api/v1/auth/login').send({ email: 'c@example.test', password: 'pw' })).status).toBe(429);
  });

  test('confirmation resends are limited per account', async () => {
    const { app } = testApp({ rateLimits: tight({ resendPerAccount: rule(1) }) });
    expect((await request(app).post('/api/v1/auth/email/resend').send({ email: 'a@example.test' })).status).toBe(202);
    expect((await request(app).post('/api/v1/auth/email/resend').send({ email: 'a@example.test' })).status).toBe(429);
  });

  test('refresh is limited per IP', async () => {
    const { app } = testApp({ rateLimits: tight({ refreshPerIp: rule(1) }) });
    expect((await request(app).post('/api/v1/auth/refresh').send({ refreshToken: 'r' })).status).toBe(200);
    expect((await request(app).post('/api/v1/auth/refresh').send({ refreshToken: 'r' })).status).toBe(429);
  });

  test('separate app instances do not share counters', async () => {
    const policy = tight({ signupPerIp: rule(1) });
    const a = testApp({ rateLimits: policy }).app;
    const b = testApp({ rateLimits: policy }).app;
    await request(a).post('/api/v1/auth/signup').send({});
    expect((await request(b).post('/api/v1/auth/signup').send({})).status).toBe(400);
  });
});

describe('PATCH /api/v1/profile/me', () => {
  test('updates allowed fields for the token holder only', async () => {
    const { app, profiles } = testApp();
    const res = await request(app)
      .patch('/api/v1/profile/me')
      .set(bearer)
      .send({ displayName: ' Zara ', city: 'Karachi', bio: null });
    expect(res.status).toBe(200);
    expect(res.body.data.profile.displayName).toBe('Zara');
    expect(profiles.updateProfile).toHaveBeenCalledWith(VALID_TOKEN, userA.id, { displayName: 'Zara', city: 'Karachi', bio: null });
  });

  test.each([
    ['accountStatus', { accountStatus: 'active' }],
    ['phoneVerifiedAt', { phoneVerifiedAt: '2026-01-01T00:00:00Z' }],
    ['profileCompletedAt', { profileCompletedAt: '2026-01-01T00:00:00Z' }],
    ['id', { id: '00000000-0000-4000-8000-00000000000b' }],
    ['verification status', { identityVerification: 'verified' }],
  ])('rejects the protected field %s with 400', async (_label, body) => {
    const { app, profiles } = testApp();
    const res = await request(app).patch('/api/v1/profile/me').set(bearer).send({ displayName: 'Zara', ...body });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(profiles.updateProfile).not.toHaveBeenCalled();
  });

  test.each([
    ['empty body', {}],
    ['blank name', { displayName: '   ' }],
    ['too long city', { city: 'x'.repeat(81) }],
    ['control characters', { bio: 'hi\u0000there' }],
    ['wrong type', { displayName: 42 }],
  ])('rejects %s', async (_label, body) => {
    const { app } = testApp();
    expect((await request(app).patch('/api/v1/profile/me').set(bearer).send(body)).status).toBe(400);
  });

  test('requires authentication', async () => {
    const { app } = testApp();
    expect((await request(app).patch('/api/v1/profile/me').send({ displayName: 'Zara' })).status).toBe(401);
  });

  test.each([
    ['suspended', 'ACCOUNT_SUSPENDED'],
    ['deletion_pending', 'ACCOUNT_DELETION_PENDING'],
  ] as const)('a %s account gets 403 %s and nothing is written', async (status, code) => {
    const { app, profiles } = testApp();
    profiles.getProfile.mockResolvedValue(profileFor(userA, { accountStatus: status }));
    const res = await request(app).patch('/api/v1/profile/me').set(bearer).send({ displayName: 'Zara' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe(code);
    expect(profiles.updateProfile).not.toHaveBeenCalled();
  });

  test('a restricted account may still edit its profile', async () => {
    const { app, profiles } = testApp();
    profiles.getProfile.mockResolvedValue(profileFor(userA, { accountStatus: 'restricted' }));
    expect((await request(app).patch('/api/v1/profile/me').set(bearer).send({ displayName: 'Zara' })).status).toBe(200);
  });

  test('if the database refuses the row (status changed mid-request) the API returns 403', async () => {
    const { app, profiles } = testApp();
    profiles.updateProfile.mockResolvedValueOnce(null);
    expect((await request(app).patch('/api/v1/profile/me').set(bearer).send({ displayName: 'Zara' })).status).toBe(403);
  });
});

describe('requireRole', () => {
  function adminOnlyApp(roles: string[]) {
    const gateway = fakeGateway();
    gateway.getUser.mockResolvedValue({ user: userA, roles });
    const app = express();
    app.use(pinoHttp({ logger: silentLogger }));
    app.get('/admin', requireAuth(gateway), requireRole('admin'), (_req, res) => {
      res.json({ ok: true });
    });
    app.use(errorHandler);
    return app;
  }

  test('distinguishes unauthenticated (401) from unauthorized (403)', async () => {
    const app = adminOnlyApp([]);
    expect((await request(app).get('/admin')).status).toBe(401);
    const res = await request(app).get('/admin').set(bearer);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });

  test('allows a caller whose server-side roles include the role', async () => {
    expect((await request(adminOnlyApp(['admin'])).get('/admin').set(bearer)).status).toBe(200);
  });

  test('ignores roles claimed in the request', async () => {
    const res = await request(adminOnlyApp([]))
      .get('/admin?role=admin')
      .set(bearer)
      .set('X-Role', 'admin');
    expect(res.status).toBe(403);
  });

  test('roles are never exposed by /me', async () => {
    const { app, gateway } = testApp();
    gateway.getUser.mockResolvedValue({ user: userA, roles: ['admin'] });
    const res = await request(app).get('/api/v1/auth/me').set(bearer);
    expect(JSON.stringify(res.body)).not.toContain('admin');
  });
});

describe('logging', () => {
  // Request logs carry only method, path and status: no headers, bodies or
  // query strings. Unexpected (500) errors are logged with their message for
  // operators, so server code must never put secrets into error messages.
  test('request logs never contain tokens, Authorization headers, bodies or query strings', async () => {
    const lines: string[] = [];
    const { createApp } = await import('../../src/app.js');
    const { pino } = await import('pino');
    const { REDACT_PATHS } = await import('../../src/lib/logger.js');
    const logger = pino(
      { level: 'trace', redact: { paths: REDACT_PATHS, censor: '[REDACTED]' } },
      { write: (line: string) => void lines.push(line) },
    );
    const { testConfig, fakeProfiles } = await import('../helpers.js');
    const gateway = fakeGateway();
    gateway.signIn.mockRejectedValueOnce(new Error('unexpected failure'));
    const app = createApp({ config: testConfig(), logger, authGateway: gateway, profiles: fakeProfiles() });

    await request(app).post('/api/v1/auth/login?token=leak-me').send({ email: 'secret@example.test', password: 'hunter2pass' });
    await request(app).get('/api/v1/auth/me').set(bearer);

    const output = lines.join('\n');
    expect(lines.length).toBeGreaterThan(0);
    expect(output).not.toContain(VALID_TOKEN);
    expect(output).not.toContain('leak-me');
    expect(output).not.toContain('Bearer');
    expect(output).not.toContain('hunter2pass');
    expect(output).not.toContain('secret@example.test');
    // The unexpected error is logged for operators but its message never
    // reaches the client.
    expect(output).toContain('request failed');
  });
});
