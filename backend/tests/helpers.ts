import { vi } from 'vitest';
import type { Config } from '../src/config/env.js';
import { createLogger } from '../src/lib/logger.js';
import { createApp } from '../src/app.js';
import { AppError } from '../src/lib/errors.js';
import type {
  AuthGateway,
  AuthSession,
  AuthUser,
  Profile,
  ProfileRepository,
  Verification,
} from '../src/auth/auth.types.js';

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

// --- Auth fakes for unit tests -------------------------------------------
// Syntactically JWT-shaped, but not tokens Supabase would ever accept.
export const VALID_TOKEN = 'header.payload-user-a.signature';
export const OTHER_TOKEN = 'header.payload-user-b.signature';

export const userA: AuthUser = {
  id: '00000000-0000-4000-8000-00000000000a',
  email: 'a@example.test',
  emailConfirmedAt: '2026-10-20T10:00:00Z',
  createdAt: '2026-10-20T09:00:00Z',
  lastSignInAt: '2026-10-20T10:05:00Z',
  providers: ['email'],
};

export const session: AuthSession = {
  accessToken: VALID_TOKEN,
  refreshToken: 'refresh-token-a',
  tokenType: 'bearer',
  expiresIn: 3600,
  expiresAt: 1_800_000_000,
};

export function profileFor(user: AuthUser, overrides: Partial<Profile> = {}): Profile {
  return {
    id: user.id,
    displayName: null,
    city: null,
    neighborhood: null,
    bio: null,
    avatarPath: null,
    phoneVerifiedAt: null,
    profileCompletedAt: null,
    accountStatus: 'active',
    createdAt: '2026-10-20T09:00:00Z',
    updatedAt: '2026-10-20T09:00:00Z',
    ...overrides,
  };
}

export function verificationsFor(overrides: Partial<Record<Verification['type'], Partial<Verification>>> = {}): Verification[] {
  return (['email', 'phone', 'identity'] as const).map((type) => ({
    type,
    status: type === 'email' ? 'verified' : 'not_started',
    verifiedAt: type === 'email' ? '2026-10-20T10:00:00Z' : null,
    expiresAt: null,
    statusChangedAt: '2026-10-20T10:00:00Z',
    ...overrides[type],
  }));
}

// A gateway that accepts only VALID_TOKEN as user A. Every method is a spy
// so tests can override behaviour per case.
export function fakeGateway(): { [K in keyof AuthGateway]: ReturnType<typeof vi.fn<AuthGateway[K]>> } {
  return {
    signUp: vi.fn<AuthGateway['signUp']>(async () => ({ user: { ...userA, emailConfirmedAt: null }, session: null })),
    signIn: vi.fn<AuthGateway['signIn']>(async () => ({ user: userA, session })),
    refresh: vi.fn<AuthGateway['refresh']>(async () => ({ user: userA, session })),
    resendSignupConfirmation: vi.fn<AuthGateway['resendSignupConfirmation']>(async () => undefined),
    getUser: vi.fn<AuthGateway['getUser']>(async (token) => {
      if (token === VALID_TOKEN) return userA;
      throw AppError.unauthenticated('Access token is invalid or expired', 'INVALID_TOKEN');
    }),
    signOut: vi.fn<AuthGateway['signOut']>(async () => undefined),
  };
}

export function fakeProfiles(): { [K in keyof ProfileRepository]: ReturnType<typeof vi.fn<ProfileRepository[K]>> } {
  return {
    getProfile: vi.fn<ProfileRepository['getProfile']>(async (_token, userId) =>
      userId === userA.id ? profileFor(userA) : null,
    ),
    getVerifications: vi.fn<ProfileRepository['getVerifications']>(async () => verificationsFor()),
  };
}

export function testApp(overrides: { config?: Config } = {}) {
  const gateway = fakeGateway();
  const profiles = fakeProfiles();
  const app = createApp({
    config: overrides.config ?? testConfig(),
    logger: silentLogger,
    authGateway: gateway,
    profiles,
  });
  return { app, gateway, profiles };
}
