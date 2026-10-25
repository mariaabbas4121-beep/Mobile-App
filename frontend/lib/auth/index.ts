// Wires the auth modules to the real platform APIs. Tests build their own
// instances from the factories instead of importing this file.
import 'react-native-url-polyfill/auto';
import { installCryptoPolyfill } from './cryptoPolyfill';
import { createClient } from '@supabase/supabase-js';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import { config } from '../config';
import { createApiClient } from '../api/client';
import { SessionManager } from './sessionManager';
import { createTokenStorage } from './tokenStorage';
import { createGoogleAuth, OAUTH_CALLBACK_PATH } from './googleAuth';

// Real SHA-256 PKCE instead of Supabase's insecure "plain" fallback.
installCryptoPolyfill();

// Closes the auth popup when the redirect lands back in a web build.
WebBrowser.maybeCompleteAuthSession();

export const api = createApiClient({ baseUrl: config.apiUrl });
export const sessionManager = new SessionManager(api, createTokenStorage());

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
    }),
});
