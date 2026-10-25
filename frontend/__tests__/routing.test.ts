import { routeGuards } from '../lib/auth/routing';
import { readConfig } from '../lib/config';
import { onboarding } from './support/fakes';

const open = (g: ReturnType<typeof routeGuards>) => Object.entries(g).filter(([, v]) => v).map(([k]) => k);

describe('route guards: exactly one group is open', () => {
  test.each([
    ['restoring (splash showing)', { phase: 'restoring' as const, onboarding: null }, ['auth']],
    ['signed out', { phase: 'signedOut' as const, onboarding: null }, ['auth']],
    ['server unreachable with a saved session', { phase: 'unreachable' as const, onboarding: null }, ['unreachable']],
    ['active, profile complete', { phase: 'signedIn' as const, onboarding: onboarding() }, ['app']],
    ['active, profile incomplete', { phase: 'signedIn' as const, onboarding: onboarding({}, false) }, ['onboarding']],
    ['restricted', { phase: 'signedIn' as const, onboarding: onboarding({ accountStatus: 'restricted' }) }, ['app']],
    ['suspended', { phase: 'signedIn' as const, onboarding: onboarding({ accountStatus: 'suspended' }) }, ['blocked']],
    [
      'suspended with an incomplete profile (blocked wins, no loop to onboarding)',
      { phase: 'signedIn' as const, onboarding: onboarding({ accountStatus: 'suspended' }, false) },
      ['blocked'],
    ],
    ['deletion pending', { phase: 'signedIn' as const, onboarding: onboarding({ accountStatus: 'deletion_pending' }) }, ['blocked']],
  ])('%s', (_label, input, expected) => {
    expect(open(routeGuards(input))).toEqual(expected);
  });

  test('protected app screens are never open without a loaded account', () => {
    expect(routeGuards({ phase: 'signedIn', onboarding: null }).app).toBe(false);
  });
});

describe('public configuration', () => {
  const env = {
    EXPO_PUBLIC_API_URL: 'http://192.168.1.20:4000/',
    EXPO_PUBLIC_SUPABASE_URL: 'https://abc.supabase.co',
    EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_abc',
  };

  test('reads and normalises the public values', () => {
    expect(readConfig(env)).toEqual({
      apiUrl: 'http://192.168.1.20:4000',
      supabaseUrl: 'https://abc.supabase.co',
      supabasePublishableKey: 'sb_publishable_abc',
      problems: [],
    });
  });

  test('refuses a secret key placed in the public variable', () => {
    const c = readConfig({ ...env, EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_secret_should_never_ship' });
    expect(c.supabasePublishableKey).toBeNull();
    expect(c.problems.join()).toContain('SECRET');
    expect(JSON.stringify(c)).not.toContain('sb_secret_should_never_ship');
  });

  test('refuses a legacy service_role JWT', () => {
    const payload = btoa(JSON.stringify({ role: 'service_role' })).replace(/=+$/, '');
    expect(readConfig({ ...env, EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: `eyJhbGciOiJIUzI1NiJ9.${payload}.sig` }).supabasePublishableKey).toBeNull();
  });

  test('treats missing or placeholder values as not configured', () => {
    const c = readConfig({ EXPO_PUBLIC_API_URL: 'http://YOUR_DEVELOPMENT_MACHINE_IP:4000' });
    expect(c).toMatchObject({ apiUrl: null, supabaseUrl: null, supabasePublishableKey: null });
    expect(c.problems).toHaveLength(3);
  });
});
