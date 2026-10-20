import { describe, expect, test } from 'vitest';
import { ConfigValidationError, loadConfig } from '../../src/config/env.js';
import { validEnv } from '../helpers.js';

function problemsFor(env: NodeJS.ProcessEnv): string[] {
  try {
    loadConfig(env);
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigValidationError);
    return (err as ConfigValidationError).problems;
  }
  throw new Error('expected loadConfig to throw');
}

describe('loadConfig', () => {
  test('accepts a valid environment and applies defaults', () => {
    const config = loadConfig(validEnv);
    expect(config.port).toBe(4000);
    expect(config.corsOrigins).toEqual(['http://localhost:8081']);
    expect(config.supabase.secretKey).toBeUndefined();
    expect(config.logLevel).toBe('silent');
  });

  test('parses comma-separated CORS origins into origins', () => {
    const config = loadConfig({
      ...validEnv,
      FRONTEND_ORIGIN: 'http://localhost:8081, https://app.example.com/path',
    });
    expect(config.corsOrigins).toEqual(['http://localhost:8081', 'https://app.example.com']);
  });

  test('treats an empty secret key as absent', () => {
    expect(loadConfig({ ...validEnv, SUPABASE_SECRET_KEY: '  ' }).supabase.secretKey).toBeUndefined();
  });

  test('fails when Supabase variables are missing', () => {
    const problems = problemsFor({ NODE_ENV: 'test' });
    expect(problems.some((p) => p.startsWith('SUPABASE_URL'))).toBe(true);
    expect(problems.some((p) => p.startsWith('SUPABASE_PUBLISHABLE_KEY'))).toBe(true);
  });

  test('rejects values left at the .env.example placeholders', () => {
    const problems = problemsFor({
      ...validEnv,
      SUPABASE_URL: 'https://YOUR_PROJECT.supabase.co',
      SUPABASE_PUBLISHABLE_KEY: 'YOUR_PUBLISHABLE_KEY_padding_padding',
    });
    expect(problems).toHaveLength(2);
  });

  test('rejects an invalid port, URL and NODE_ENV', () => {
    const problems = problemsFor({
      ...validEnv,
      PORT: 'abc',
      SUPABASE_URL: 'not a url',
      NODE_ENV: 'staging',
    });
    expect(problems.map((p) => p.split(' ')[0]).sort()).toEqual(['NODE_ENV', 'PORT', 'SUPABASE_URL']);
    expect(problems).toContain('PORT has an invalid value');
  });

  test('requires https for Supabase in production', () => {
    const problems = problemsFor({ ...validEnv, NODE_ENV: 'production', SUPABASE_URL: 'http://localhost:54321' });
    expect(problems).toEqual(['SUPABASE_URL must use https in production']);
  });

  test('error messages never contain the submitted values', () => {
    const secretLooking = 'sb_secret_should_never_be_printed';
    const err = (() => {
      try {
        loadConfig({ ...validEnv, SUPABASE_URL: secretLooking, SUPABASE_SECRET_KEY: 'short' });
      } catch (e) {
        return e as Error;
      }
      throw new Error('expected failure');
    })();
    expect(err.message).not.toContain(secretLooking);
    expect(err.message).not.toContain('short\n');
    expect(err.message).toContain('SUPABASE_SECRET_KEY');
  });
});
