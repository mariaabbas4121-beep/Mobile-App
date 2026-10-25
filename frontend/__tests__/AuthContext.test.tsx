import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import { AuthProvider, useAuth } from '../context/AuthContext';
import { apiError, fakeApi, fakeGoogle, onboarding, profile, services, session, NOW } from './support/fakes';

async function renderAuth(s: ReturnType<typeof services>) {
  const wrapper = ({ children }: { children: React.ReactNode }) => <AuthProvider services={s.asServices}>{children}</AuthProvider>;
  const hook = await renderHook(() => useAuth(), { wrapper });
  await waitFor(() => expect(hook.result.current.phase).not.toBe('restoring'));
  return hook;
}

describe('startup restoration', () => {
  test('no saved session: signed out, auth screens open, no API calls', async () => {
    const s = services();
    const { result } = await renderAuth(s);
    expect(result.current.phase).toBe('signedOut');
    expect(result.current.guards.auth).toBe(true);
    expect(result.current.guards.app).toBe(false);
    expect(s.api.me).not.toHaveBeenCalled();
  });

  test('saved session: account loaded from /me and /status, app opens', async () => {
    const s = services();
    await s.storage.save(session(1));
    const { result } = await renderAuth(s);
    expect(result.current.phase).toBe('signedIn');
    expect(result.current.profile?.displayName).toBe('Sara');
    expect(result.current.guards.app).toBe(true);
    expect(s.api.me).toHaveBeenCalledWith('access-1');
    expect(s.api.status).toHaveBeenCalledWith('access-1');
  });

  test('expired saved session is refreshed before loading the account', async () => {
    const s = services();
    await s.storage.save(session(1, NOW - 10));
    const { result } = await renderAuth(s);
    expect(result.current.phase).toBe('signedIn');
    expect(s.api.refresh).toHaveBeenCalledTimes(1);
    expect(s.api.me).toHaveBeenCalledWith('access-2');
  });

  test('saved session whose refresh is rejected: signed out, storage cleared', async () => {
    const api = fakeApi();
    api.refresh.mockRejectedValue(apiError(401, 'INVALID_REFRESH_TOKEN'));
    const s = services({ api });
    await s.storage.save(session(1, NOW - 10));
    const { result } = await renderAuth(s);
    expect(result.current.phase).toBe('signedOut');
    await expect(s.storage.load()).resolves.toBeNull();
  });

  test('saved session but server unreachable: session kept, retry screen, app not opened', async () => {
    const api = fakeApi();
    api.me.mockRejectedValueOnce(apiError(0, 'NETWORK_ERROR'));
    const s = services({ api });
    await s.storage.save(session(1));
    const { result } = await renderAuth(s);
    expect(result.current.phase).toBe('unreachable');
    expect(result.current.guards).toMatchObject({ unreachable: true, app: false, auth: false });
    await expect(s.storage.load()).resolves.toEqual(session(1));

    await act(() => result.current.reloadAccount());
    expect(result.current.phase).toBe('signedIn');
  });
});

describe('email/password sign-in and sign-out', () => {
  test('signIn stores the session and loads the account', async () => {
    const s = services();
    const { result } = await renderAuth(s);
    await act(() => result.current.signIn(' Sara@Example.com ', 'pw'));
    expect(s.api.login).toHaveBeenCalledWith({ email: 'sara@example.com', password: 'pw' });
    expect(result.current.phase).toBe('signedIn');
    await expect(s.storage.load()).resolves.toEqual(session(1));
  });

  test('failed signIn leaves the user signed out', async () => {
    const api = fakeApi();
    api.login.mockRejectedValueOnce(apiError(401, 'INVALID_CREDENTIALS'));
    const s = services({ api });
    const { result } = await renderAuth(s);
    await expect(act(() => result.current.signIn('a@example.com', 'bad'))).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    expect(result.current.phase).toBe('signedOut');
    await expect(s.storage.load()).resolves.toBeNull();
  });

  test('signUp with confirmation required does not sign in', async () => {
    const s = services();
    const { result } = await renderAuth(s);
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.signUp({ email: 'New@Example.com', password: 'correct1horse', displayName: ' Ali ' });
    });
    expect(outcome).toEqual({ emailConfirmationRequired: true, message: 'generic' });
    expect(s.api.signup).toHaveBeenCalledWith({ email: 'new@example.com', password: 'correct1horse', displayName: 'Ali' });
    expect(result.current.phase).toBe('signedOut');
  });

  test('signOut calls the backend, clears storage and closes protected screens', async () => {
    const s = services();
    await s.storage.save(session(1));
    const { result } = await renderAuth(s);
    await act(() => result.current.signOut());
    expect(s.api.logout).toHaveBeenCalledWith('access-1', 'local');
    expect(result.current.phase).toBe('signedOut');
    expect(result.current.guards.app).toBe(false);
    await expect(s.storage.load()).resolves.toBeNull();
  });

  test('a session ending during use signs the user out everywhere with a notice', async () => {
    const api = fakeApi();
    const s = services({ api });
    await s.storage.save(session(1));
    const { result } = await renderAuth(s);
    api.updateProfile.mockRejectedValueOnce(apiError(401, 'INVALID_TOKEN'));
    api.refresh.mockRejectedValueOnce(apiError(401, 'INVALID_REFRESH_TOKEN'));

    await act(async () => {
      await result.current.updateProfile({ bio: 'hi' }).catch(() => undefined);
    });
    expect(result.current.phase).toBe('signedOut');
    expect(result.current.sessionEndedNotice).toBe(true);
  });
});

describe('account status', () => {
  test('a suspended account opens only the blocked screen', async () => {
    const api = fakeApi();
    api.status.mockResolvedValue(onboarding({ accountStatus: 'suspended' }));
    api.me.mockResolvedValue({ user: { id: 'user-1' }, profile: profile({ accountStatus: 'suspended' }) });
    const s = services({ api });
    await s.storage.save(session(1));
    const { result } = await renderAuth(s);
    expect(result.current.guards).toMatchObject({ blocked: true, app: false, onboarding: false });
  });

  test('a 403 from the server during use reloads the status so navigation follows', async () => {
    const api = fakeApi();
    const s = services({ api });
    await s.storage.save(session(1));
    const { result } = await renderAuth(s);
    expect(result.current.guards.app).toBe(true);

    api.updateProfile.mockRejectedValueOnce(apiError(403, 'ACCOUNT_SUSPENDED'));
    api.status.mockResolvedValue(onboarding({ accountStatus: 'suspended' }));
    await act(async () => {
      await result.current.updateProfile({ bio: 'x' }).catch(() => undefined);
    });
    expect(result.current.guards).toMatchObject({ blocked: true, app: false });
  });

  test('an incomplete profile opens onboarding, and completing it opens the app', async () => {
    const api = fakeApi();
    api.status.mockResolvedValue(onboarding({}, false));
    const s = services({ api });
    await s.storage.save(session(1));
    const { result } = await renderAuth(s);
    expect(result.current.guards).toMatchObject({ onboarding: true, app: false });

    api.status.mockResolvedValue(onboarding());
    await act(async () => {
      await result.current.updateProfile({ displayName: 'Sara', city: 'Lahore', neighborhood: 'Gulberg' });
    });
    expect(api.updateProfile).toHaveBeenCalledWith('access-1', { displayName: 'Sara', city: 'Lahore', neighborhood: 'Gulberg' });
    expect(result.current.guards).toMatchObject({ onboarding: false, app: true });
  });
});

describe('Google sign-in through the shared session', () => {
  test('success stores the Supabase tokens and loads the account via the backend', async () => {
    const s = services();
    const { result } = await renderAuth(s);
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.signInWithGoogle();
    });
    expect(outcome).toBe('signedIn');
    await expect(s.storage.load()).resolves.toEqual(session(9));
    expect(s.api.me).toHaveBeenCalledWith('access-9');
    expect(result.current.phase).toBe('signedIn');
  });

  test('cancellation changes nothing', async () => {
    const google = fakeGoogle({ signIn: jest.fn(async () => ({ type: 'cancelled' })) });
    const s = services({ google });
    const { result } = await renderAuth(s);
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.signInWithGoogle();
    });
    expect(outcome).toBe('cancelled');
    expect(result.current.phase).toBe('signedOut');
    expect(s.api.me).not.toHaveBeenCalled();
  });

  test('the same OAuth session delivered twice is applied once', async () => {
    const s = services();
    const { result } = await renderAuth(s);
    await act(async () => {
      await Promise.all([result.current.signInWithGoogle(), result.current.completeOAuthCallback({ code: 'abc' })]);
    });
    expect(s.api.me).toHaveBeenCalledTimes(1);
    expect(result.current.phase).toBe('signedIn');
  });
});
