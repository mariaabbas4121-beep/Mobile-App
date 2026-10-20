import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Config } from './env.js';
import { AppError } from '../lib/errors.js';

// The server keeps no browser session; each request supplies its own auth.
const serverAuthOptions = {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
} as const;

export interface SupabaseClients {
  // Publishable key, no user: Supabase Auth calls (sign-up, sign-in, token
  // checks). Database access through it runs as `anon` under RLS.
  anon(): SupabaseClient;
  // Publishable key plus the caller's access token: database access runs as
  // that user, so Row-Level Security applies.
  forUser(accessToken: string): SupabaseClient;
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
        global: { headers: { Authorization: `Bearer ${accessToken}` } },
      });
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
