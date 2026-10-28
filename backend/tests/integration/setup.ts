// Shared setup for tests that run against a real Supabase project.
//
// Safety: refuses to run unless INTEGRATION_PROJECT_REF explicitly names the
// project in SUPABASE_URL, NODE_ENV is not production, and a secret key is
// available for creating and deleting throwaway users. Every user created
// here is deleted in afterAll; none receive email.
import { randomUUID } from 'node:crypto';
import dotenv from 'dotenv';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { loadConfig, type Config } from '../../src/config/env.js';
import { createApp } from '../../src/app.js';
import { createSupabaseClients } from '../../src/config/supabase.js';
import { createSupabaseAuthGateway } from '../../src/auth/supabase-auth.gateway.js';
import { createSupabaseProfileRepository } from '../../src/auth/supabase-profile.repository.js';
import { createSupabasePhoneAuth } from '../../src/verification/supabase-phone-auth.js';
import { createSupabasePhoneVerificationStore } from '../../src/verification/supabase-phone-verification.store.js';
import { createPhoneVerificationService } from '../../src/verification/phone-verification.service.js';
import { silentLogger } from '../helpers.js';

dotenv.config({ quiet: true });

export function integrationConfig(): Config {
  const config = loadConfig({ ...process.env, NODE_ENV: 'test' });
  const ref = new URL(config.supabase.url).hostname.split('.')[0];
  const allowed = process.env.INTEGRATION_PROJECT_REF?.trim();
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Integration tests never run with NODE_ENV=production');
  }
  if (!allowed || allowed !== ref) {
    throw new Error(
      'Integration tests are disabled: set INTEGRATION_PROJECT_REF in backend/.env to the ref of a development/test project in SUPABASE_URL.',
    );
  }
  if (!config.supabase.secretKey) {
    throw new Error('Integration tests need SUPABASE_SECRET_KEY to create and remove throwaway users.');
  }
  return config;
}

export function liveApp(config: Config) {
  const clients = createSupabaseClients(config);
  return createApp({
    config,
    logger: silentLogger,
    authGateway: createSupabaseAuthGateway(clients, config, silentLogger),
    profiles: createSupabaseProfileRepository(clients, silentLogger),
    phoneVerification: createPhoneVerificationService({
      auth: createSupabasePhoneAuth(clients, config, silentLogger),
      store: createSupabasePhoneVerificationStore(clients, silentLogger),
      policy: config.phoneVerification,
      logger: silentLogger,
    }),
  });
}

const serverOptions = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } } as const;

export function adminClient(config: Config): SupabaseClient {
  return createClient(config.supabase.url, config.supabase.secretKey as string, serverOptions);
}

export function anonClient(config: Config): SupabaseClient {
  return createClient(config.supabase.url, config.supabase.publishableKey, serverOptions);
}

// Tracks throwaway users so they can be removed even when a test fails.
export class TestUsers {
  private readonly ids = new Set<string>();

  constructor(private readonly admin: SupabaseClient) {}

  static email() {
    return `it-${randomUUID()}@neighborshare-integration.test`;
  }

  static password() {
    return `It-${randomUUID()}-9a`;
  }

  async create(opts: { confirmed: boolean; displayName?: string }) {
    const email = TestUsers.email();
    const password = TestUsers.password();
    const { data, error } = await this.admin.auth.admin.createUser({
      email,
      password,
      email_confirm: opts.confirmed,
      user_metadata: opts.displayName ? { display_name: opts.displayName } : {},
    });
    if (error || !data.user) throw new Error(`could not create test user: ${error?.code ?? 'no user'}`);
    this.ids.add(data.user.id);
    return { id: data.user.id, email, password };
  }

  track(id: string) {
    this.ids.add(id);
  }

  async cleanup() {
    const failures: string[] = [];
    for (const id of this.ids) {
      const { error } = await this.admin.auth.admin.deleteUser(id);
      if (error && error.status !== 404) failures.push(`${id}: ${error.code ?? error.status}`);
    }
    this.ids.clear();
    if (failures.length) throw new Error(`test user cleanup failed: ${failures.join(', ')}`);
  }
}
