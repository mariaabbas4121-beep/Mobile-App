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
export type ListingSort = 'newest' | 'oldest' | 'title' | 'distance';

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
  city: string | null;
  // Public pickup point, deliberately displaced about 0.5 km from where the
  // owner set it. Null when the owner has not set one.
  approximateLocation: GeoPoint | null;
  // Distance from the search origin, to 0.1 km; nearby searches only.
  distanceKm: number | null;
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
  city?: string | null;
  availability?: ListingAvailability;
  teachMeEnabled?: boolean;
  tags?: string[];
}

export interface ListingQuery {
  q?: string;
  category?: ListingCategory;
  condition?: ListingCondition;
  availability?: ListingAvailability;
  // 'me': the caller's own listings. 'others': everyone else's (browsing);
  // the server takes "who am I" from the token.
  owner?: 'me' | 'others';
  includeArchived?: boolean;
  // Nearby (lat and lng together, radiusKm 0.5-50, default 3) or city-wide.
  lat?: number;
  lng?: number;
  radiusKm?: number;
  city?: string;
  sort?: ListingSort;
  page?: number;
  pageSize?: number;
}

export interface GeoPoint {
  latitude: number;
  longitude: number;
}

// The precise pickup point; returned to the listing's owner only.
export interface PickupLocation extends GeoPoint {
  updatedAt: string;
}

export type ListingScope = { mode: 'nearby'; radiusKm: number } | { mode: 'city'; city: string } | { mode: 'all' };

export interface ListingPage {
  items: Listing[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
  scope?: ListingScope;
}

export type ImageUploadType = 'image/jpeg' | 'image/png' | 'image/webp';

// Borrow requests (/borrow-requests). Source: backend/src/borrow/borrow.types.ts.
export type BorrowStatus = 'pending' | 'accepted' | 'declined' | 'cancelled';
export type BorrowRole = 'borrower' | 'lender';

// Inclusive calendar dates, YYYY-MM-DD.
export interface DateRange {
  startDate: string;
  endDate: string;
}

export interface BorrowRequest {
  id: string;
  status: BorrowStatus;
  startDate: string;
  endDate: string;
  days: number;
  message: string | null;
  listing: { id: string; title: string; archived: boolean; imageUrl: string | null };
  borrower: { id: string; displayName: string | null };
  lender: { id: string; displayName: string | null };
  viewerRole: BorrowRole;
  createdAt: string;
  updatedAt: string;
  decidedAt: string | null;
  cancelledAt: string | null;
}

export interface BorrowRequestInput {
  listingId: string;
  startDate: string;
  endDate: string;
  message?: string | null;
}

export interface BorrowRequestPage {
  items: BorrowRequest[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}

// Chat (/conversations). Source: backend/src/chat/chat.types.ts.
export interface ChatMessage {
  id: string;
  conversationId: string;
  senderId: string;
  body: string;
  // The sender's idempotency key.
  clientId: string;
  createdAt: string;
}

export interface Conversation {
  id: string;
  borrowRequestId: string;
  viewerRole: BorrowRole;
  request: { id: string; status: BorrowStatus; startDate: string; endDate: string };
  listing: { id: string; title: string; archived: boolean; imageUrl: string | null };
  otherParticipant: { id: string; displayName: string | null };
  lastMessage: { id: string; senderId: string; body: string; createdAt: string } | null;
  unreadCount: number;
  lastMessageAt: string | null;
  createdAt: string;
}

export interface ConversationPage {
  items: Conversation[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}

// Newest first; pass nextCursor as `before` for older messages.
export interface MessagePage {
  items: ChatMessage[];
  nextCursor: string | null;
}

// Activity (/activity). Source: backend/src/activity/activity.ts.
export type ActivityType =
  | 'request_received'
  | 'request_sent'
  | 'request_accepted'
  | 'request_declined'
  | 'request_cancelled'
  | 'message'
  | 'listing_created'
  | 'listing_archived';

export interface ActivityItem {
  id: string;
  type: ActivityType;
  occurredAt: string;
  actor: { id: string; displayName: string | null; isYou: boolean } | null;
  listing: { id: string; title: string; imageUrl: string | null } | null;
  request: { id: string; status: BorrowStatus; startDate: string; endDate: string; viewerRole: BorrowRole } | null;
  conversationId: string | null;
  preview: string | null;
}

export interface ActivityFeed {
  // Newest first.
  items: ActivityItem[];
  // Parts the server could not read this time; the rest is still returned.
  unavailable: ('borrowRequests' | 'conversations' | 'listings')[];
}

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
  | 'INVALID_LOCATION'
  // Borrow requests
  | 'BORROW_REQUEST_NOT_FOUND'
  | 'CANNOT_BORROW_OWN_LISTING'
  | 'LISTING_NOT_BORROWABLE'
  | 'DATES_UNAVAILABLE'
  | 'DUPLICATE_PENDING_REQUEST'
  | 'INVALID_STATUS_TRANSITION'
  | 'INVALID_DATES'
  // Chat
  | 'CONVERSATION_NOT_FOUND'
  | 'CHAT_NOT_AVAILABLE'
  | 'CLIENT_ID_REUSED'
  | 'INVALID_MESSAGE'
  // Client-side
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'BAD_RESPONSE'
  | 'NOT_CONFIGURED';

export interface FieldIssue {
  field: string | null;
  message: string;
}
