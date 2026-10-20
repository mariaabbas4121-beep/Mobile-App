import type { Config } from '../src/config/env.js';
import { createLogger } from '../src/lib/logger.js';

// Fake, syntactically valid configuration for unit tests. It points at an
// unroutable host and contains no real key.
export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    nodeEnv: 'test',
    port: 0,
    logLevel: 'silent',
    corsOrigins: ['http://localhost:8081'],
    trustProxyHops: 0,
    supabase: {
      url: 'https://unit-test.invalid',
      publishableKey: 'sb_publishable_unit_test_placeholder_key',
      secretKey: undefined,
    },
    auth: { emailRedirectUrl: undefined, oauthRedirectUrl: undefined },
    ...overrides,
  };
}

export const silentLogger = createLogger({ logLevel: 'silent' });

export const validEnv = {
  NODE_ENV: 'test',
  SUPABASE_URL: 'https://abcdefghijklmnop.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_0123456789abcdefghij',
};
