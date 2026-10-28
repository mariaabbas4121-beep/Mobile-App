import type { SupabaseClient } from '@supabase/supabase-js';
import { createGoogleAuth, OAuthError, parseCallbackUrl, type BrowserResult } from '../lib/auth/googleAuth';

const REDIRECT = 'neighborshare://auth/callback';
const supabaseSession = {
  access_token: 'sb-access',
  refresh_token: 'sb-refresh',
  expires_in: 3600,
  expires_at: 1_800_003_600,
  token_type: 'bearer',
  user: { id: 'u' },
};

function setup(opts: { configured?: boolean; browser?: BrowserResult; exchange?: jest.Mock; oauthError?: boolean } = {}) {
  const exchange =
    opts.exchange ?? jest.fn(async () => ({ data: { session: supabaseSession, user: { id: 'u' } }, error: null }));
  const signInWithOAuth = jest.fn(async () =>
    opts.oauthError
      ? { data: { url: null, provider: 'google' }, error: { message: 'provider disabled' } }
      : { data: { url: 'https://project.supabase.co/auth/v1/authorize?provider=google', provider: 'google' }, error: null },
  );
  const createSupabase = jest.fn(() => ({ auth: { signInWithOAuth, exchangeCodeForSession: exchange } }) as unknown as SupabaseClient);
  const openAuthSession = jest.fn(async () => opts.browser ?? { type: 'success', url: `${REDIRECT}?code=abc123` });
  const warn = jest.fn();
  const google = createGoogleAuth({
    lateCallbackMs: 30,
    warn,
    config:
      opts.configured === false
        ? { supabaseUrl: null, supabasePublishableKey: null }
        : { supabaseUrl: 'https://project.supabase.co', supabasePublishableKey: 'sb_publishable_x' },
    redirectUrl: () => REDIRECT,
    openAuthSession,
    createSupabase,
  });
  return { google, exchange, signInWithOAuth, openAuthSession, createSupabase, warn };
}

const rejection = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as OAuthError;
  }
  throw new Error('expected rejection');
};

const waitUntil = async (check: () => boolean) => {
  for (let i = 0; i < 50 && !check(); i++) await new Promise((r) => setTimeout(r, 1));
};

describe('Google sign-in', () => {
  test('success: PKCE URL opened with the app redirect, code exchanged, app session returned', async () => {
    const { google, exchange, signInWithOAuth, openAuthSession } = setup();
    const result = await google.signIn();

    expect(signInWithOAuth).toHaveBeenCalledWith({
      provider: 'google',
      options: { redirectTo: REDIRECT, skipBrowserRedirect: true, queryParams: { prompt: 'select_account' } },
    });
    expect(openAuthSession).toHaveBeenCalledWith(expect.stringContaining('/auth/v1/authorize'), REDIRECT);
    expect(exchange).toHaveBeenCalledWith('abc123', undefined);
    expect(result).toEqual({
      type: 'success',
      session: { accessToken: 'sb-access', refreshToken: 'sb-refresh', tokenType: 'bearer', expiresIn: 3600, expiresAt: 1_800_003_600 },
    });
  });

  test('passes the Supabase flow id from the callback when present', async () => {
    const { google, exchange } = setup({ browser: { type: 'success', url: `${REDIRECT}?code=abc&sb_flow_id=flow-1` } });
    await google.signIn();
    expect(exchange).toHaveBeenCalledWith('abc', { flowId: 'flow-1' });
  });

  test.each(['cancel', 'dismiss'])('browser result "%s" with no redirect is a cancellation, not an error', async (type) => {
    const { google, exchange } = setup({ browser: { type } });
    await expect(google.signIn()).resolves.toEqual({ type: 'cancelled' });
    expect(exchange).not.toHaveBeenCalled();
  });

  test('a dismissed browser that never returned explains the redirect allow-list (development hint)', async () => {
    const { google, warn } = setup({ browser: { type: 'dismiss' } });
    await google.signIn();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(REDIRECT));
    expect(warn.mock.calls[0][0]).toContain('Redirect URLs');
  });

  test('an explicit cancel resolves at once, without the hint', async () => {
    const { google, warn } = setup({ browser: { type: 'cancel' } });
    await google.signIn();
    expect(warn).not.toHaveBeenCalled();
  });

  test('Android: "dismiss" reported just before the deep link still completes sign-in', async () => {
    // expo-web-browser resolves "dismiss" when the app becomes active; the
    // redirect then reaches the callback route a moment later.
    let finishBrowser!: (r: BrowserResult) => void;
    const { google, exchange, openAuthSession } = setup();
    openAuthSession.mockImplementation(() => new Promise((resolve) => (finishBrowser = resolve)));
    const signingIn = google.signIn();
    await waitUntil(() => openAuthSession.mock.calls.length > 0);
    finishBrowser({ type: 'dismiss' });
    await new Promise((r) => setTimeout(r, 5));
    const viaRoute = google.completeFromParams({ code: 'late-code' });

    const [a, b] = await Promise.all([signingIn, viaRoute]);
    expect(a).toMatchObject({ type: 'success' });
    expect(b).toEqual(a);
    expect(exchange).toHaveBeenCalledTimes(1);
    expect(exchange).toHaveBeenCalledWith('late-code', undefined);
  });

  test('Android: deep link arriving before "dismiss" is used instead of cancelling', async () => {
    let finishBrowser!: (r: BrowserResult) => void;
    const { google, exchange, openAuthSession } = setup();
    openAuthSession.mockImplementation(() => new Promise((resolve) => (finishBrowser = resolve)));
    const signingIn = google.signIn();
    await waitUntil(() => openAuthSession.mock.calls.length > 0);
    const viaRoute = google.completeFromParams({ code: 'early-code' });
    finishBrowser({ type: 'dismiss' });
    await expect(signingIn).resolves.toMatchObject({ type: 'success' });
    await viaRoute;
    expect(exchange).toHaveBeenCalledTimes(1);
  });

  test('a provider error delivered by deep link after "dismiss" is reported, not swallowed', async () => {
    let finishBrowser!: (r: BrowserResult) => void;
    const { google, openAuthSession } = setup();
    openAuthSession.mockImplementation(() => new Promise((resolve) => (finishBrowser = resolve)));
    const signingIn = google.signIn();
    await waitUntil(() => openAuthSession.mock.calls.length > 0);
    finishBrowser({ type: 'dismiss' });
    await new Promise((r) => setTimeout(r, 5));
    google.completeFromParams({ error: 'server_error' }).catch(() => undefined);
    expect((await rejection(signingIn)).code).toBe('PROVIDER_ERROR');
  });

  test('declining on the Google consent screen is a cancellation', async () => {
    const { google } = setup({ browser: { type: 'success', url: `${REDIRECT}?error=access_denied&error_description=denied` } });
    await expect(google.signIn()).resolves.toEqual({ type: 'cancelled' });
  });

  test('provider errors in the callback are reported without their details', async () => {
    const { google } = setup({ browser: { type: 'success', url: `${REDIRECT}#error=server_error&error_description=secret%20detail` } });
    const err = await rejection(google.signIn());
    expect(err).toBeInstanceOf(OAuthError);
    expect(err.code).toBe('PROVIDER_ERROR');
    expect(err.message).not.toContain('secret detail');
  });

  test('a callback without a code is invalid', async () => {
    const { google } = setup({ browser: { type: 'success', url: `${REDIRECT}?state=x` } });
    expect((await rejection(google.signIn())).code).toBe('INVALID_CALLBACK');
  });

  test('a callback to an unexpected URL is rejected and never exchanged', async () => {
    const { google, exchange } = setup({ browser: { type: 'success', url: 'evil://auth/callback?code=stolen' } });
    expect((await rejection(google.signIn())).code).toBe('INVALID_CALLBACK');
    expect(exchange).not.toHaveBeenCalled();
  });

  test('an expired or reused code reports EXCHANGE_FAILED', async () => {
    const exchange = jest.fn(async () => ({ data: { session: null, user: null }, error: { status: 400, code: 'flow_state_expired' } }));
    const { google } = setup({ exchange });
    expect((await rejection(google.signIn())).code).toBe('EXCHANGE_FAILED');
  });

  test('a network failure during the exchange reports NETWORK_ERROR', async () => {
    const exchange = jest.fn(async () => ({ data: { session: null, user: null }, error: { status: 0, name: 'AuthRetryableFetchError' } }));
    const { google } = setup({ exchange });
    expect((await rejection(google.signIn())).code).toBe('NETWORK_ERROR');
  });

  test('missing Supabase configuration fails before opening a browser', async () => {
    const { google, openAuthSession, createSupabase } = setup({ configured: false });
    expect(google.isConfigured()).toBe(false);
    expect((await rejection(google.signIn())).code).toBe('NOT_CONFIGURED');
    expect(openAuthSession).not.toHaveBeenCalled();
    expect(createSupabase).not.toHaveBeenCalled();
  });

  test('Supabase refusing to start the flow is a provider error', async () => {
    const { google, openAuthSession } = setup({ oauthError: true });
    expect((await rejection(google.signIn())).code).toBe('PROVIDER_ERROR');
    expect(openAuthSession).not.toHaveBeenCalled();
  });

  test('repeated taps while the browser is open share one flow', async () => {
    const { google, openAuthSession } = setup();
    const [a, b] = await Promise.all([google.signIn(), google.signIn()]);
    expect(a).toEqual(b);
    expect(openAuthSession).toHaveBeenCalledTimes(1);
  });

  test('the same code delivered twice (browser result and deep link) is exchanged once', async () => {
    const { google, exchange } = setup();
    const viaBrowser = google.signIn();
    const viaDeepLink = google.completeFromParams({ code: 'abc123' });
    const [a, b] = await Promise.all([viaBrowser, viaDeepLink]);
    expect(a).toEqual(b);
    expect(exchange).toHaveBeenCalledTimes(1);
  });
});

describe('parseCallbackUrl', () => {
  test('reads query and fragment parameters and decodes them', () => {
    expect(parseCallbackUrl('neighborshare://auth/callback?code=a%2Bb&x=1#error=bad&error_description=two+words')).toEqual({
      code: 'a+b',
      x: '1',
      error: 'bad',
      error_description: 'two words',
    });
  });
});
