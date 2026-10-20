import type { AccountStatus, AuthUser, Profile, Verification, VerificationStatus, VerificationType } from './auth.types.js';

// Onboarding milestones in the order the app guides users through them.
export const MILESTONES = ['email_verified', 'phone_verified', 'profile_complete', 'identity_verified'] as const;
export type Milestone = (typeof MILESTONES)[number];
export type OnboardingStage = 'registered' | Milestone | 'active';

export const REQUIRED_PROFILE_FIELDS = ['displayName', 'city', 'neighborhood'] as const;

export interface VerificationSummary {
  status: VerificationStatus;
  verifiedAt: string | null;
  expiresAt: string | null;
}

export interface OnboardingStatus {
  accountStatus: AccountStatus;
  stage: OnboardingStage;
  nextStep: Milestone | null;
  milestones: Record<Milestone, boolean>;
  verifications: Record<VerificationType, VerificationSummary>;
  profile: { complete: boolean; completedAt: string | null; missingFields: string[] };
}

// A verified result whose expiry has passed counts as expired even before a
// background job updates the row.
function effective(v: Verification | undefined, now: Date): VerificationSummary {
  if (!v) return { status: 'not_started', verifiedAt: null, expiresAt: null };
  const expired = v.status === 'verified' && v.expiresAt !== null && new Date(v.expiresAt) <= now;
  return { status: expired ? 'expired' : v.status, verifiedAt: v.verifiedAt, expiresAt: v.expiresAt };
}

// Derives onboarding state from server-side records only. Email verification
// comes from Supabase Auth itself (the source of truth); the others from the
// database rows that only the server can write.
export function deriveOnboarding(
  user: AuthUser,
  profile: Profile,
  verifications: Verification[],
  now = new Date(),
): OnboardingStatus {
  const byType = (t: VerificationType) => effective(verifications.find((v) => v.type === t), now);

  const email: VerificationSummary = user.emailConfirmedAt
    ? { status: 'verified', verifiedAt: user.emailConfirmedAt, expiresAt: null }
    : byType('email');
  const phone = byType('phone');
  const identity = byType('identity');

  const missingFields = REQUIRED_PROFILE_FIELDS.filter((f) => !profile[f]);
  const profileComplete = missingFields.length === 0 && profile.profileCompletedAt !== null;

  const milestones: Record<Milestone, boolean> = {
    email_verified: email.status === 'verified',
    phone_verified: phone.status === 'verified',
    profile_complete: profileComplete,
    identity_verified: identity.status === 'verified',
  };

  const nextStep = MILESTONES.find((m) => !milestones[m]) ?? null;
  let stage: OnboardingStage;
  if (nextStep === null) {
    stage = 'active';
  } else {
    const index = MILESTONES.indexOf(nextStep);
    stage = index === 0 ? 'registered' : (MILESTONES[index - 1] as Milestone);
  }

  return {
    accountStatus: profile.accountStatus,
    stage,
    nextStep,
    milestones,
    verifications: { email, phone, identity },
    profile: { complete: profileComplete, completedAt: profile.profileCompletedAt, missingFields },
  };
}
