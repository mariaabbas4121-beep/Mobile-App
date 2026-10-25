import { ApiError, createApiClient } from '../lib/api/client';

function response(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: async () => {
      if (body === undefined) throw new SyntaxError('no body');
      return body;
    },
  } as unknown as Response;
}

const client = (fetchImpl: jest.Mock, timeoutMs?: number) =>
  createApiClient({ baseUrl: 'http://api.test', fetchImpl: fetchImpl as unknown as typeof fetch, ...(timeoutMs ? { timeoutMs } : {}) });

const catchErr = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as ApiError;
  }
  throw new Error('expected rejection');
};

describe('API client', () => {
  test('sends JSON to the versioned path and returns `data`', async () => {
    const fetchImpl = jest.fn(async () => response(200, { success: true, data: { user: { id: 'u' }, session: { accessToken: 'a' } } }));
    const result = await client(fetchImpl).login({ email: 'a@example.com', password: 'pw' });
    expect(result.user.id).toBe('u');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://api.test/api/v1/auth/login');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ email: 'a@example.com', password: 'pw' });
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  test('sends the bearer token on authenticated calls', async () => {
    const fetchImpl = jest.fn(async () => response(200, { success: true, data: {} }));
    await client(fetchImpl).me('token-123');
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer token-123');
  });

  test('returns undefined for 204 (logout)', async () => {
    const fetchImpl = jest.fn(async () => response(204, undefined));
    await expect(client(fetchImpl).logout('t')).resolves.toBeUndefined();
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(init.body as string)).toEqual({ scope: 'local' });
  });

  test('turns the documented error envelope into ApiError with code, details and requestId', async () => {
    const fetchImpl = jest.fn(async () =>
      response(400, {
        success: false,
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        requestId: 'req-1',
        details: [{ field: 'password', message: 'must be at least 8 characters' }],
      }),
    );
    const err = await catchErr(client(fetchImpl).signup({ email: 'a@example.com', password: 'x' }));
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(400);
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.requestId).toBe('req-1');
    expect(err.fieldIssues).toEqual([{ field: 'password', message: 'must be at least 8 characters' }]);
  });

  test('reads Retry-After on 429', async () => {
    const fetchImpl = jest.fn(async () =>
      response(429, { success: false, code: 'RATE_LIMITED', message: 'Too many', requestId: 'r' }, { 'retry-after': '42' }),
    );
    const err = await catchErr(client(fetchImpl).resendConfirmation('a@example.com'));
    expect(err.code).toBe('RATE_LIMITED');
    expect(err.retryAfterSeconds).toBe(42);
  });

  test('network failures become NETWORK_ERROR', async () => {
    const fetchImpl = jest.fn(async () => {
      throw new TypeError('Network request failed');
    });
    expect((await catchErr(client(fetchImpl).status('t'))).code).toBe('NETWORK_ERROR');
  });

  test('requests that exceed the timeout are aborted as TIMEOUT', async () => {
    const fetchImpl = jest.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    expect((await catchErr(client(fetchImpl, 20).me('t'))).code).toBe('TIMEOUT');
  });

  test.each([
    ['non-JSON body', response(502, undefined)],
    ['JSON without the envelope', response(500, { error: 'boom' })],
  ])('%s becomes BAD_RESPONSE', async (_l, res) => {
    const fetchImpl = jest.fn(async () => res);
    expect((await catchErr(client(fetchImpl).me('t'))).code).toBe('BAD_RESPONSE');
  });

  test('missing base URL fails with NOT_CONFIGURED without making a request', async () => {
    const fetchImpl = jest.fn();
    const api = createApiClient({ baseUrl: null, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect((await catchErr(api.me('t'))).code).toBe('NOT_CONFIGURED');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
