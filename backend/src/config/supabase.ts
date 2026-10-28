import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Config } from './env.js';
import { AppError } from '../lib/errors.js';

// Upper bound for any single HTTP request to Supabase, so a hung connection
// cannot hold an API request open indefinitely.
export const SUPABASE_REQUEST_TIMEOUT_MS = 10_000;

export const fetchWithTimeout: typeof fetch = (input, init) => {
  const timeout = AbortSignal.timeout(SUPABASE_REQUEST_TIMEOUT_MS);
  return fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
};

// The server keeps no browser session; each request supplies its own auth.
const serverAuthOptions = {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  global: { fetch: fetchWithTimeout },
} as const;

export interface SupabaseClients {
  // Publishable key, no user: Supabase Auth calls (sign-up, sign-in, token
  // checks). Database access through it runs as `anon` under RLS.
  anon(): SupabaseClient;
  // Publishable key plus the caller's access token: database access runs as
  // that user, so Row-Level Security applies.
  forUser(accessToken: string): SupabaseClient;
  // Publishable key, a new client each call: for Auth calls that return a
  // session the server must not keep (e.g. verifyOtp). Nothing it stores
  // outlives the request, and it never refreshes on its own.
  ephemeral(): SupabaseClient;
  // Secret key: BYPASSES Row-Level Security. Only for server-side operations
  // whose authorization the backend has already checked.
  admin(): SupabaseClient;
}

export function createSupabaseClients(config: Pick<Config, 'supabase'>): SupabaseClients {
  const { url, publishableKey, secretKey } = config.supabase;
  let anonClient: SupabaseClient | undefined;
  let adminClient: SupabaseClient | undefined;

  return {
    anon() {
      anonClient ??= createClient(url, publishableKey, serverAuthOptions);
      return anonClient;
    },
    forUser(accessToken) {
      return createClient(url, publishableKey, {
        ...serverAuthOptions,
        global: { ...serverAuthOptions.global, headers: { Authorization: `Bearer ${accessToken}` } },
      });
    },
    ephemeral() {
      return createClient(url, publishableKey, serverAuthOptions);
    },
    admin() {
      if (!secretKey) {
        throw AppError.unavailable(
          'This feature is not configured on the server',
          'SERVER_NOT_CONFIGURED',
        );
      }
      adminClient ??= createClient(url, secretKey, serverAuthOptions);
      return adminClient;
    },
  };
}
