// Types for the NeighborShare API (v1). Source of truth: backend/docs/API.md
// and backend/src/auth/auth.types.ts. Keep these in step with the backend.

export interface User {
  id: string;
  email: string | null;
  emailConfirmedAt: string | null;
  createdAt: string;
  lastSignInAt: string | null;
  providers: string[];
}

export interface Session {
  accessToken: string;
  refreshToken: string;
  tokenType: 'bearer';
  expiresIn: number;
  // Unix seconds.
  expiresAt: number | null;
}

export type AccountStatus = 'active' | 'restricted' | 'suspended' | 'deletion_pending';
export type VerificationStatus = 'not_started' | 'pending' | 'verified' | 'rejected' | 'expired' | 'revoked';
export type Milestone = 'email_verified' | 'phone_verified' | 'profile_complete' | 'identity_verified';
export type OnboardingStage = 'registered' | Milestone | 'active';

export interface Profile {
  id: string;
  displayName: string | null;
  city: string | null;
  neighborhood: string | null;
  bio: string | null;
  avatarPath: string | null;
  phoneVerifiedAt: string | null;
  profileCompletedAt: string | null;
  accountStatus: AccountStatus;
  createdAt: string;
  updatedAt: string;
}

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
  verifications: Record<'email' | 'phone' | 'identity', VerificationSummary>;
  profile: { complete: boolean; completedAt: string | null; missingFields: string[] };
}

export type SignupResult =
  | { emailConfirmationRequired: true; message: string }
  | { emailConfirmationRequired: false; user: User; session: Session };

export interface ProfileUpdate {
  displayName?: string | null;
  city?: string | null;
  neighborhood?: string | null;
  bio?: string | null;
}

export type LogoutScope = 'local' | 'global' | 'others';

// Codes the backend documents (backend/docs/API.md#error-codes), plus codes
// this client produces itself when no usable response arrives.
export type ApiErrorCode =
  | 'VALIDATION_ERROR'
  | 'INVALID_JSON'
  | 'BAD_REQUEST'
  | 'INVALID_EMAIL'
  | 'INVALID_PROFILE'
  | 'UNAUTHENTICATED'
  | 'INVALID_TOKEN'
  | 'INVALID_CREDENTIALS'
  | 'INVALID_REFRESH_TOKEN'
  | 'EMAIL_NOT_CONFIRMED'
  | 'ACCOUNT_BLOCKED'
  | 'ACCOUNT_SUSPENDED'
  | 'ACCOUNT_DELETION_PENDING'
  | 'ACCOUNT_RESTRICTED'
  | 'SIGNUP_DISABLED'
  | 'FORBIDDEN'
  | 'ROUTE_NOT_FOUND'
  | 'EMAIL_ALREADY_REGISTERED'
  | 'PAYLOAD_TOO_LARGE'
  | 'WEAK_PASSWORD'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR'
  | 'PROFILE_MISSING'
  | 'AUTH_PROVIDER_ERROR'
  | 'AUTH_UNAVAILABLE'
  | 'DATABASE_UNAVAILABLE'
  | 'EMAIL_DELIVERY_UNAVAILABLE'
  | 'SERVER_NOT_CONFIGURED'
  // Client-side
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'BAD_RESPONSE'
  | 'NOT_CONFIGURED';

export interface FieldIssue {
  field: string | null;
  message: string;
}
