// Wires the auth modules to the real platform APIs. Tests build their own
// instances from the factories instead of importing this file.
import 'react-native-url-polyfill/auto';
import { installCryptoPolyfill } from './cryptoPolyfill';
import { createClient } from '@supabase/supabase-js';
import Constants from 'expo-constants';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import { config } from '../config';
import { createApiClient, type RequestTiming } from '../api/client';
import { fetchWithTimeout, runStartupDiagnostics } from '../api/diagnostics';
import { SessionManager } from './sessionManager';
import { createTokenStorage } from './tokenStorage';
import { createGoogleAuth, OAUTH_CALLBACK_PATH } from './googleAuth';

// Real SHA-256 PKCE instead of Supabase's insecure "plain" fallback.
installCryptoPolyfill();

// Closes the auth popup when the redirect lands back in a web build.
WebBrowser.maybeCompleteAuthSession();

// Development builds log each API call's method, path, status, duration and
// request id (matching the server's log line). Never bodies or tokens.
const logTiming = (t: RequestTiming) =>
  console.info(`[api] ${t.method} ${t.path} -> ${t.status} in ${t.durationMs} ms${t.requestId ? ` (request ${t.requestId})` : ''}`);

export const api = createApiClient({ baseUrl: config.apiUrl, ...(__DEV__ ? { onTiming: logTiming } : {}) });
export const sessionManager = new SessionManager(api, createTokenStorage());

// Supabase calls made by the app itself (Google sign-in only) get the same
// kind of limit as API calls, so a stalled network ends in an error.
const SUPABASE_REQUEST_TIMEOUT_MS = 15_000;

// Expo Go:           exp://<LAN-IP>:8081/--/auth/callback
// Development/store: neighborshare://auth/callback
export const getOAuthRedirectUrl = () => Linking.createURL(OAUTH_CALLBACK_PATH);

export const googleAuth = createGoogleAuth({
  config,
  redirectUrl: getOAuthRedirectUrl,
  openAuthSession: (url, redirectUrl) => WebBrowser.openAuthSessionAsync(url, redirectUrl),
  // Used only for the OAuth handshake: it never persists or refreshes a
  // session (SessionManager owns the tokens), and the PKCE verifier lives in
  // memory for the duration of the sign-in.
  createSupabase: (url, key) =>
    createClient(url, key, {
      auth: { flowType: 'pkce', persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: fetchWithTimeout(SUPABASE_REQUEST_TIMEOUT_MS) },
    }),
  ...(__DEV__ ? { warn: (m: string) => console.warn(m) } : {}),
});

if (__DEV__) {
  void runStartupDiagnostics({
    apiUrl: config.apiUrl,
    metroHostUri: Constants.expoConfig?.hostUri,
    health: () => api.health(),
    warn: (m) => console.warn(m),
    info: (m) => console.info(m),
  });
  // Must be listed under Supabase -> Authentication -> URL Configuration ->
  // Redirect URLs, or Google sign-in never returns to the app. In Expo Go it
  // contains the computer's LAN IP, so it changes when that IP changes.
  console.info(`[auth] Google sign-in redirect URL: ${getOAuthRedirectUrl()}`);
}
