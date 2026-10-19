import { createClient } from '@supabase/supabase-js';
import { config } from './env.js';

// Thrown when a Supabase-backed operation runs before credentials are set.
// The message is safe to return to clients; it names no values.
export class ConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigurationError';
    this.statusCode = 503;
    this.expose = true;
  }
}

const PLACEHOLDER = /YOUR_PROJECT|YOUR_PUBLISHABLE_KEY|YOUR_SECRET_KEY/;
const isSet = (value) => Boolean(value) && !PLACEHOLDER.test(value);

// The server has no browser session to keep; each request supplies its own auth.
const serverAuthOptions = {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
};

let publicClient;
let adminClient;

export function isSupabaseConfigured() {
  return isSet(config.supabase.url) && isSet(config.supabase.publishableKey);
}

// Client using the publishable key, for Supabase Auth calls and token
// verification. Database and storage access through it is limited by
// Row-Level Security. Created on first use so the API can start without
// credentials.
export function getSupabaseClient() {
  if (!isSupabaseConfigured()) {
    throw new ConfigurationError(
      'Supabase is not configured on the server. Set SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY.',
    );
  }
  publicClient ??= createClient(
    config.supabase.url,
    config.supabase.publishableKey,
    serverAuthOptions,
  );
  return publicClient;
}

// Client using the secret key, which BYPASSES Row-Level Security. Use it only
// in server-side operations that have already checked the caller is allowed
// to perform them, never for routine queries on a user's behalf.
export function getSupabaseAdminClient() {
  if (!isSet(config.supabase.url) || !isSet(config.supabase.secretKey)) {
    throw new ConfigurationError(
      'Supabase admin access is not configured on the server. Set SUPABASE_URL and SUPABASE_SECRET_KEY.',
    );
  }
  adminClient ??= createClient(config.supabase.url, config.supabase.secretKey, serverAuthOptions);
  return adminClient;
}
