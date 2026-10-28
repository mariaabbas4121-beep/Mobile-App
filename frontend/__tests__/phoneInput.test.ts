import { COUNTRIES, DEFAULT_COUNTRY, cleanCode, codeError, maskPhone, secondsUntil, toE164, type Country } from '../lib/verification/phone';
import { createApiClient } from '../lib/api/client';

const country = (iso: string) => COUNTRIES.find((c) => c.iso === iso) as Country;

describe('toE164', () => {
  test.each([
    ['PK', '300 1234567', '+923001234567'],
    ['PK', '0300-1234567', '+923001234567'],
    ['PK', '(0300) 123 4567', '+923001234567'],
    ['AE', '050 123 4567', '+971501234567'],
    ['US', '1 (201) 555-0123', '+12015550123'],
    ['GB', '07400 123456', '+447400123456'],
  ])('%s %j becomes %s', (iso, typed, e164) => {
    expect(toE164(country(iso), typed)).toEqual({ ok: true, e164 });
  });

  test('a number typed with + or 00 ignores the selected country', () => {
    expect(toE164(DEFAULT_COUNTRY, '+44 7400 123456')).toEqual({ ok: true, e164: '+447400123456' });
    expect(toE164(DEFAULT_COUNTRY, '0044 7400 123456')).toEqual({ ok: true, e164: '+447400123456' });
  });

  test.each([
    ['', 'Enter your phone number.'],
    ['300 12345', 'Enter a valid Pakistan number, for example 300 1234567.'],
    ['300 1234567 89', 'Enter a valid Pakistan number, for example 300 1234567.'],
    ['300-ABC-4567', 'Use digits only.'],
    ['+0 300 1234567', 'Enter a full international number, for example +92 300 1234567.'],
    ['+92 3', 'Enter a full international number, for example +92 300 1234567.'],
  ])('rejects %j', (typed, error) => {
    expect(toE164(DEFAULT_COUNTRY, typed)).toEqual({ ok: false, error });
  });
});

describe('code input', () => {
  test('keeps digits only, up to the code length (pasted SMS text works)', () => {
    expect(cleanCode('Your code is 123 456', 6)).toBe('123456');
    expect(cleanCode('12345678', 6)).toBe('123456');
  });

  test('requires exactly the configured number of digits', () => {
    expect(codeError('', 6)).toBe('Enter the code from the text message.');
    expect(codeError('12345', 6)).toBe('The code has 6 digits.');
    expect(codeError('123456', 6)).toBeNull();
    expect(codeError('12345678', 8)).toBeNull();
  });
});

test('masks numbers like the server', () => {
  expect(maskPhone('+923001234567')).toBe('+92••••••4567');
});

test('secondsUntil counts down to the server time and never goes negative', () => {
  const now = Date.parse('2026-10-26T12:00:00Z');
  expect(secondsUntil('2026-10-26T12:00:45Z', now)).toBe(45);
  expect(secondsUntil('2026-10-26T11:59:00Z', now)).toBe(0);
  expect(secondsUntil(null, now)).toBe(0);
});

describe('API client phone endpoints', () => {
  const ok = (data: unknown) =>
    ({ status: 200, ok: true, headers: { get: () => null }, json: async () => ({ success: true, data }) }) as unknown as Response;

  test.each([
    ['phoneVerification', (api: ReturnType<typeof createApiClient>) => api.phoneVerification('t'), 'GET', '/verification/phone', undefined],
    ['startPhoneVerification', (api: ReturnType<typeof createApiClient>) => api.startPhoneVerification('t', '+923001234567'), 'POST', '/verification/phone/start', { phone: '+923001234567' }],
    ['resendPhoneVerification', (api: ReturnType<typeof createApiClient>) => api.resendPhoneVerification('t'), 'POST', '/verification/phone/resend', {}],
    ['confirmPhoneVerification', (api: ReturnType<typeof createApiClient>) => api.confirmPhoneVerification('t', '+923001234567', '123456'), 'POST', '/verification/phone/confirm', { phone: '+923001234567', code: '123456' }],
  ])('%s calls the documented endpoint with the bearer token', async (_name, call, method, path, body) => {
    const fetchImpl = jest.fn(async () => ok({ verification: {} }));
    await call(createApiClient({ baseUrl: 'http://api.test', fetchImpl: fetchImpl as unknown as typeof fetch }));
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`http://api.test/api/v1${path}`);
    expect(init.method).toBe(method);
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer t');
    expect(init.body === undefined ? undefined : JSON.parse(init.body as string)).toEqual(body);
  });
});
