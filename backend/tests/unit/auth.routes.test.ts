// Route behaviour with Supabase replaced by in-memory fakes. These prove the
// API contract and error handling only, not that Supabase behaves this way;
// the integration suite covers the live project.
import { describe, expect, test } from 'vitest';
import request from 'supertest';
import { AppError } from '../../src/lib/errors.js';
import { OTHER_TOKEN, VALID_TOKEN, profileFor, session, testApp, userA, verificationsFor } from '../helpers.js';

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

describe('POST /api/v1/auth/signup', () => {
  test('returns 202 and no account details when email confirmation is required', async () => {
    const { app, gateway } = testApp();
    const res = await request(app)
      .post('/api/v1/auth/signup')
      .send({ email: '  New@Example.TEST ', password: 'correct1horse', displayName: ' Sara ' });

    expect(res.status).toBe(202);
    expect(res.body.data.emailConfirmationRequired).toBe(true);
    expect(res.body.data.user).toBeUndefined();
    expect(res.body.data.session).toBeUndefined();
    expect(gateway.signUp).toHaveBeenCalledWith({
      email: 'new@example.test',
      password: 'correct1horse',
      displayName: 'Sara',
    });
  });

  test('a duplicate registration gets the identical response (no account enumeration)', async () => {
    const { app, gateway } = testApp();
    // Supabase returns an obfuscated user and no session for existing emails.
    gateway.signUp.mockResolvedValueOnce({ user: { ...userA, id: 'obfuscated' }, session: null });
    const dup = await request(app).post('/api/v1/auth/signup').send({ email: 'a@example.test', password: 'correct1horse' });
    const fresh = await request(app).post('/api/v1/auth/signup').send({ email: 'b@example.test', password: 'correct1horse' });
    expect(dup.status).toBe(fresh.status);
    expect(dup.body.data).toEqual(fresh.body.data);
  });

  test('returns 201 with a session when the project does not require confirmation', async () => {
    const { app, gateway } = testApp();
    gateway.signUp.mockResolvedValueOnce({ user: userA, session });
    const res = await request(app).post('/api/v1/auth/signup').send({ email: 'a@example.test', password: 'correct1horse' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ emailConfirmationRequired: false, user: { id: userA.id }, session: { tokenType: 'bearer' } });
  });

  test.each([
    ['invalid email', { email: 'not-an-email', password: 'correct1horse' }, 'email'],
    ['short password', { email: 'a@example.test', password: 'abc1' }, 'password'],
    ['password without digit', { email: 'a@example.test', password: 'onlyletters' }, 'password'],
    ['password without letter', { email: 'a@example.test', password: '1234567890' }, 'password'],
    ['password over 72 bytes', { email: 'a@example.test', password: `a1${'é'.repeat(40)}` }, 'password'],
    ['display name too short', { email: 'a@example.test', password: 'correct1horse', displayName: 'x' }, 'displayName'],
    ['missing fields', {}, 'email'],
  ])('rejects %s with 400 and never calls Supabase', async (_label, body, field) => {
    const { app, gateway } = testApp();
    const res = await request(app).post('/api/v1/auth/signup').send(body);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.details.map((d: { field: string }) => d.field)).toContain(field);
    expect(gateway.signUp).not.toHaveBeenCalled();
  });

  test('never echoes the submitted password', async () => {
    const { app } = testApp();
    const res = await request(app).post('/api/v1/auth/signup').send({ email: 'x', password: 'hunter2secret' });
    expect(JSON.stringify(res.body)).not.toContain('hunter2secret');
  });

  test('ignores client attempts to set privileged fields', async () => {
    const { app, gateway } = testApp();
    await request(app)
      .post('/api/v1/auth/signup')
      .send({ email: 'a@example.test', password: 'correct1horse', accountStatus: 'active', role: 'admin', id: 'x' });
    expect(gateway.signUp).toHaveBeenCalledWith({ email: 'a@example.test', password: 'correct1horse', displayName: undefined });
  });

  test('passes provider errors through as sanitized AppErrors', async () => {
    const { app, gateway } = testApp();
    gateway.signUp.mockRejectedValueOnce(new AppError(422, 'WEAK_PASSWORD', 'Password does not meet the security requirements'));
    const res = await request(app).post('/api/v1/auth/signup').send({ email: 'a@example.test', password: 'password1' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('WEAK_PASSWORD');
  });
});

describe('POST /api/v1/auth/login', () => {
  test('returns the user and session on success', async () => {
    const { app } = testApp();
    const res = await request(app).post('/api/v1/auth/login').send({ email: 'A@example.test', password: 'whatever' });
    expect(res.status).toBe(200);
    expect(res.body.data.user.id).toBe(userA.id);
    expect(res.body.data.session).toEqual(session);
  });

  test('accepts passwords created under an older policy', async () => {
    const { app, gateway } = testApp();
    await request(app).post('/api/v1/auth/login').send({ email: 'a@example.test', password: 'short' });
    expect(gateway.signIn).toHaveBeenCalled();
  });

  test('incorrect credentials return 401 INVALID_CREDENTIALS', async () => {
    const { app, gateway } = testApp();
    gateway.signIn.mockRejectedValueOnce(AppError.unauthenticated('Invalid email or password', 'INVALID_CREDENTIALS'));
    const res = await request(app).post('/api/v1/auth/login').send({ email: 'a@example.test', password: 'wrong' });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_CREDENTIALS');
  });

  test('unconfirmed email returns 403 EMAIL_NOT_CONFIRMED', async () => {
    const { app, gateway } = testApp();
    gateway.signIn.mockRejectedValueOnce(AppError.forbidden('Email address has not been confirmed yet', 'EMAIL_NOT_CONFIRMED'));
    const res = await request(app).post('/api/v1/auth/login').send({ email: 'a@example.test', password: 'pw' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('EMAIL_NOT_CONFIRMED');
  });

  test('provider outage returns 503 without details', async () => {
    const { app, gateway } = testApp();
    gateway.signIn.mockRejectedValueOnce(AppError.unavailable('Authentication service is temporarily unavailable', 'AUTH_UNAVAILABLE'));
    const res = await request(app).post('/api/v1/auth/login').send({ email: 'a@example.test', password: 'pw' });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('AUTH_UNAVAILABLE');
  });
});

describe('POST /api/v1/auth/refresh', () => {
  test('exchanges a refresh token for a new session', async () => {
    const { app, gateway } = testApp();
    const res = await request(app).post('/api/v1/auth/refresh').send({ refreshToken: 'r1' });
    expect(res.status).toBe(200);
    expect(gateway.refresh).toHaveBeenCalledWith('r1');
  });

  test('requires a refresh token', async () => {
    const { app } = testApp();
    expect((await request(app).post('/api/v1/auth/refresh').send({})).status).toBe(400);
  });
});

describe('POST /api/v1/auth/email/resend', () => {
  test('returns the generic 202 even when the provider rejects the address', async () => {
    const { app, gateway } = testApp();
    gateway.resendSignupConfirmation.mockRejectedValueOnce(AppError.badRequest('INVALID_EMAIL', 'x'));
    const res = await request(app).post('/api/v1/auth/email/resend').send({ email: 'unknown@example.test' });
    expect(res.status).toBe(202);
  });

  test('reports rate limiting', async () => {
    const { app, gateway } = testApp();
    gateway.resendSignupConfirmation.mockRejectedValueOnce(AppError.rateLimited());
    expect((await request(app).post('/api/v1/auth/email/resend').send({ email: 'a@example.test' })).status).toBe(429);
  });
});

describe('protected routes', () => {
  test.each(['/api/v1/auth/me', '/api/v1/auth/status'])('%s without a token returns 401 UNAUTHENTICATED', async (path) => {
    const { app, gateway } = testApp();
    const res = await request(app).get(path);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHENTICATED');
    expect(res.headers['www-authenticate']).toBe('Bearer');
    expect(gateway.getUser).not.toHaveBeenCalled();
  });

  test.each([
    ['a non-bearer scheme', 'Basic dXNlcjpwYXNz'],
    ['a malformed token', 'Bearer not-a-jwt'],
    ['an empty bearer', 'Bearer '],
  ])('rejects %s without calling Supabase', async (_label, header) => {
    const { app, gateway } = testApp();
    const res = await request(app).get('/api/v1/auth/me').set('Authorization', header);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_TOKEN');
    expect(gateway.getUser).not.toHaveBeenCalled();
  });

  test('an invalid or expired token returns 401 INVALID_TOKEN', async () => {
    const { app } = testApp();
    const res = await request(app).get('/api/v1/auth/me').set(bearer(OTHER_TOKEN));
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_TOKEN');
    expect(res.headers['www-authenticate']).toBe('Bearer error="invalid_token"');
  });

  test('GET /me returns the token holder and their profile', async () => {
    const { app, profiles } = testApp();
    const res = await request(app).get('/api/v1/auth/me').set(bearer(VALID_TOKEN));
    expect(res.status).toBe(200);
    expect(res.body.data.user).toEqual(userA);
    expect(res.body.data.profile.id).toBe(userA.id);
    // The profile is read with the caller's own token, so RLS applies.
    expect(profiles.getProfile).toHaveBeenCalledWith(VALID_TOKEN, userA.id);
  });

  test('GET /me identifies the user from the token, never from the request', async () => {
    const { app, profiles } = testApp();
    await request(app)
      .get('/api/v1/auth/me?userId=someone-else')
      .set(bearer(VALID_TOKEN))
      .set('X-User-Id', 'someone-else');
    expect(profiles.getProfile).toHaveBeenCalledWith(VALID_TOKEN, userA.id);
  });

  test('GET /me fails safely if the profile is missing', async () => {
    const { app, profiles } = testApp();
    profiles.getProfile.mockResolvedValueOnce(null);
    const res = await request(app).get('/api/v1/auth/me').set(bearer(VALID_TOKEN));
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('PROFILE_MISSING');
  });

  test('GET /me reports a database outage as 503', async () => {
    const { app, profiles } = testApp();
    profiles.getProfile.mockRejectedValueOnce(AppError.unavailable('Data service is temporarily unavailable', 'DATABASE_UNAVAILABLE'));
    const res = await request(app).get('/api/v1/auth/me').set(bearer(VALID_TOKEN));
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('DATABASE_UNAVAILABLE');
  });

  test('GET /status returns derived onboarding state', async () => {
    const { app, profiles } = testApp();
    profiles.getProfile.mockResolvedValueOnce(profileFor(userA, { accountStatus: 'suspended' }));
    profiles.getVerifications.mockResolvedValueOnce(verificationsFor());
    const res = await request(app).get('/api/v1/auth/status').set(bearer(VALID_TOKEN));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      accountStatus: 'suspended',
      stage: 'email_verified',
      nextStep: 'phone_verified',
    });
  });
});

describe('POST /api/v1/auth/logout', () => {
  test('requires authentication', async () => {
    const { app, gateway } = testApp();
    expect((await request(app).post('/api/v1/auth/logout')).status).toBe(401);
    expect(gateway.signOut).not.toHaveBeenCalled();
  });

  test('revokes the current session by default and returns 204', async () => {
    const { app, gateway } = testApp();
    const res = await request(app).post('/api/v1/auth/logout').set(bearer(VALID_TOKEN));
    expect(res.status).toBe(204);
    expect(gateway.signOut).toHaveBeenCalledWith(VALID_TOKEN, 'local');
  });

  test('supports signing out every session', async () => {
    const { app, gateway } = testApp();
    await request(app).post('/api/v1/auth/logout').set(bearer(VALID_TOKEN)).send({ scope: 'global' });
    expect(gateway.signOut).toHaveBeenCalledWith(VALID_TOKEN, 'global');
  });

  test('rejects an unknown scope', async () => {
    const { app } = testApp();
    const res = await request(app).post('/api/v1/auth/logout').set(bearer(VALID_TOKEN)).send({ scope: 'everyone' });
    expect(res.status).toBe(400);
  });

  test('is idempotent when the session is already gone', async () => {
    const { app, gateway } = testApp();
    gateway.signOut.mockRejectedValueOnce(AppError.unauthenticated('Access token is invalid or expired', 'INVALID_TOKEN'));
    expect((await request(app).post('/api/v1/auth/logout').set(bearer(VALID_TOKEN))).status).toBe(204);
  });
});
