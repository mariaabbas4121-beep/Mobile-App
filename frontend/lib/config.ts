// Public runtime configuration. Expo copies EXPO_PUBLIC_* values into the app
// bundle at build time, where anyone can read them, so only public values may
// be configured here. Each variable must be read with its full literal name
// (process.env.EXPO_PUBLIC_X) for Expo to inline it.

export interface AppConfig {
  // Base URL of the NeighborShare API, without the /api/v1 suffix.
  apiUrl: string | null;
  // Supabase project URL and publishable key, used only to start Google
  // sign-in and exchange its code for a session. Everything else goes through
  // the API.
  supabaseUrl: string | null;
  supabasePublishableKey: string | null;
  // Human-readable problems, for development diagnostics. Never contains values.
  problems: string[];
}

const trimmed = (v: string | undefined) => (v && v.trim() ? v.trim() : null);

function httpUrl(value: string | null, name: string, problems: string[]): string | null {
  if (!value) {
    problems.push(`${name} is not set`);
    return null;
  }
  if (!/^https?:\/\/[^\s/]+/i.test(value) || /YOUR_/.test(value)) {
    problems.push(`${name} must be an http(s) URL`);
    return null;
  }
  return value.replace(/\/+$/, '');
}

export function readConfig(env: Record<string, string | undefined>): AppConfig {
  const problems: string[] = [];
  const apiUrl = httpUrl(trimmed(env.EXPO_PUBLIC_API_URL), 'EXPO_PUBLIC_API_URL', problems);
  const supabaseUrl = httpUrl(trimmed(env.EXPO_PUBLIC_SUPABASE_URL), 'EXPO_PUBLIC_SUPABASE_URL', problems);

  let supabasePublishableKey = trimmed(env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY);
  if (!supabasePublishableKey || /YOUR_/.test(supabasePublishableKey)) {
    problems.push('EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY is not set');
    supabasePublishableKey = null;
  } else if (supabasePublishableKey.startsWith('sb_secret_') || looksLikeServiceRoleJwt(supabasePublishableKey)) {
    // A secret key would be readable by anyone who has the app. Refuse it.
    problems.push('EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY holds a SECRET key; use the publishable key');
    supabasePublishableKey = null;
  }

  return { apiUrl, supabaseUrl, supabasePublishableKey, problems };
}

function looksLikeServiceRoleJwt(key: string): boolean {
  const payload = key.split('.')[1];
  if (!payload) return false;
  try {
    const json = globalThis.atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    return /"role"\s*:\s*"service_role"/.test(json);
  } catch {
    return false;
  }
}

export const config: AppConfig = readConfig({
  EXPO_PUBLIC_API_URL: process.env.EXPO_PUBLIC_API_URL,
  EXPO_PUBLIC_SUPABASE_URL: process.env.EXPO_PUBLIC_SUPABASE_URL,
  EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
});
