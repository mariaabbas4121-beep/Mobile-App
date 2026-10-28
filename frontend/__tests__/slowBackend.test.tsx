// What the app does when the API cannot be reached or does not answer: the
// cause of sign-in "hanging" when EXPO_PUBLIC_API_URL points at an old LAN
// address. These use the real API client with a fetch that never settles,
// so the client's own timeouts are what end each wait.
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { AuthProvider } from '../context/AuthContext';
import LoginScreen from '../app/auth/login';
import OAuthCallbackScreen from '../app/auth/callback';
import { createApiClient, LOGOUT_TIMEOUT_MS, type ApiClient, type RequestTiming } from '../lib/api/client';
import { apiHostMismatch, fetchWithTimeout, probeApi, runStartupDiagnostics } from '../lib/api/diagnostics';
import { OAuthError } from '../lib/auth/googleAuth';
import { SessionManager } from '../lib/auth/sessionManager';
import { createMemoryTokenStorage } from '../lib/auth/tokenStorage';
import type { AuthServices } from '../context/AuthContext';
import { fakeGoogle, NOW, session } from './support/fakes';

const mockRouter = { replace: jest.fn(), push: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => true) };
let mockParams: Record<string, string> = {};
jest.mock('expo-router', () => ({ useRouter: () => mockRouter, useLocalSearchParams: () => mockParams }));

beforeEach(() => {
  jest.clearAllMocks();
  mockParams = {};
});

// A fetch to an address nobody answers: it settles only when aborted.
const hangingFetch = jest.fn(
  (_url: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    }),
) as unknown as typeof fetch;

function servicesWith(api: ApiClient, google = fakeGoogle()) {
  const storage = createMemoryTokenStorage();
  const sessionManager = new SessionManager(api, storage, () => NOW);
  return { api, storage, sessionManager, google, asServices: { api, sessionManager, googleAuth: google } as unknown as AuthServices };
}

const unreachableApi = (timeoutMs = 60) => createApiClient({ baseUrl: 'http://192.168.100.14:4000', fetchImpl: hangingFetch, timeoutMs });

describe('API unreachable', () => {
  test('email sign-in stops waiting at the timeout, shows why, and re-enables the form', async () => {
    const s = servicesWith(unreachableApi());
    await render(
      <AuthProvider services={s.asServices}>
        <LoginScreen />
      </AuthProvider>,
    );
    await fireEvent.changeText(screen.getByLabelText('Email'), 'sara@example.com');
    await fireEvent.changeText(screen.getByLabelText('Password'), 'pw');
    await fireEvent.press(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('The server took too long to respond. Please try again.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign in' }).props.accessibilityState).toMatchObject({ disabled: false, busy: false });
    expect(s.sessionManager.current).toBeNull();
  });

  test('Google sign-in that cannot load the account ends on the retry screen with the session kept', async () => {
    const s = servicesWith(unreachableApi());
    mockParams = { code: 'one-time-code' };
    const google = fakeGoogle({ completeFromParams: jest.fn(async () => ({ type: 'success', session: session(9) })) });
    const t = servicesWith(s.api, google);
    let captured: { phase: string } | null = null;
    const { useAuth } = jest.requireActual('../context/AuthContext') as typeof import('../context/AuthContext');
    function Probe() {
      captured = useAuth();
      return null;
    }
    await render(
      <AuthProvider services={t.asServices}>
        <OAuthCallbackScreen />
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => expect((captured as { phase: string } | null)?.phase).toBe('unreachable'));
    // The Supabase session is kept so a retry does not need Google again.
    expect(t.sessionManager.current?.accessToken).toBe('access-9');
  });

  test('a failed Google code exchange shows an error instead of spinning', async () => {
    mockParams = { code: 'expired-code' };
    const google = fakeGoogle({
      completeFromParams: jest.fn(async () => {
        throw new OAuthError('EXCHANGE_FAILED', 'This sign-in link has expired or was already used. Please try again.');
      }),
    });
    const s = servicesWith(unreachableApi(), google);
    await render(
      <AuthProvider services={s.asServices}>
        <OAuthCallbackScreen />
      </AuthProvider>,
    );
    expect(await screen.findByText('This sign-in link has expired or was already used. Please try again.')).toBeTruthy();
    expect(screen.queryByText('Finishing sign-in…')).toBeNull();
  });

  test('sign-out finishes within the logout limit and always clears the device', async () => {
    jest.useFakeTimers();
    try {
      // Normal requests would wait 20 s; logout must not.
      const api = createApiClient({ baseUrl: 'http://192.168.100.14:4000', fetchImpl: hangingFetch });
      const s = servicesWith(api);
      await s.sessionManager.setSession(session(1));
      let done = false;
      const out = s.sessionManager.signOut().then(() => {
        done = true;
      });
      await act(async () => {
        jest.advanceTimersByTime(LOGOUT_TIMEOUT_MS - 1);
      });
      expect(done).toBe(false);
      await act(async () => {
        jest.advanceTimersByTime(2);
      });
      await out;
      expect(done).toBe(true);
      expect(s.sessionManager.current).toBeNull();
      expect(await s.storage.load()).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('session restore racing a sign-in (app launched by the Google deep link)', () => {
  function slowStorage(stored: ReturnType<typeof session> | null, unreadable = false) {
    const inner = createMemoryTokenStorage();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    return {
      release,
      storage: {
        ...inner,
        load: async () => {
          await gate;
          if (unreadable) throw new Error('keychain unavailable');
          return stored;
        },
        clear: jest.fn(inner.clear),
      },
    };
  }

  test.each([
    ['nothing stored', null, false],
    ['an older stored session', session(1), false],
    ['unreadable storage', null, true],
  ])('with %s, a session set during restore is kept', async (_label, stored, unreadable) => {
    const { storage, release } = slowStorage(stored, unreadable);
    const manager = new SessionManager(unreachableApi(), storage, () => NOW);
    const restoring = manager.restore();
    await manager.setSession(session(9));
    release();
    expect((await restoring)?.accessToken).toBe('access-9');
    expect(manager.current?.accessToken).toBe('access-9');
    expect(storage.clear).not.toHaveBeenCalled();
  });

  test('without a concurrent sign-in, restore still loads the stored session', async () => {
    const { storage, release } = slowStorage(session(1));
    const manager = new SessionManager(unreachableApi(), storage, () => NOW);
    const restoring = manager.restore();
    release();
    expect((await restoring)?.accessToken).toBe('access-1');
  });
});

describe('request timing', () => {
  const response = (status: number, body: unknown, requestId = 'req-42') =>
    ({ status, ok: status < 300, headers: { get: (k: string) => (k.toLowerCase() === 'x-request-id' ? requestId : null) }, json: async () => body }) as unknown as Response;

  test('reports method, path, status, duration and request id, never the body or token', async () => {
    const timings: RequestTiming[] = [];
    let t = 1000;
    const api = createApiClient({
      baseUrl: 'http://api.test',
      fetchImpl: (async () => {
        t += 362;
        return response(200, { success: true, data: { user: {}, session: {} } });
      }) as unknown as typeof fetch,
      onTiming: (x) => timings.push(x),
      now: () => t,
    });
    await api.login({ email: 'sara@example.com', password: 'hunter2pass' });
    expect(timings).toEqual([{ method: 'POST', path: '/auth/login', status: 200, durationMs: 362, requestId: 'req-42' }]);
    expect(JSON.stringify(timings)).not.toMatch(/hunter2pass|sara@example.com|Bearer/);
  });

  test('reports a timeout as TIMEOUT', async () => {
    const timings: RequestTiming[] = [];
    const api = createApiClient({ baseUrl: 'http://api.test', fetchImpl: hangingFetch, timeoutMs: 20, onTiming: (x) => timings.push(x) });
    await expect(api.me('t')).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(timings[0]).toMatchObject({ method: 'GET', path: '/auth/me', status: 'TIMEOUT' });
  });
});

describe('startup diagnostics', () => {
  test.each([
    ['http://192.168.100.14:4000', '10.172.18.160:8081', true],
    ['http://10.172.18.160:4000', '10.172.18.160:8081', false],
    ['http://10.0.2.2:4000', 'localhost:8081', false],
    ['https://api.neighborshare.example', '10.172.18.160:8081', false],
    ['http://192.168.100.14:4000', null, false],
  ])('API %s with Metro at %s: warn = %s', (apiUrl, metro, warns) => {
    const message = apiHostMismatch(apiUrl, metro);
    expect(Boolean(message)).toBe(warns);
    if (message) expect(message).toContain('EXPO_PUBLIC_API_URL=http://10.172.18.160:<port>');
  });

  test('an unreachable API is reported with its address and the reason', async () => {
    const warn = jest.fn();
    const info = jest.fn();
    await runStartupDiagnostics({
      apiUrl: 'http://192.168.100.14:4000',
      metroHostUri: '10.172.18.160:8081',
      health: () => unreachableApi(20).health(),
      warn,
      info,
    });
    const messages = warn.mock.calls.map(([m]) => m as string);
    expect(messages.some((m) => m.includes('192.168.100.14') && m.includes('10.172.18.160'))).toBe(true);
    expect(messages.some((m) => m.includes('Cannot reach http://192.168.100.14:4000/api/v1/health (TIMEOUT'))).toBe(true);
    expect(info).not.toHaveBeenCalled();
  });

  test('a reachable API is confirmed with its health time', async () => {
    let t = 0;
    const probe = await probeApi(async () => {
      t += 27;
    }, () => t);
    expect(probe).toEqual({ reachable: true, durationMs: 27 });
  });
});

describe('fetchWithTimeout (Supabase client for Google sign-in)', () => {
  test('rejects a request that never answers once the limit passes', async () => {
    const timed = fetchWithTimeout(30, hangingFetch);
    await expect(timed('https://example.supabase.co/auth/v1/token')).rejects.toThrow();
  });

  test("passes through the caller's own abort", async () => {
    const controller = new AbortController();
    const pending = fetchWithTimeout(60_000, hangingFetch)('https://example.supabase.co', { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow();
  });

  test('returns the response when the server answers in time', async () => {
    const ok = { status: 200 } as Response;
    await expect(fetchWithTimeout(1000, (async () => ok) as unknown as typeof fetch)('https://x.test')).resolves.toBe(ok);
  });
});
