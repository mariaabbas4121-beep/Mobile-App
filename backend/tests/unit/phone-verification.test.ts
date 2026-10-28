// Phone verification routes and service, with Supabase Auth and the database
// replaced by in-memory models (tests/helpers.ts). They prove the API
// contract and the trust rules, not Supabase's behaviour; no SMS is sent.
import { describe, expect, test } from 'vitest';
import request from 'supertest';
import { pino } from 'pino';
import { createApp } from '../../src/app.js';
import { AppError } from '../../src/lib/errors.js';
import { REDACT_PATHS } from '../../src/lib/logger.js';
import { DEFAULT_RATE_LIMITS, type RateLimitPolicy } from '../../src/middleware/rate-limit.middleware.js';
import { createPhoneVerificationService } from '../../src/verification/phone-verification.service.js';
import { hasAllowedCountryCode, maskPhone, normalisePhone, phoneConfirmBody, phoneStartBody } from '../../src/verification/phone.js';
import {
  FAKE_OTP,
  OTHER_TOKEN,
  VALID_TOKEN,
  fakeGateway,
  fakePhoneAuth,
  fakeProfiles,
  memoryPhoneStore,
  profileFor,
  testApp,
  testConfig,
  userA,
} from '../helpers.js';

const bearer = { Authorization: `Bearer ${VALID_TOKEN}` };
const PHONE = '+923001234567';
const START = '/api/v1/verification/phone/start';
const RESEND = '/api/v1/verification/phone/resend';
const CONFIRM = '/api/v1/verification/phone/confirm';
const STATUS = '/api/v1/verification/phone';

const tight = (overrides: Partial<RateLimitPolicy>): RateLimitPolicy => ({ ...DEFAULT_RATE_LIMITS, ...overrides });
const rule = (limit: number) => ({ windowMs: 60_000, limit });

// A controllable clock for cooldown tests.
function clock(start = Date.parse('2026-10-26T12:00:00Z')) {
  let t = start;
  return { now: () => t, advance: (seconds: number) => (t += seconds * 1000) };
}

describe('phone number parsing', () => {
  test.each([
    ['+923001234567', '+923001234567'],
    [' +92 300-123 4567 ', '+923001234567'],
    ['(+92) 300.123.4567', '+923001234567'],
    ['00923001234567', '+923001234567'],
  ])('normalises %j to E.164', (input, expected) => {
    expect(phoneStartBody.parse({ phone: input })).toEqual({ phone: expected });
    expect(normalisePhone(input)).toBe(expected);
  });

  test.each([
    ['national format without country code', '03001234567'],
    ['country code starting with 0', '+0923001234567'],
    ['letters', '+92300ABC4567'],
    ['too short', '+9230012'],
    ['too long', '+9230012345678901'],
    ['not a string', 923001234567],
    ['empty', ''],
  ])('rejects %s', (_label, phone) => {
    expect(phoneStartBody.safeParse({ phone }).success).toBe(false);
  });

  test('confirm accepts only a 6 to 10 digit code', () => {
    expect(phoneConfirmBody.safeParse({ phone: PHONE, code: '123456' }).success).toBe(true);
    expect(phoneConfirmBody.safeParse({ phone: PHONE, code: ' 1234567890 ' }).success).toBe(true);
    for (const code of ['12345', '12345678901', '12a456', '', 123456]) {
      expect(phoneConfirmBody.safeParse({ phone: PHONE, code }).success).toBe(false);
    }
  });

  test('masks all but the country prefix and last four digits', () => {
    expect(maskPhone('+923001234567')).toBe('+92••••••4567');
    expect(maskPhone(null)).toBeNull();
  });

  test('country allow-list matches calling-code prefixes', () => {
    expect(hasAllowedCountryCode('+923001234567', [])).toBe(true);
    expect(hasAllowedCountryCode('+923001234567', ['92'])).toBe(true);
    expect(hasAllowedCountryCode('+14155550100', ['92', '971'])).toBe(false);
  });
});

describe('authentication and account status', () => {
  test.each([
    ['post', START, { phone: PHONE }],
    ['post', RESEND, {}],
    ['post', CONFIRM, { phone: PHONE, code: FAKE_OTP }],
    ['get', STATUS, undefined],
  ] as const)('%s %s requires a token and never reaches Supabase without one', async (method, path, body) => {
    const { app, phoneAuth } = testApp();
    const req = method === 'get' ? request(app).get(path) : request(app).post(path).send(body);
    const res = await req;
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHENTICATED');
    expect(phoneAuth.requestPhoneChange).not.toHaveBeenCalled();
    expect(phoneAuth.verifyPhoneChange).not.toHaveBeenCalled();
  });

  test('an expired or revoked token returns 401 INVALID_TOKEN', async () => {
    const { app } = testApp();
    const res = await request(app).post(START).set({ Authorization: `Bearer ${OTHER_TOKEN}` }).send({ phone: PHONE });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_TOKEN');
  });

  test.each([
    ['suspended', 'ACCOUNT_SUSPENDED'],
    ['deletion_pending', 'ACCOUNT_DELETION_PENDING'],
  ] as const)('a %s account cannot start or confirm, but can read its status', async (status, code) => {
    const { app, profiles, phoneAuth } = testApp();
    profiles.getProfile.mockResolvedValue(profileFor(userA, { accountStatus: status }));
    const start = await request(app).post(START).set(bearer).send({ phone: PHONE });
    const confirm = await request(app).post(CONFIRM).set(bearer).send({ phone: PHONE, code: FAKE_OTP });
    expect([start.status, start.body.code]).toEqual([403, code]);
    expect([confirm.status, confirm.body.code]).toEqual([403, code]);
    expect(phoneAuth.requestPhoneChange).not.toHaveBeenCalled();
    expect((await request(app).get(STATUS).set(bearer)).status).toBe(200);
  });

  test('a restricted account can verify its phone', async () => {
    const { app, profiles } = testApp();
    profiles.getProfile.mockResolvedValue(profileFor(userA, { accountStatus: 'restricted' }));
    expect((await request(app).post(START).set(bearer).send({ phone: PHONE })).status).toBe(202);
  });
});

describe('POST /verification/phone/start', () => {
  test('asks Supabase to send a code and records only a pending state', async () => {
    const { app, phoneAuth, phoneStore } = testApp();
    const res = await request(app).post(START).set(bearer).send({ phone: '+92 300 123 4567' });

    expect(res.status).toBe(202);
    expect(res.body.data).toMatchObject({
      codeSent: true,
      message: 'If this number can receive text messages, a verification code is on its way.',
      verification: { status: 'pending', verifiedAt: null, phone: null, pendingPhone: '+92••••••4567', codeLength: 6 },
    });
    expect(res.body.data.verification.resendAvailableAt).toEqual(expect.any(String));
    // The caller's own token authorises the change; the number is normalised.
    expect(phoneAuth.requestPhoneChange).toHaveBeenCalledWith(VALID_TOKEN, PHONE);
    expect(phoneStore.markPending).toHaveBeenCalledWith(userA.id, PHONE, false);
    expect(phoneStore.complete).not.toHaveBeenCalled();
    // The full number is not echoed back.
    expect(JSON.stringify(res.body)).not.toContain('3001234567');
  });

  test.each([
    ['malformed number', { phone: '0300-1234567' }],
    ['missing number', {}],
    ['a client-asserted verified flag', { phone: PHONE, verified: true }],
    ['a client-chosen status', { phone: PHONE, status: 'verified' }],
    ['another user id', { phone: PHONE, userId: 'someone-else' }],
  ])('rejects %s with 400 before contacting Supabase', async (_label, body) => {
    const { app, phoneAuth, phoneStore } = testApp();
    const res = await request(app).post(START).set(bearer).send(body);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(phoneAuth.requestPhoneChange).not.toHaveBeenCalled();
    expect(phoneStore.markPending).not.toHaveBeenCalled();
  });

  test('refuses countries outside PHONE_ALLOWED_COUNTRY_CODES', async () => {
    const config = testConfig({ phoneVerification: { resendCooldownSeconds: 60, otpLength: 6, allowedCountryCodes: ['92'] } });
    const { app, phoneAuth } = testApp({ config });
    const res = await request(app).post(START).set(bearer).send({ phone: '+14155550100' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PHONE_COUNTRY_NOT_SUPPORTED');
    expect(phoneAuth.requestPhoneChange).not.toHaveBeenCalled();
  });

  test.each([
    ['the Phone provider is disabled', { phoneEnabled: false, autoconfirm: false }, 'phone_provider_disabled'],
    ['phone confirmations are off (numbers would be accepted without a code)', { phoneEnabled: true, autoconfirm: true }, 'phone_confirmations_disabled'],
  ])('returns 503 NOT_CONFIGURED naming the setting, and sends nothing, when %s', async (_label, settings, reason) => {
    const { app, phoneAuth, phoneStore } = testApp();
    phoneAuth.getSettings.mockResolvedValue(settings);
    const res = await request(app).post(START).set(bearer).send({ phone: PHONE });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('PHONE_VERIFICATION_NOT_CONFIGURED');
    expect(res.body.details).toEqual({ reason });
    expect(phoneAuth.requestPhoneChange).not.toHaveBeenCalled();
    expect(phoneStore.markPending).not.toHaveBeenCalled();
  });

  test('an SMS provider failure is a safe 503, and the user may retry at once', async () => {
    const { app, phoneAuth, phoneStore } = testApp();
    phoneAuth.requestPhoneChange.mockRejectedValueOnce(
      AppError.unavailable('We could not send a text message right now', 'SMS_DELIVERY_UNAVAILABLE'),
    );
    const failed = await request(app).post(START).set(bearer).send({ phone: PHONE });
    expect(failed.status).toBe(503);
    expect(failed.body.code).toBe('SMS_DELIVERY_UNAVAILABLE');
    expect(Object.keys(failed.body).sort()).toEqual(['code', 'message', 'requestId', 'success']);
    expect(phoneStore.markPending).not.toHaveBeenCalled();
    expect(phoneStore.releaseSend).toHaveBeenCalledWith(userA.id);

    expect((await request(app).post(START).set(bearer).send({ phone: PHONE })).status).toBe(202);
  });

  test('a Supabase that changes the phone without an OTP is treated as misconfigured, not verified', async () => {
    const { app, phoneAuth, phoneStore } = testApp();
    phoneAuth.requestPhoneChange.mockResolvedValueOnce({
      userId: userA.id,
      phone: PHONE,
      phoneConfirmedAt: '2026-10-26T12:00:00Z',
      pendingPhone: null,
    });
    const res = await request(app).post(START).set(bearer).send({ phone: PHONE });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('PHONE_VERIFICATION_NOT_CONFIGURED');
    expect(res.body.details).toEqual({ reason: 'phone_confirmations_disabled' });
    expect(phoneStore.markPending).not.toHaveBeenCalled();
    expect(phoneStore.complete).not.toHaveBeenCalled();
  });

  test("a number on another account gets the same answer as a free one, and can't be confirmed", async () => {
    const { app, phoneAuth, phoneStore } = testApp();
    phoneAuth.addUser('00000000-0000-4000-8000-00000000000b', OTHER_TOKEN, '+923009876543');

    const taken = await request(app).post(START).set(bearer).send({ phone: '+923009876543' });
    expect(taken.status).toBe(202);
    expect(Object.keys(taken.body.data).sort()).toEqual(['codeSent', 'message', 'verification']);
    expect(taken.body.data.verification.status).toBe('pending');

    const confirm = await request(app).post(CONFIRM).set(bearer).send({ phone: '+923009876543', code: FAKE_OTP });
    expect(confirm.status).toBe(400);
    expect(confirm.body.code).toBe('OTP_INVALID_OR_EXPIRED');
    expect(phoneAuth.verifyPhoneChange).not.toHaveBeenCalled();
    expect(phoneStore.complete).not.toHaveBeenCalled();
  });

  test('a double tap sends one SMS; the second request waits for the cooldown', async () => {
    const { app, phoneAuth } = testApp();
    const [a, b] = await Promise.all([
      request(app).post(START).set(bearer).send({ phone: PHONE }),
      request(app).post(START).set(bearer).send({ phone: PHONE }),
    ]);
    expect([a.status, b.status].sort()).toEqual([202, 429]);
    const blocked = a.status === 429 ? a : b;
    expect(blocked.body.code).toBe('RATE_LIMITED');
    expect(blocked.body.details).toEqual({ reason: 'resend_cooldown' });
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect(Number(blocked.headers['retry-after'])).toBeLessThanOrEqual(60);
    expect(phoneAuth.requestPhoneChange).toHaveBeenCalledTimes(1);
  });

  test('an already verified number answers 200 without sending anything', async () => {
    const { app, phoneAuth } = testApp();
    await request(app).post(START).set(bearer).send({ phone: PHONE });
    await request(app).post(CONFIRM).set(bearer).send({ phone: PHONE, code: FAKE_OTP });
    phoneAuth.requestPhoneChange.mockClear();

    const res = await request(app).post(START).set(bearer).send({ phone: PHONE });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ codeSent: false, verification: { status: 'verified' } });
    expect(phoneAuth.requestPhoneChange).not.toHaveBeenCalled();
  });

  test('a number confirmed in Supabase but never requested here is not adopted', async () => {
    const { app, phoneAuth, phoneStore } = testApp();
    const u = phoneAuth.users.get(userA.id)!;
    Object.assign(u, { phone: PHONE, phoneConfirmedAt: '2026-10-01T00:00:00Z' });
    const res = await request(app).post(START).set(bearer).send({ phone: PHONE });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PHONE_ALREADY_ON_ACCOUNT');
    expect(phoneStore.complete).not.toHaveBeenCalled();
  });

  test('is limited per account and per destination number', async () => {
    const perAccount = testApp({ rateLimits: tight({ phoneStartPerAccount: rule(1) }) });
    await request(perAccount.app).post(START).set(bearer).send({ phone: PHONE });
    const blocked = await request(perAccount.app).post(START).set(bearer).send({ phone: '+923001112222' });
    expect(blocked.status).toBe(429);
    expect(blocked.headers['retry-after']).toBeDefined();

    // Two accounts aiming at one victim's number.
    const perPhone = testApp({ rateLimits: tight({ phoneStartPerPhone: rule(1) }) });
    perPhone.phoneAuth.addUser('00000000-0000-4000-8000-00000000000b', OTHER_TOKEN);
    perPhone.gateway.getUser.mockImplementation(async (token) => {
      if (token === VALID_TOKEN) return { user: userA, roles: [] };
      return { user: { ...userA, id: '00000000-0000-4000-8000-00000000000b' }, roles: [] };
    });
    perPhone.profiles.getProfile.mockImplementation(async (_t, id) => profileFor({ ...userA, id }));
    await request(perPhone.app).post(START).set(bearer).send({ phone: PHONE });
    const second = await request(perPhone.app)
      .post(START)
      .set({ Authorization: `Bearer ${OTHER_TOKEN}` })
      .send({ phone: '+92 300 123 4567' });
    expect(second.status).toBe(429);
  });
});

describe('POST /verification/phone/resend', () => {
  test('waits for the cooldown, then sends again to the pending number', async () => {
    const c = clock();
    const { app, phoneAuth } = testApp({ now: c.now });
    await request(app).post(START).set(bearer).send({ phone: PHONE });

    const early = await request(app).post(RESEND).set(bearer).send({});
    expect(early.status).toBe(429);
    expect(early.headers['retry-after']).toBe('60');

    c.advance(61);
    const res = await request(app).post(RESEND).set(bearer).send();
    expect(res.status).toBe(202);
    expect(res.body.data.verification.pendingPhone).toBe('+92••••••4567');
    expect(phoneAuth.requestPhoneChange).toHaveBeenCalledTimes(2);
    expect(phoneAuth.requestPhoneChange).toHaveBeenLastCalledWith(VALID_TOKEN, PHONE);
  });

  test('without a pending request returns 409 and sends nothing', async () => {
    const { app, phoneAuth } = testApp();
    const res = await request(app).post(RESEND).set(bearer).send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NO_PENDING_PHONE_VERIFICATION');
    expect(phoneAuth.requestPhoneChange).not.toHaveBeenCalled();
  });

  test('does not accept a different number', async () => {
    const { app } = testApp();
    const res = await request(app).post(RESEND).set(bearer).send({ phone: '+923009999999' });
    expect(res.status).toBe(400);
  });

  test('is limited per account', async () => {
    const c = clock();
    const { app } = testApp({ now: c.now, rateLimits: tight({ phoneResendPerAccount: rule(1) }) });
    await request(app).post(START).set(bearer).send({ phone: PHONE });
    c.advance(61);
    expect((await request(app).post(RESEND).set(bearer)).status).toBe(202);
    c.advance(61);
    const blocked = await request(app).post(RESEND).set(bearer);
    expect(blocked.status).toBe(429);
    expect(blocked.body.details).toBeUndefined();
  });
});

describe('POST /verification/phone/confirm', () => {
  async function started(opts: Parameters<typeof testApp>[0] = {}) {
    const ctx = testApp(opts);
    await request(ctx.app).post(START).set(bearer).send({ phone: PHONE });
    return ctx;
  }

  test('verifies through Supabase, re-checks Auth with the caller token, then records the result', async () => {
    const { app, phoneAuth, phoneStore } = await started();
    const res = await request(app).post(CONFIRM).set(bearer).send({ phone: '+92 300 1234567', code: FAKE_OTP });

    expect(res.status).toBe(200);
    expect(res.body.data.verification).toMatchObject({
      status: 'verified',
      verifiedAt: '2026-10-26T12:00:00Z',
      phone: '+92••••••4567',
      pendingPhone: null,
      resendAvailableAt: null,
    });
    expect(phoneAuth.verifyPhoneChange).toHaveBeenCalledWith(PHONE, FAKE_OTP);
    // Before (binding) and after (independent confirmation) the OTP check.
    expect(phoneAuth.getPhoneState).toHaveBeenCalledWith(VALID_TOKEN);
    expect(phoneStore.complete).toHaveBeenCalledWith(userA.id, PHONE, '2026-10-26T12:00:00Z');

    const status = await request(app).get(STATUS).set(bearer);
    expect(status.body.data.verification.status).toBe('verified');
  });

  test('a wrong or expired code is rejected and nothing becomes verified', async () => {
    const { app, phoneStore } = await started();
    const res = await request(app).post(CONFIRM).set(bearer).send({ phone: PHONE, code: '000000' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('OTP_INVALID_OR_EXPIRED');
    expect(phoneStore.complete).not.toHaveBeenCalled();
    expect(phoneStore.recordFailure).toHaveBeenCalledWith(userA.id, 'invalid_or_expired_code');
    expect(phoneStore.rows.get(userA.id)?.status).toBe('pending');
    expect(JSON.stringify(res.body)).not.toContain('000000');
  });

  test('repeating a successful confirmation (double tap) changes nothing and does not ask Supabase again', async () => {
    const { app, phoneAuth, phoneStore } = await started();
    const [a, b] = await Promise.all([
      request(app).post(CONFIRM).set(bearer).send({ phone: PHONE, code: FAKE_OTP }),
      request(app).post(CONFIRM).set(bearer).send({ phone: PHONE, code: FAKE_OTP }),
    ]);
    const statuses = [a.status, b.status].sort();
    // Either both see success, or the second arrives while Supabase has
    // already spent the code and is told it is invalid; never two writes.
    expect(statuses[0]).toBe(200);
    expect(phoneStore.complete.mock.calls.filter(([, p]) => p === PHONE).length).toBeLessThanOrEqual(2);
    phoneAuth.verifyPhoneChange.mockClear();
    const again = await request(app).post(CONFIRM).set(bearer).send({ phone: PHONE, code: FAKE_OTP });
    expect(again.status).toBe(200);
    expect(again.body.data.verification.status).toBe('verified');
    expect(phoneAuth.verifyPhoneChange).not.toHaveBeenCalled();
  });

  test('a spent or expired code reported by Supabase is rejected without changing the status', async () => {
    const { app, phoneAuth, phoneStore } = await started();
    phoneAuth.verifyPhoneChange.mockRejectedValueOnce(AppError.badRequest('OTP_INVALID_OR_EXPIRED', 'The code is incorrect or has expired'));
    const res = await request(app).post(CONFIRM).set(bearer).send({ phone: PHONE, code: FAKE_OTP });
    expect(res.body.code).toBe('OTP_INVALID_OR_EXPIRED');
    expect(phoneStore.rows.get(userA.id)?.status).toBe('pending');
  });

  test('a code for a number other than the requested one is refused before Supabase is asked', async () => {
    const { app, phoneAuth, phoneStore } = await started();
    const res = await request(app).post(CONFIRM).set(bearer).send({ phone: '+923009999999', code: FAKE_OTP });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NO_PENDING_PHONE_VERIFICATION');
    expect(phoneAuth.verifyPhoneChange).not.toHaveBeenCalled();
    expect(phoneStore.complete).not.toHaveBeenCalled();
  });

  test("cannot verify another user's pending number", async () => {
    const { app, phoneAuth, phoneStore } = testApp();
    const otherId = '00000000-0000-4000-8000-00000000000b';
    phoneAuth.addUser(otherId, OTHER_TOKEN);
    // User B asks for a code; user A tries to use it.
    await phoneAuth.requestPhoneChange(OTHER_TOKEN, PHONE);
    const res = await request(app).post(CONFIRM).set(bearer).send({ phone: PHONE, code: FAKE_OTP });
    expect(res.status).toBe(409);
    expect(phoneAuth.verifyPhoneChange).not.toHaveBeenCalled();
    expect(phoneStore.complete).not.toHaveBeenCalled();
    expect(phoneAuth.users.get(otherId)?.phone).toBeNull();
  });

  test('a code Supabase applied to a different account records nothing for the caller', async () => {
    const { app, phoneAuth, phoneStore } = await started();
    phoneAuth.verifyPhoneChange.mockResolvedValueOnce({ userId: '00000000-0000-4000-8000-00000000000b' });
    const res = await request(app).post(CONFIRM).set(bearer).send({ phone: PHONE, code: FAKE_OTP });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('OTP_INVALID_OR_EXPIRED');
    expect(phoneStore.complete).not.toHaveBeenCalled();
    expect(phoneStore.recordFailure).toHaveBeenCalledWith(userA.id, 'account_mismatch');
  });

  test('is not recorded unless Supabase Auth then reports the number as confirmed', async () => {
    const { app, phoneAuth, phoneStore } = await started();
    // Supabase claims success but the user's Auth record does not agree.
    phoneAuth.verifyPhoneChange.mockResolvedValueOnce({ userId: userA.id });
    const res = await request(app).post(CONFIRM).set(bearer).send({ phone: PHONE, code: FAKE_OTP });
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('AUTH_PROVIDER_ERROR');
    expect(phoneStore.complete).not.toHaveBeenCalled();
  });

  test('recovers when Supabase confirmed the number but the database write was lost', async () => {
    const { app, phoneAuth, phoneStore } = await started();
    phoneStore.complete.mockRejectedValueOnce(AppError.unavailable('Data service is temporarily unavailable', 'DATABASE_UNAVAILABLE'));
    expect((await request(app).post(CONFIRM).set(bearer).send({ phone: PHONE, code: FAKE_OTP })).status).toBe(503);

    // The code is spent in Supabase; retrying completes from Auth's record.
    phoneAuth.verifyPhoneChange.mockClear();
    const retry = await request(app).post(CONFIRM).set(bearer).send({ phone: PHONE, code: FAKE_OTP });
    expect(retry.status).toBe(200);
    expect(retry.body.data.verification.status).toBe('verified');
    expect(phoneAuth.verifyPhoneChange).not.toHaveBeenCalled();
  });

  test('changing a verified number keeps the old one verified until the new one is confirmed', async () => {
    const c = clock();
    const { app } = await started({ now: c.now });
    await request(app).post(CONFIRM).set(bearer).send({ phone: PHONE, code: FAKE_OTP });

    const change = await request(app).post(START).set(bearer).send({ phone: '+923001112222' });
    expect(change.status).toBe(202);
    expect(change.body.data.verification).toMatchObject({ status: 'verified', phone: '+92••••••4567', pendingPhone: '+92••••••2222' });

    const done = await request(app).post(CONFIRM).set(bearer).send({ phone: '+923001112222', code: FAKE_OTP });
    expect(done.body.data.verification).toMatchObject({ status: 'verified', phone: '+92••••••2222', pendingPhone: null });
  });

  test('attempts are limited per account', async () => {
    const { app, phoneAuth } = await started({ rateLimits: tight({ phoneConfirmPerAccount: rule(2) }) });
    await request(app).post(CONFIRM).set(bearer).send({ phone: PHONE, code: '000000' });
    await request(app).post(CONFIRM).set(bearer).send({ phone: PHONE, code: '000001' });
    const blocked = await request(app).post(CONFIRM).set(bearer).send({ phone: PHONE, code: FAKE_OTP });
    expect(blocked.status).toBe(429);
    expect(blocked.headers['retry-after']).toBeDefined();
    expect(phoneAuth.verifyPhoneChange).toHaveBeenCalledTimes(2);
  });

  test.each([
    ['a client-asserted verified flag', { phone: PHONE, code: FAKE_OTP, verified: true }],
    ['a missing code', { phone: PHONE }],
    ['a non-numeric code', { phone: PHONE, code: 'abcdef' }],
  ])('rejects %s with 400', async (_label, body) => {
    const { app, phoneStore } = await started();
    const res = await request(app).post(CONFIRM).set(bearer).send(body);
    expect(res.status).toBe(400);
    expect(phoneStore.complete).not.toHaveBeenCalled();
  });
});

describe('GET /verification/phone', () => {
  test('reports not_started for a new account', async () => {
    const { app } = testApp();
    const res = await request(app).get(STATUS).set(bearer);
    expect(res.status).toBe(200);
    expect(res.body.data.verification).toEqual({
      status: 'not_started',
      verifiedAt: null,
      phone: null,
      pendingPhone: null,
      resendAvailableAt: null,
      codeLength: 6,
    });
  });

  test('withdraws a verification Supabase Auth no longer backs', async () => {
    const { app, phoneAuth, phoneStore } = testApp();
    await request(app).post(START).set(bearer).send({ phone: PHONE });
    await request(app).post(CONFIRM).set(bearer).send({ phone: PHONE, code: FAKE_OTP });
    // The user changed their number directly in Supabase Auth.
    Object.assign(phoneAuth.users.get(userA.id)!, { phone: '+923005550000' });

    const res = await request(app).get(STATUS).set(bearer);
    expect(res.body.data.verification).toMatchObject({ status: 'revoked', phone: null });
    expect(phoneStore.revoke).toHaveBeenCalledWith(userA.id);
  });

  test('without server wiring every endpoint answers 503 SERVER_NOT_CONFIGURED', async () => {
    const app = createApp({ config: testConfig(), logger: pino({ level: 'silent' }), authGateway: fakeGateway(), profiles: fakeProfiles() });
    const res = await request(app).get(STATUS).set(bearer);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('SERVER_NOT_CONFIGURED');
  });
});

test('logs never contain the OTP, the phone number or the token', async () => {
  const lines: string[] = [];
  const logger = pino({ level: 'trace', redact: { paths: REDACT_PATHS, censor: '[REDACTED]' } }, { write: (l: string) => void lines.push(l) });
  const phoneAuth = fakePhoneAuth();
  const store = memoryPhoneStore();
  const config = testConfig();
  const app = createApp({
    config,
    logger,
    authGateway: fakeGateway(),
    profiles: fakeProfiles(),
    phoneVerification: createPhoneVerificationService({ auth: phoneAuth, store, policy: config.phoneVerification, logger }),
  });
  await request(app).post(START).set(bearer).send({ phone: PHONE });
  await request(app).post(CONFIRM).set(bearer).send({ phone: PHONE, code: '987654' });
  phoneAuth.verifyPhoneChange.mockResolvedValueOnce({ userId: 'someone-else' });
  await request(app).post(CONFIRM).set(bearer).send({ phone: PHONE, code: FAKE_OTP });

  const output = lines.join('\n');
  expect(lines.length).toBeGreaterThan(0);
  for (const secret of ['987654', FAKE_OTP, '3001234567', VALID_TOKEN]) expect(output).not.toContain(secret);
});
