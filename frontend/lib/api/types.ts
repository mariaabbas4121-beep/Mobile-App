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

// GET/POST /verification/phone*. Numbers are masked by the server.
export interface PhoneVerification {
  status: VerificationStatus;
  verifiedAt: string | null;
  phone: string | null;
  pendingPhone: string | null;
  // ISO time the server will next send a code, or null if it would now.
  resendAvailableAt: string | null;
  codeLength: number;
}

// `codeSent` means Supabase accepted the request, not that the SMS arrived.
export type PhoneStartResult =
  | { verification: PhoneVerification; codeSent: true; message: string }
  | { verification: PhoneVerification; codeSent: false };

// Listings (/items). Source: backend/src/listings/listing.types.ts.
export type ListingCategory = 'tools' | 'electronics' | 'home' | 'outdoor' | 'kitchen' | 'sports' | 'books' | 'other';
export type ListingCondition = 'excellent' | 'good' | 'fair';
export type ListingAvailability = 'available' | 'unavailable';
export type ListingSort = 'newest' | 'oldest' | 'title';

export interface ListingImage {
  id: string;
  // Signed URL valid for about an hour; null if the server could not sign it.
  url: string | null;
  contentType: string;
  createdAt: string;
}

export interface Listing {
  id: string;
  owner: { id: string; displayName: string | null };
  title: string;
  description: string;
  category: ListingCategory;
  condition: ListingCondition;
  replacementValuePkr: number | null;
  borrowingTerms: string | null;
  area: string | null;
  availability: ListingAvailability;
  teachMeEnabled: boolean;
  tags: string[];
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  images: ListingImage[];
}

export interface ListingInput {
  title: string;
  description: string;
  category: ListingCategory;
  condition: ListingCondition;
  replacementValuePkr?: number | null;
  borrowingTerms?: string | null;
  area?: string | null;
  availability?: ListingAvailability;
  teachMeEnabled?: boolean;
  tags?: string[];
}

export interface ListingQuery {
  q?: string;
  category?: ListingCategory;
  condition?: ListingCondition;
  availability?: ListingAvailability;
  owner?: 'me';
  includeArchived?: boolean;
  sort?: ListingSort;
  page?: number;
  pageSize?: number;
}

export interface ListingPage {
  items: Listing[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}

export type ImageUploadType = 'image/jpeg' | 'image/png' | 'image/webp';

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
  // Phone verification
  | 'INVALID_PHONE'
  | 'PHONE_COUNTRY_NOT_SUPPORTED'
  | 'PHONE_ALREADY_ON_ACCOUNT'
  | 'NO_PENDING_PHONE_VERIFICATION'
  | 'OTP_INVALID_OR_EXPIRED'
  | 'PHONE_VERIFICATION_UNAVAILABLE'
  | 'PHONE_VERIFICATION_NOT_CONFIGURED'
  | 'SMS_DELIVERY_UNAVAILABLE'
  // Listings
  | 'LISTING_NOT_FOUND'
  | 'LISTING_ARCHIVED'
  | 'INVALID_LISTING'
  | 'IMAGE_NOT_FOUND'
  | 'IMAGE_LIMIT_REACHED'
  | 'UNSUPPORTED_IMAGE_TYPE'
  | 'EMPTY_IMAGE'
  | 'STORAGE_NOT_CONFIGURED'
  | 'STORAGE_UNAVAILABLE'
  // Client-side
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'BAD_RESPONSE'
  | 'NOT_CONFIGURED';

export interface FieldIssue {
  field: string | null;
  message: string;
}
