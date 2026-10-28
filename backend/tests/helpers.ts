import { vi } from 'vitest';
import type { Config } from '../src/config/env.js';
import { createLogger } from '../src/lib/logger.js';
import { createApp } from '../src/app.js';
import { AppError } from '../src/lib/errors.js';
import type { RateLimitPolicy } from '../src/middleware/rate-limit.middleware.js';
import type {
  AuthGateway,
  AuthSession,
  AuthUser,
  Profile,
  ProfileRepository,
  Verification,
} from '../src/auth/auth.types.js';
import type {
  AuthPhoneState,
  PhoneAuthProvider,
  PhoneRecord,
  PhoneVerificationStore,
} from '../src/verification/phone.types.js';
import { createPhoneVerificationService } from '../src/verification/phone-verification.service.js';

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
    phoneVerification: { resendCooldownSeconds: 60, otpLength: 6, allowedCountryCodes: [] },
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
      if (token === VALID_TOKEN) return { user: userA, roles: [] };
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
    updateProfile: vi.fn<ProfileRepository['updateProfile']>(async (_token, userId, changes) =>
      userId === userA.id ? profileFor(userA, stripUndefined(changes)) : null,
    ),
  };
}

function stripUndefined<T extends object>(o: T): Partial<{ [K in keyof T]: Exclude<T[K], undefined> }> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as never;
}

// --- Phone verification fakes ----------------------------------------------
// A small model of Supabase Auth's phone-change flow: a user asks for a new
// number, Auth "sends" FAKE_OTP and records it as new_phone, and verifying
// that code moves it to phone with phone_confirmed_at. No SMS is involved.
export const FAKE_OTP = '246810';

interface FakeAuthUser {
  id: string;
  token: string;
  phone: string | null;
  phoneConfirmedAt: string | null;
  pendingPhone: string | null;
  otp: string | null;
}

export function fakePhoneAuth() {
  const users = new Map<string, FakeAuthUser>([
    [userA.id, { id: userA.id, token: VALID_TOKEN, phone: null, phoneConfirmedAt: null, pendingPhone: null, otp: null }],
  ]);
  const byToken = (token: string) => {
    const u = [...users.values()].find((x) => x.token === token);
    if (!u) throw AppError.unauthenticated('Access token is invalid or expired', 'INVALID_TOKEN');
    return u;
  };
  const toState = (u: FakeAuthUser): AuthPhoneState => ({
    userId: u.id,
    phone: u.phone,
    phoneConfirmedAt: u.phoneConfirmedAt,
    pendingPhone: u.pendingPhone,
  });

  const fake = {
    users,
    addUser(id: string, token: string, phone: string | null = null) {
      users.set(id, { id, token, phone, phoneConfirmedAt: phone ? '2026-10-01T00:00:00Z' : null, pendingPhone: null, otp: null });
    },
    getSettings: vi.fn<PhoneAuthProvider['getSettings']>(async () => ({ phoneEnabled: true, autoconfirm: false })),
    getPhoneState: vi.fn<PhoneAuthProvider['getPhoneState']>(async (token) => toState(byToken(token))),
    requestPhoneChange: vi.fn<PhoneAuthProvider['requestPhoneChange']>(async (token, phone) => {
      const u = byToken(token);
      if ([...users.values()].some((x) => x.id !== u.id && x.phone === phone)) {
        throw AppError.conflict('PHONE_IN_USE', 'Phone number belongs to another account');
      }
      u.pendingPhone = phone;
      u.otp = FAKE_OTP;
      return toState(u);
    }),
    verifyPhoneChange: vi.fn<PhoneAuthProvider['verifyPhoneChange']>(async (phone, code) => {
      const u = [...users.values()].find((x) => x.pendingPhone === phone);
      if (!u || u.otp !== code) throw AppError.badRequest('OTP_INVALID_OR_EXPIRED', 'The code is incorrect or has expired');
      u.phone = phone;
      u.phoneConfirmedAt = '2026-10-26T12:00:00Z';
      u.pendingPhone = null;
      u.otp = null;
      return { userId: u.id };
    }),
  };
  return fake;
}

// In-memory stand-in for the phone_verification_* database functions, with
// the same rules (cooldown, completion only for the requested number).
export function memoryPhoneStore(now: () => number = Date.now) {
  const rows = new Map<string, PhoneRecord>();
  const row = (userId: string): PhoneRecord => {
    let r = rows.get(userId);
    if (!r) {
      r = { status: 'not_started', verifiedAt: null, phone: null, phoneVerifiedAt: null, pendingPhone: null, otpSentAt: null };
      rows.set(userId, r);
    }
    return r;
  };
  const store = {
    rows,
    get: vi.fn<PhoneVerificationStore['get']>(async (userId) => ({ ...row(userId) })),
    reserveSend: vi.fn<PhoneVerificationStore['reserveSend']>(async (userId, cooldown) => {
      const r = row(userId);
      if (r.otpSentAt) {
        const remaining = Math.ceil(cooldown - (now() - Date.parse(r.otpSentAt)) / 1000);
        if (remaining > 0) return remaining;
      }
      r.otpSentAt = new Date(now()).toISOString();
      return 0;
    }),
    releaseSend: vi.fn<PhoneVerificationStore['releaseSend']>(async (userId) => {
      row(userId).otpSentAt = null;
    }),
    markPending: vi.fn<PhoneVerificationStore['markPending']>(async (userId, phone) => {
      const r = row(userId);
      r.pendingPhone = phone;
      if (r.status !== 'verified') r.status = 'pending';
    }),
    complete: vi.fn<PhoneVerificationStore['complete']>(async (userId, phone, verifiedAt) => {
      const r = row(userId);
      if (r.pendingPhone !== phone) throw AppError.conflict('NO_PENDING_PHONE_VERIFICATION', 'Request a new code for this number first');
      Object.assign(r, { status: 'verified', verifiedAt, phone, phoneVerifiedAt: verifiedAt, pendingPhone: null, otpSentAt: null });
    }),
    recordFailure: vi.fn<PhoneVerificationStore['recordFailure']>(async () => undefined),
    revoke: vi.fn<PhoneVerificationStore['revoke']>(async (userId) => {
      const r = row(userId);
      if (r.status === 'verified') Object.assign(r, { status: 'revoked', phoneVerifiedAt: null });
    }),
  };
  return store;
}

export function testApp(overrides: { config?: Config; rateLimits?: RateLimitPolicy; now?: () => number } = {}) {
  const config = overrides.config ?? testConfig();
  const gateway = fakeGateway();
  const profiles = fakeProfiles();
  const phoneAuth = fakePhoneAuth();
  const phoneStore = memoryPhoneStore(overrides.now);
  const app = createApp({
    config,
    logger: silentLogger,
    authGateway: gateway,
    profiles,
    phoneVerification: createPhoneVerificationService({
      auth: phoneAuth,
      store: phoneStore,
      policy: config.phoneVerification,
      logger: silentLogger,
      ...(overrides.now ? { now: overrides.now } : {}),
    }),
    ...(overrides.rateLimits ? { rateLimits: overrides.rateLimits } : {}),
  });
  return { app, gateway, profiles, phoneAuth, phoneStore };
}
