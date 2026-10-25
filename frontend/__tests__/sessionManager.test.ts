import * as SecureStore from 'expo-secure-store';
import { createSecureTokenStorage } from '../lib/auth/tokenStorage';
import { NOW, apiError, fakeApi, services, session } from './support/fakes';

describe('session restoration', () => {
  test('restores nothing when no session is stored', async () => {
    const { sessionManager } = services();
    await expect(sessionManager.restore()).resolves.toBeNull();
  });

  test('restores a stored session', async () => {
    const s = services();
    await s.storage.save(session(1));
    await expect(s.sessionManager.restore()).resolves.toEqual(session(1));
  });

  test('unreadable storage starts signed out instead of crashing', async () => {
    const s = services({
      storage: { load: jest.fn(async () => Promise.reject(new Error('keychain'))), save: jest.fn(), clear: jest.fn(async () => undefined) },
    });
    await expect(s.sessionManager.restore()).resolves.toBeNull();
  });
});

describe('token refresh', () => {
  test('a still-valid token is used without refreshing', async () => {
    const s = services();
    await s.sessionManager.setSession(session(1));
    await expect(s.sessionManager.getAccessToken()).resolves.toBe('access-1');
    expect(s.api.refresh).not.toHaveBeenCalled();
  });

  test('a token about to expire is refreshed first, and the new session is stored', async () => {
    const s = services();
    await s.sessionManager.setSession(session(1, NOW + 30));
    await expect(s.sessionManager.getAccessToken()).resolves.toBe('access-2');
    expect(s.api.refresh).toHaveBeenCalledWith('refresh-1');
    await expect(s.storage.load()).resolves.toEqual(session(2));
  });

  test('concurrent callers share a single refresh request', async () => {
    const s = services();
    await s.sessionManager.setSession(session(1, NOW - 1));
    const tokens = await Promise.all([1, 2, 3, 4].map(() => s.sessionManager.getAccessToken()));
    expect(tokens).toEqual(['access-2', 'access-2', 'access-2', 'access-2']);
    expect(s.api.refresh).toHaveBeenCalledTimes(1);
  });

  test('a rejected refresh token ends the session and emits "expired"', async () => {
    const api = fakeApi();
    api.refresh.mockRejectedValueOnce(apiError(401, 'INVALID_REFRESH_TOKEN'));
    const s = services({ api });
    await s.sessionManager.setSession(session(1, NOW - 1));
    const events: string[] = [];
    s.sessionManager.subscribe((e) => events.push(e));

    await expect(s.sessionManager.getAccessToken()).rejects.toMatchObject({ code: 'INVALID_REFRESH_TOKEN' });
    expect(s.sessionManager.current).toBeNull();
    await expect(s.storage.load()).resolves.toBeNull();
    expect(events).toContain('expired');
  });

  test('a network failure during refresh keeps the session for a later retry', async () => {
    const api = fakeApi();
    api.refresh.mockRejectedValueOnce(apiError(0, 'NETWORK_ERROR'));
    const s = services({ api });
    await s.sessionManager.setSession(session(1, NOW - 1));
    await expect(s.sessionManager.getAccessToken()).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    expect(s.sessionManager.current).toEqual(session(1, NOW - 1));
  });

  test('authorized() refreshes once and retries when the access token is rejected', async () => {
    const s = services();
    await s.sessionManager.setSession(session(1));
    const call = jest.fn(async (token: string) => {
      if (token === 'access-1') throw apiError(401, 'INVALID_TOKEN');
      return `ok with ${token}`;
    });
    await expect(s.sessionManager.authorized(call)).resolves.toBe('ok with access-2');
    expect(call).toHaveBeenCalledTimes(2);
    expect(s.api.refresh).toHaveBeenCalledTimes(1);
  });

  test('authorized() does not retry other errors', async () => {
    const s = services();
    await s.sessionManager.setSession(session(1));
    const call = jest.fn(async () => {
      throw apiError(403, 'ACCOUNT_SUSPENDED');
    });
    await expect(s.sessionManager.authorized(call)).rejects.toMatchObject({ code: 'ACCOUNT_SUSPENDED' });
    expect(call).toHaveBeenCalledTimes(1);
    expect(s.api.refresh).not.toHaveBeenCalled();
  });

  test('a refresh that finishes after sign-out does not resurrect the session', async () => {
    const api = fakeApi();
    let finish: (v: unknown) => void = () => undefined;
    api.refresh.mockImplementationOnce(() => new Promise((r) => (finish = r)));
    const s = services({ api });
    await s.sessionManager.setSession(session(1, NOW - 1));
    const pending = s.sessionManager.getAccessToken();
    await s.sessionManager.signOut();
    finish({ session: session(2) });
    await expect(pending).rejects.toBeTruthy();
    expect(s.sessionManager.current).toBeNull();
  });
});

describe('sign-out', () => {
  test('calls the backend logout with the current token, then clears storage', async () => {
    const s = services();
    await s.sessionManager.setSession(session(1));
    await s.sessionManager.signOut();
    expect(s.api.logout).toHaveBeenCalledWith('access-1', 'local');
    expect(s.sessionManager.current).toBeNull();
    await expect(s.storage.load()).resolves.toBeNull();
  });

  test('clears the local session even when the server cannot be reached', async () => {
    const api = fakeApi();
    api.logout.mockRejectedValueOnce(apiError(0, 'NETWORK_ERROR'));
    const s = services({ api });
    await s.sessionManager.setSession(session(1));
    await s.sessionManager.signOut();
    expect(s.sessionManager.current).toBeNull();
  });
});

describe('secure token storage', () => {
  test('stores tokens in SecureStore, device-only, and removes them on clear', async () => {
    const storage = createSecureTokenStorage();
    await storage.save(session(5));
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith('ns.auth.refreshToken', 'refresh-5', {
      keychainAccessible: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
    });
    await expect(storage.load()).resolves.toEqual(session(5));
    await storage.clear();
    await expect(storage.load()).resolves.toBeNull();
  });
});
