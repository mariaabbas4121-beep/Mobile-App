import { describe, expect, test } from 'vitest';
import { deriveOnboarding } from '../../src/auth/onboarding.js';
import { profileFor, userA, verificationsFor } from '../helpers.js';

const complete = { displayName: 'Ali', city: 'Lahore', neighborhood: 'Gulberg', profileCompletedAt: '2026-10-20T11:00:00Z' };
const unconfirmed = { ...userA, emailConfirmedAt: null };

describe('deriveOnboarding', () => {
  test('a fresh signup is at "registered" with email next', () => {
    const s = deriveOnboarding(unconfirmed, profileFor(userA), verificationsFor({ email: { status: 'pending', verifiedAt: null } }));
    expect(s.stage).toBe('registered');
    expect(s.nextStep).toBe('email_verified');
    expect(s.verifications.email.status).toBe('pending');
    expect(s.profile.missingFields).toEqual(['displayName', 'city', 'neighborhood']);
  });

  test('email verification comes from Supabase Auth even if the row lags behind', () => {
    const s = deriveOnboarding(userA, profileFor(userA), verificationsFor({ email: { status: 'pending', verifiedAt: null } }));
    expect(s.milestones.email_verified).toBe(true);
  });

  test('independent milestones are reported even when an earlier one is missing', () => {
    const s = deriveOnboarding(userA, profileFor(userA, complete), verificationsFor());
    expect(s.milestones).toEqual({
      email_verified: true,
      phone_verified: false,
      profile_complete: true,
      identity_verified: false,
    });
    expect(s.stage).toBe('email_verified');
    expect(s.nextStep).toBe('phone_verified');
  });

  test('all milestones met gives stage "active"', () => {
    const s = deriveOnboarding(
      userA,
      profileFor(userA, complete),
      verificationsFor({
        phone: { status: 'verified', verifiedAt: '2026-10-20T12:00:00Z' },
        identity: { status: 'verified', verifiedAt: '2026-10-20T13:00:00Z' },
      }),
    );
    expect(s.stage).toBe('active');
    expect(s.nextStep).toBeNull();
  });

  test('a verified result past its expiry counts as expired', () => {
    const s = deriveOnboarding(
      userA,
      profileFor(userA, complete),
      verificationsFor({ phone: { status: 'verified', verifiedAt: '2026-01-01T00:00:00Z', expiresAt: '2026-06-01T00:00:00Z' } }),
      new Date('2026-10-20T00:00:00Z'),
    );
    expect(s.verifications.phone.status).toBe('expired');
    expect(s.milestones.phone_verified).toBe(false);
  });

  test('profile completeness requires the server timestamp, not just the fields', () => {
    const s = deriveOnboarding(userA, profileFor(userA, { ...complete, profileCompletedAt: null }), verificationsFor());
    expect(s.profile.complete).toBe(false);
  });

  test('account status is reported separately from the onboarding stage', () => {
    const s = deriveOnboarding(userA, profileFor(userA, { accountStatus: 'suspended' }), verificationsFor());
    expect(s.accountStatus).toBe('suspended');
    expect(s.stage).toBe('email_verified');
  });

  test('missing verification rows are treated as not_started', () => {
    const s = deriveOnboarding(unconfirmed, profileFor(userA), []);
    expect(s.verifications.phone.status).toBe('not_started');
    expect(s.verifications.email.status).toBe('not_started');
  });
});
