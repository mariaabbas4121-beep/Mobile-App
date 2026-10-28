// The Supabase Auth adapter for phone verification, with HTTP and the SDK
// replaced by fakes. Checks the requests it makes and how Supabase's answers
// and errors are translated. Nothing is sent to Supabase.
import { describe, expect, test, vi } from 'vitest';
import { AuthApiError, AuthRetryableFetchError } from '@supabase/supabase-js';
import type { SupabaseClients } from '../../src/config/supabase.js';
import { AppError } from '../../src/lib/errors.js';
import { createSupabasePhoneAuth, mapPhoneAuthError, SETTINGS_CACHE_MS } from '../../src/verification/supabase-phone-auth.js';
import { silentLogger, testConfig, VALID_TOKEN } from '../helpers.js';

const config = testConfig();

const json = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

function fakeClients() {
  const verifyOtp = vi.fn();
  const signOut = vi.fn(async () => ({ error: null }));
  const getUser = vi.fn();
  const clients = {
    anon: () => ({ auth: { getUser, admin: { signOut } } }),
    ephemeral: vi.fn(() => ({ auth: { verifyOtp } })),
    forUser: () => {
      throw new Error('not used');
    },
    admin: () => {
      throw new Error('not used');
    },
  } as unknown as SupabaseClients;
  return { clients, verifyOtp, signOut, getUser };
}

const supabaseUser = (overrides: Record<string, unknown> = {}) => ({
  id: 'user-1',
  aud: 'authenticated',
  app_metadata: {},
  user_metadata: {},
  created_at: '2026-10-20T00:00:00Z',
  ...overrides,
});

const catchErr = async (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e as AppError);

describe('requestPhoneChange', () => {
  test("PUTs the number to /auth/v1/user with the caller's token and reads new_phone back", async () => {
    const fetchImpl = vi.fn(async () => json(200, supabaseUser({ phone: '', new_phone: '923001234567' })));
    const { clients } = fakeClients();
    const auth = createSupabasePhoneAuth(clients, config, silentLogger, { fetchImpl: fetchImpl as unknown as typeof fetch });

    const state = await auth.requestPhoneChange(VALID_TOKEN, '+923001234567');
    expect(state).toEqual({ userId: 'user-1', phone: null, phoneConfirmedAt: null, pendingPhone: '+923001234567' });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://unit-test.invalid/auth/v1/user');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({ phone: '+923001234567' });
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${VALID_TOKEN}`);
    expect(headers.apikey).toBe(config.supabase.publishableKey);
  });

  test.each([
    ['phone_exists', 422, 409, 'PHONE_IN_USE'],
    ['validation_failed', 400, 400, 'INVALID_PHONE'],
    ['over_sms_send_rate_limit', 429, 429, 'RATE_LIMITED'],
    ['phone_provider_disabled', 400, 503, 'PHONE_VERIFICATION_NOT_CONFIGURED'],
    ['sms_send_failed', 500, 503, 'SMS_DELIVERY_UNAVAILABLE'],
    ['bad_jwt', 401, 401, 'INVALID_TOKEN'],
  ])('maps Supabase %s (HTTP %i) to %i %s', async (code, status, expectedStatus, expectedCode) => {
    const fetchImpl = vi.fn(async () => json(status, { code, message: 'Provider said something about +923001234567' }));
    const auth = createSupabasePhoneAuth(fakeClients().clients, config, silentLogger, { fetchImpl: fetchImpl as unknown as typeof fetch });
    const err = await catchErr(auth.requestPhoneChange(VALID_TOKEN, '+923001234567'));
    expect(err).toBeInstanceOf(AppError);
    expect([err?.status, err?.code]).toEqual([expectedStatus, expectedCode]);
    expect(err?.message).not.toContain('923001234567');
  });

  test('understands the older error body shape (error_code, msg)', async () => {
    const fetchImpl = vi.fn(async () => json(422, { code: 422, error_code: 'phone_exists', msg: 'taken' }));
    const auth = createSupabasePhoneAuth(fakeClients().clients, config, silentLogger, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect((await catchErr(auth.requestPhoneChange(VALID_TOKEN, '+923001234567')))?.code).toBe('PHONE_IN_USE');
  });

  test('a 500 about sending the SMS is reported as SMS delivery, other 500s as an outage', async () => {
    const sms = vi.fn(async () => json(500, { code: 'unexpected_failure', message: 'Error sending phone change otp' }));
    const other = vi.fn(async () => json(500, { code: 'unexpected_failure', message: 'database error' }));
    const a = createSupabasePhoneAuth(fakeClients().clients, config, silentLogger, { fetchImpl: sms as unknown as typeof fetch });
    const b = createSupabasePhoneAuth(fakeClients().clients, config, silentLogger, { fetchImpl: other as unknown as typeof fetch });
    expect((await catchErr(a.requestPhoneChange(VALID_TOKEN, '+923001234567')))?.code).toBe('SMS_DELIVERY_UNAVAILABLE');
    expect((await catchErr(b.requestPhoneChange(VALID_TOKEN, '+923001234567')))?.code).toBe('AUTH_UNAVAILABLE');
  });

  test('an unreachable Supabase is a 503 without internals', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed: ECONNREFUSED 10.0.0.1');
    });
    const auth = createSupabasePhoneAuth(fakeClients().clients, config, silentLogger, { fetchImpl: fetchImpl as unknown as typeof fetch });
    const err = await catchErr(auth.requestPhoneChange(VALID_TOKEN, '+923001234567'));
    expect([err?.status, err?.code]).toEqual([503, 'AUTH_UNAVAILABLE']);
    expect(err?.message).not.toMatch(/ECONNREFUSED|10\.0\.0\.1/);
  });
});

describe('verifyPhoneChange', () => {
  test('verifies with type phone_change on an isolated client and revokes the session Supabase issues', async () => {
    const { clients, verifyOtp, signOut } = fakeClients();
    verifyOtp.mockResolvedValue({
      data: { user: supabaseUser({ phone: '923001234567' }), session: { access_token: 'issued.by.verify' } },
      error: null,
    });
    const auth = createSupabasePhoneAuth(clients, config, silentLogger);
    expect(await auth.verifyPhoneChange('+923001234567', '123456')).toEqual({ userId: 'user-1' });
    expect(verifyOtp).toHaveBeenCalledWith({ phone: '+923001234567', token: '123456', type: 'phone_change' });
    expect(clients.ephemeral).toHaveBeenCalledTimes(1);
    expect(signOut).toHaveBeenCalledWith('issued.by.verify', 'local');
  });

  test('the issued session never reaches the caller even if revoking it fails', async () => {
    const { clients, verifyOtp, signOut } = fakeClients();
    verifyOtp.mockResolvedValue({ data: { user: supabaseUser(), session: { access_token: 'issued.by.verify' } }, error: null });
    signOut.mockRejectedValueOnce(new Error('network'));
    const result = await createSupabasePhoneAuth(clients, config, silentLogger).verifyPhoneChange('+923001234567', '123456');
    expect(JSON.stringify(result)).not.toContain('issued.by.verify');
  });

  test.each([
    ['otp_expired', 403],
    [undefined, 400],
    ['user_not_found', 404],
  ])('Supabase %s (HTTP %i) becomes 400 OTP_INVALID_OR_EXPIRED, never a token error', async (code, status) => {
    const { clients, verifyOtp } = fakeClients();
    verifyOtp.mockResolvedValue({ data: { user: null, session: null }, error: new AuthApiError('Token has expired or is invalid', status, code) });
    const err = await catchErr(createSupabasePhoneAuth(clients, config, silentLogger).verifyPhoneChange('+923001234567', '000000'));
    expect([err?.status, err?.code]).toEqual([400, 'OTP_INVALID_OR_EXPIRED']);
  });

  test('Supabase verification rate limiting is a 429', async () => {
    const { clients, verifyOtp } = fakeClients();
    verifyOtp.mockResolvedValue({ data: { user: null, session: null }, error: new AuthApiError('slow down', 429, 'over_request_rate_limit') });
    expect((await catchErr(createSupabasePhoneAuth(clients, config, silentLogger).verifyPhoneChange('+923001234567', '000000')))?.code).toBe(
      'RATE_LIMITED',
    );
  });
});

describe('getSettings', () => {
  test('reads the public Auth settings and caches them', async () => {
    let t = 0;
    const fetchImpl = vi.fn(async () => json(200, { external: { phone: true }, phone_autoconfirm: false, sms_provider: 'twilio' }));
    const auth = createSupabasePhoneAuth(fakeClients().clients, config, silentLogger, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => t,
    });
    expect(await auth.getSettings()).toEqual({ phoneEnabled: true, autoconfirm: false });
    await auth.getSettings();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    t += SETTINGS_CACHE_MS + 1;
    await auth.getSettings();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe('https://unit-test.invalid/auth/v1/settings');
  });

  test('treats missing fields as disabled and unsafe', async () => {
    const fetchImpl = vi.fn(async () => json(200, {}));
    const auth = createSupabasePhoneAuth(fakeClients().clients, config, silentLogger, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await auth.getSettings()).toEqual({ phoneEnabled: false, autoconfirm: true });
  });
});

describe('getPhoneState', () => {
  test('reports the confirmed phone only when one is set', async () => {
    const { clients, getUser } = fakeClients();
    getUser.mockResolvedValueOnce({
      data: { user: supabaseUser({ phone: '923001234567', phone_confirmed_at: '2026-10-26T12:00:00Z', new_phone: '' }) },
      error: null,
    });
    getUser.mockResolvedValueOnce({ data: { user: supabaseUser({ phone: '', phone_confirmed_at: '2026-10-26T12:00:00Z' }) }, error: null });
    const auth = createSupabasePhoneAuth(clients, config, silentLogger);
    expect(await auth.getPhoneState(VALID_TOKEN)).toEqual({
      userId: 'user-1',
      phone: '+923001234567',
      phoneConfirmedAt: '2026-10-26T12:00:00Z',
      pendingPhone: null,
    });
    expect((await auth.getPhoneState(VALID_TOKEN)).phoneConfirmedAt).toBeNull();
  });
});

test('mapPhoneAuthError reports retryable network failures as AUTH_UNAVAILABLE', () => {
  const err = mapPhoneAuthError(new AuthRetryableFetchError('Bad gateway', 502), 'phone_verify', silentLogger);
  expect(err.code).toBe('AUTH_UNAVAILABLE');
});
