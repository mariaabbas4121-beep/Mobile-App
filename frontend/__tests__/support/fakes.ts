import { ApiError, type ApiClient } from '../../lib/api/client';
import type { OnboardingStatus, PhoneVerification, Profile, Session, User } from '../../lib/api/types';
import { SessionManager } from '../../lib/auth/sessionManager';
import { createMemoryTokenStorage, type TokenStorage } from '../../lib/auth/tokenStorage';
import type { GoogleAuth } from '../../lib/auth/googleAuth';
import type { AuthServices } from '../../context/AuthContext';

export const NOW = 1_800_000_000; // fixed clock, Unix seconds

export const user: User = {
  id: 'user-1',
  email: 'sara@example.com',
  emailConfirmedAt: '2026-10-20T10:00:00Z',
  createdAt: '2026-10-20T09:00:00Z',
  lastSignInAt: '2026-10-20T10:05:00Z',
  providers: ['email'],
};

export const session = (n = 1, expiresAt = NOW + 3600): Session => ({
  accessToken: `access-${n}`,
  refreshToken: `refresh-${n}`,
  tokenType: 'bearer',
  expiresIn: 3600,
  expiresAt,
});

export const profile = (overrides: Partial<Profile> = {}): Profile => ({
  id: 'user-1',
  displayName: 'Sara',
  city: 'Lahore',
  neighborhood: 'Gulberg',
  bio: null,
  avatarPath: null,
  phoneVerifiedAt: null,
  profileCompletedAt: '2026-10-20T11:00:00Z',
  accountStatus: 'active',
  createdAt: '2026-10-20T09:00:00Z',
  updatedAt: '2026-10-20T11:00:00Z',
  ...overrides,
});

export const onboarding = (overrides: Partial<OnboardingStatus> = {}, complete = true): OnboardingStatus => ({
  accountStatus: 'active',
  stage: 'email_verified',
  nextStep: 'phone_verified',
  milestones: { email_verified: true, phone_verified: false, profile_complete: complete, identity_verified: false },
  verifications: {
    email: { status: 'verified', verifiedAt: '2026-10-20T10:00:00Z', expiresAt: null },
    phone: { status: 'not_started', verifiedAt: null, expiresAt: null },
    identity: { status: 'not_started', verifiedAt: null, expiresAt: null },
  },
  profile: complete
    ? { complete: true, completedAt: '2026-10-20T11:00:00Z', missingFields: [] }
    : { complete: false, completedAt: null, missingFields: ['city', 'neighborhood'] },
  ...overrides,
});

export const apiError = (status: number, code: string, extra: { retryAfterSeconds?: number; details?: unknown } = {}) =>
  new ApiError(status, code, `${code} message`, extra);

export type FakeApi = { [K in keyof ApiClient]: jest.Mock };

// Accepts access-N tokens for the current N only.
export function fakeApi(): FakeApi {
  return {
    signup: jest.fn(async () => ({ emailConfirmationRequired: true, message: 'generic' })),
    login: jest.fn(async () => ({ user, session: session(1) })),
    refresh: jest.fn(async () => ({ user, session: session(2) })),
    resendConfirmation: jest.fn(async () => ({ message: 'generic' })),
    logout: jest.fn(async () => undefined),
    health: jest.fn(async () => ({ status: 'ok' })),
    me: jest.fn(async () => ({ user, profile: profile() })),
    status: jest.fn(async () => onboarding()),
    updateProfile: jest.fn(async () => ({ profile: profile() })),
    phoneVerification: jest.fn(async () => ({ verification: phoneVerification() })),
    startPhoneVerification: jest.fn(async () => ({
      verification: phoneVerification({ status: 'pending', pendingPhone: '+92••••••4567', resendAvailableAt: inSeconds(60) }),
      codeSent: true,
      message: 'If this number can receive text messages, a verification code is on its way.',
    })),
    resendPhoneVerification: jest.fn(async () => ({
      verification: phoneVerification({ status: 'pending', pendingPhone: '+92••••••4567', resendAvailableAt: inSeconds(60) }),
      codeSent: true,
      message: 'If this number can receive text messages, a verification code is on its way.',
    })),
    confirmPhoneVerification: jest.fn(async () => ({
      verification: phoneVerification({ status: 'verified', verifiedAt: '2026-10-26T12:00:00Z', phone: '+92••••••4567' }),
    })),
  };
}

const inSeconds = (s: number) => new Date(Date.now() + s * 1000).toISOString();

export const phoneVerification = (overrides: Partial<PhoneVerification> = {}): PhoneVerification => ({
  status: 'not_started',
  verifiedAt: null,
  phone: null,
  pendingPhone: null,
  resendAvailableAt: null,
  codeLength: 6,
  ...overrides,
});

export function fakeGoogle(overrides: Partial<{ [K in keyof GoogleAuth]: jest.Mock }> = {}) {
  return {
    signIn: jest.fn(async () => ({ type: 'success', session: session(9) })),
    completeFromParams: jest.fn(async () => ({ type: 'success', session: session(9) })),
    completeFromUrl: jest.fn(),
    isConfigured: jest.fn(() => true),
    ...overrides,
  };
}

export function services(opts: { api?: FakeApi; storage?: TokenStorage; google?: ReturnType<typeof fakeGoogle> } = {}) {
  const api = opts.api ?? fakeApi();
  const storage = opts.storage ?? createMemoryTokenStorage();
  const sessionManager = new SessionManager(api as unknown as ApiClient, storage, () => NOW);
  const googleAuth = opts.google ?? fakeGoogle();
  return {
    api,
    storage,
    sessionManager,
    googleAuth,
    asServices: { api, sessionManager, googleAuth } as unknown as AuthServices,
  };
}
