import type { Session as SupabaseSession, SupabaseClient } from '@supabase/supabase-js';
import type { AppConfig } from '../config';
import type { Session } from '../api/types';

// Google sign-in through Supabase Auth, using the PKCE flow:
//   1. Supabase builds the Google authorization URL and keeps a one-time code
//      verifier in memory.
//   2. The system browser runs Google's consent screen, then Supabase
//      redirects to this app's deep link with a one-time `code`.
//   3. The code and verifier are exchanged for a Supabase session.
// The resulting tokens are handed to the app's SessionManager; this module
// never stores or refreshes them. The backend accepts the access token like
// any other Supabase token.

export const OAUTH_CALLBACK_PATH = 'auth/callback';

export type OAuthErrorCode =
  | 'NOT_CONFIGURED' // Supabase URL or publishable key missing in the app
  | 'PROVIDER_ERROR' // Supabase or Google reported an error
  | 'INVALID_CALLBACK' // callback missing a code or from an unexpected URL
  | 'EXCHANGE_FAILED' // code expired, already used, or verifier lost
  | 'NETWORK_ERROR';

export class OAuthError extends Error {
  constructor(
    readonly code: OAuthErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'OAuthError';
  }
}

export type GoogleSignInResult = { type: 'success'; session: Session } | { type: 'cancelled' };

export type CallbackParams = Record<string, string | string[] | undefined>;

export interface BrowserResult {
  type: string; // 'success' | 'cancel' | 'dismiss' | 'locked' | ...
  url?: string;
}

export interface GoogleAuthDeps {
  config: Pick<AppConfig, 'supabaseUrl' | 'supabasePublishableKey'>;
  redirectUrl: () => string;
  openAuthSession: (url: string, redirectUrl: string) => Promise<BrowserResult>;
  createSupabase: (url: string, key: string) => SupabaseClient;
}

const MESSAGES = {
  notConfigured: 'Google sign-in is not set up in this build of the app.',
  provider: 'Google sign-in could not be completed. Please try again.',
  invalid: 'The sign-in response was not valid. Please try again.',
  exchange: 'This sign-in link has expired or was already used. Please try again.',
  network: 'Could not reach the sign-in service. Check your connection and try again.',
};

export function toAppSession(s: SupabaseSession): Session {
  return {
    accessToken: s.access_token,
    refreshToken: s.refresh_token,
    tokenType: 'bearer',
    expiresIn: s.expires_in,
    expiresAt: s.expires_at ?? null,
  };
}

// Reads query and fragment parameters (Supabase may use either for errors).
export function parseCallbackUrl(url: string): Record<string, string> {
  const params: Record<string, string> = {};
  const queryStart = url.indexOf('?');
  const hashStart = url.indexOf('#');
  const parts: string[] = [];
  if (queryStart >= 0) parts.push(url.slice(queryStart + 1, hashStart > queryStart ? hashStart : undefined));
  if (hashStart >= 0) parts.push(url.slice(hashStart + 1));
  for (const part of parts) {
    for (const pair of part.split('&')) {
      if (!pair) continue;
      const [rawKey, ...rest] = pair.split('=');
      try {
        params[decodeURIComponent(rawKey ?? '')] = decodeURIComponent(rest.join('=').replace(/\+/g, ' '));
      } catch {
        // Malformed encoding: ignore that pair.
      }
    }
  }
  return params;
}

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const stripQuery = (url: string) => url.split(/[?#]/)[0] ?? url;

export function createGoogleAuth(deps: GoogleAuthDeps) {
  let client: SupabaseClient | null = null;
  let inFlight: Promise<GoogleSignInResult> | null = null;
  // One exchange per authorization code, however many times its callback
  // arrives (browser result and deep-link route can both deliver it).
  const exchanges = new Map<string, Promise<GoogleSignInResult>>();

  function supabase(): SupabaseClient {
    const { supabaseUrl, supabasePublishableKey } = deps.config;
    if (!supabaseUrl || !supabasePublishableKey) throw new OAuthError('NOT_CONFIGURED', MESSAGES.notConfigured);
    client ??= deps.createSupabase(supabaseUrl, supabasePublishableKey);
    return client;
  }

  function completeFromParams(params: CallbackParams): Promise<GoogleSignInResult> {
    const error = first(params.error);
    if (error) {
      // The user declined on Google's consent screen.
      if (error === 'access_denied') return Promise.resolve({ type: 'cancelled' });
      return Promise.reject(new OAuthError('PROVIDER_ERROR', MESSAGES.provider));
    }
    const code = first(params.code);
    if (!code || code.length > 512) return Promise.reject(new OAuthError('INVALID_CALLBACK', MESSAGES.invalid));

    const existing = exchanges.get(code);
    if (existing) return existing;

    const flowId = first(params.sb_flow_id);
    const exchange = (async (): Promise<GoogleSignInResult> => {
      let result;
      try {
        result = await supabase().auth.exchangeCodeForSession(code, flowId ? { flowId } : undefined);
      } catch (err) {
        if (err instanceof OAuthError) throw err;
        throw new OAuthError('NETWORK_ERROR', MESSAGES.network);
      }
      if (result.error || !result.data.session) {
        const status = (result.error as { status?: number } | null)?.status;
        if (status === undefined || status === 0 || status >= 500) throw new OAuthError('NETWORK_ERROR', MESSAGES.network);
        throw new OAuthError('EXCHANGE_FAILED', MESSAGES.exchange);
      }
      return { type: 'success', session: toAppSession(result.data.session) };
    })();
    exchanges.set(code, exchange);
    return exchange;
  }

  function completeFromUrl(url: string): Promise<GoogleSignInResult> {
    if (stripQuery(url) !== stripQuery(deps.redirectUrl())) {
      return Promise.reject(new OAuthError('INVALID_CALLBACK', MESSAGES.invalid));
    }
    return completeFromParams(parseCallbackUrl(url));
  }

  // Starts the browser flow. Repeated taps while one is open share it.
  function signIn(): Promise<GoogleSignInResult> {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const redirectTo = deps.redirectUrl();
      const { data, error } = await supabase().auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo, skipBrowserRedirect: true, queryParams: { prompt: 'select_account' } },
      });
      if (error || !data?.url) throw new OAuthError('PROVIDER_ERROR', MESSAGES.provider);

      const result = await deps.openAuthSession(data.url, redirectTo);
      if (result.type !== 'success' || !result.url) return { type: 'cancelled' } as const;
      return completeFromUrl(result.url);
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  return {
    signIn,
    completeFromParams,
    completeFromUrl,
    isConfigured: () => Boolean(deps.config.supabaseUrl && deps.config.supabasePublishableKey),
  };
}

export type GoogleAuth = ReturnType<typeof createGoogleAuth>;
