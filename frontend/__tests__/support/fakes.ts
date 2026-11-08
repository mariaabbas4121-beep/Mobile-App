import { ApiError, type ApiClient } from '../../lib/api/client';
import type {
  BorrowRequest,
  ChatMessage,
  Conversation,
  Handover,
  HandoverState,
  Listing,
  OnboardingStatus,
  PhoneVerification,
  PickupAuthorization,
  Profile,
  Session,
  User,
} from '../../lib/api/types';
import { SessionManager } from '../../lib/auth/sessionManager';
import { createMemoryTokenStorage, type TokenStorage } from '../../lib/auth/tokenStorage';
import type { GoogleAuth } from '../../lib/auth/googleAuth';
import type { AuthServices } from '../../context/AuthContext';
import { LocationServicesOffError, type LocationService, type PermissionInfo } from '../../lib/location/deviceLocation';

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
    listItems: jest.fn(async () => ({ items: [], pagination: { page: 1, pageSize: 20, total: 0, totalPages: 0 } })),
    getItem: jest.fn(async () => ({ listing: listing() })),
    createItem: jest.fn(async () => ({ listing: listing() })),
    updateItem: jest.fn(async () => ({ listing: listing() })),
    archiveItem: jest.fn(async () => ({ listing: listing({ archivedAt: '2026-10-28T12:00:00Z' }) })),
    uploadItemImage: jest.fn(async () => ({ image: { id: 'img-1', url: 'https://storage.test/img-1', contentType: 'image/jpeg', createdAt: '2026-10-28T10:00:00Z' } })),
    deleteItemImage: jest.fn(async () => undefined),
    getBookedDates: jest.fn(async () => ({ bookedDates: [] })),
    getItemLocation: jest.fn(async () => ({ location: null })),
    setItemLocation: jest.fn(async (_t: string, _id: string, point: { latitude: number; longitude: number }) => ({
      location: { ...point, updatedAt: '2026-11-04T10:00:00Z' },
      listing: listing({ approximateLocation: { latitude: point.latitude + 0.003, longitude: point.longitude } }),
    })),
    clearItemLocation: jest.fn(async () => undefined),
    createBorrowRequest: jest.fn(async () => ({ request: borrowRequest() })),
    listOutgoingRequests: jest.fn(async () => ({ items: [], pagination: { page: 1, pageSize: 20, total: 0, totalPages: 0 } })),
    listIncomingRequests: jest.fn(async () => ({ items: [], pagination: { page: 1, pageSize: 20, total: 0, totalPages: 0 } })),
    getBorrowRequest: jest.fn(async () => ({ request: borrowRequest() })),
    decideBorrowRequest: jest.fn(async () => ({ request: borrowRequest() })),
    listConversations: jest.fn(async () => ({ items: [], pagination: { page: 1, pageSize: 50, total: 0, totalPages: 0 } })),
    openConversation: jest.fn(async () => ({ conversation: conversation() })),
    getConversation: jest.fn(async () => ({ conversation: conversation() })),
    listMessages: jest.fn(async () => ({ items: [], nextCursor: null })),
    sendMessage: jest.fn(async (_t: string, id: string, input: { clientId: string; body: string }) => ({
      message: chatMessage({ conversationId: id, clientId: input.clientId, body: input.body, senderId: 'user-1' }),
      duplicate: false,
    })),
    markConversationRead: jest.fn(async () => ({ conversation: conversation({ unreadCount: 0 }) })),
    getActivity: jest.fn(async () => ({ items: [], unavailable: [] })),
    getHandover: jest.fn(async () => ({ handover: handoverState() })),
    createPickupAuthorization: jest.fn(async (_t: string, _id: string, input: { recipientName: string; recipientPhone?: string | null; note?: string | null }) => ({
      authorization: pickupAuthorization({ recipientName: input.recipientName, recipientPhone: input.recipientPhone ?? null, note: input.note ?? null }),
      code: PICKUP_CODE,
      displayCode: PICKUP_CODE.match(/.{4}/g)!.join('-'),
      qrPayload: `neighborshare://pickup?v=1&code=${PICKUP_CODE}`,
    })),
    revokePickupAuthorization: jest.fn(async () => ({ authorization: pickupAuthorization({ status: 'revoked', revokedAt: '2026-11-10T09:00:00Z' }) })),
    verifyPickupCode: jest.fn(async () => ({ authorization: pickupAuthorization() })),
    confirmHandover: jest.fn(async (_t: string, _id: string, c: { method: 'personal' | 'authorized'; conditionNotes?: string | null }) => ({
      handover: handover(
        c.method === 'authorized'
          ? { method: 'authorized', authorizationId: pickupAuthorization().id, recipientName: 'Ali Khan', conditionNotes: c.conditionNotes ?? null }
          : { conditionNotes: c.conditionNotes ?? null },
      ),
    })),
    uploadHandoverPhoto: jest.fn(async () => ({
      photo: { id: 'ph-1', url: 'https://storage.test/evidence/1.jpg', contentType: 'image/jpeg', createdAt: '2026-11-12T09:31:00Z' },
    })),
  };
}

export const conversation = (overrides: Partial<Conversation> = {}): Conversation => ({
  id: '55555555-5555-4555-8555-555555555555',
  borrowRequestId: '44444444-4444-4444-8444-444444444444',
  viewerRole: 'borrower',
  request: { id: '44444444-4444-4444-8444-444444444444', status: 'accepted', startDate: '2026-11-12', endDate: '2026-11-14' },
  listing: { id: '11111111-1111-4111-8111-111111111111', title: 'Bosch power drill', archived: false, imageUrl: null },
  otherParticipant: { id: 'user-2', displayName: 'Ahmed' },
  lastMessage: null,
  unreadCount: 0,
  lastMessageAt: null,
  createdAt: '2026-11-10T09:00:00Z',
  ...overrides,
});

let messageSeq = 0;
export const chatMessage = (overrides: Partial<ChatMessage> = {}): ChatMessage => {
  messageSeq += 1;
  return {
    id: `msg-${messageSeq}`,
    conversationId: '55555555-5555-4555-8555-555555555555',
    senderId: 'user-2',
    body: `Message ${messageSeq}`,
    clientId: `client-${messageSeq}`,
    createdAt: new Date(Date.parse('2026-11-10T10:00:00Z') + messageSeq * 60_000).toISOString(),
    ...overrides,
  };
};

export const borrowRequest = (overrides: Partial<BorrowRequest> = {}): BorrowRequest => ({
  id: '44444444-4444-4444-8444-444444444444',
  status: 'pending',
  startDate: '2026-11-12',
  endDate: '2026-11-14',
  days: 3,
  message: 'For a weekend trip',
  listing: { id: '11111111-1111-4111-8111-111111111111', title: 'Bosch power drill', archived: false, imageUrl: null },
  borrower: { id: 'user-1', displayName: 'Sara' },
  lender: { id: 'user-2', displayName: 'Ahmed' },
  viewerRole: 'borrower',
  createdAt: '2026-11-10T08:00:00Z',
  updatedAt: '2026-11-10T08:00:00Z',
  decidedAt: null,
  cancelledAt: null,
  ...overrides,
});

// A valid-looking pickup code (32 Crockford base32 characters).
export const PICKUP_CODE = 'ABCDEFGHJKMNPQRSTVWXYZ0123456789';

export const pickupAuthorization = (overrides: Partial<PickupAuthorization> = {}): PickupAuthorization => ({
  id: '55555555-5555-4555-8555-555555555555',
  borrowRequestId: '44444444-4444-4444-8444-444444444444',
  operation: 'pickup',
  status: 'active',
  recipientName: 'Ali Khan',
  recipientPhone: '03001234567',
  note: 'My brother',
  expiresAt: '2026-11-11T08:00:00Z',
  createdAt: '2026-11-10T08:00:00Z',
  revokedAt: null,
  redeemedAt: null,
  ...overrides,
});

export const handoverState = (overrides: Partial<HandoverState> = {}): HandoverState => ({
  borrowRequestId: '44444444-4444-4444-8444-444444444444',
  requestStatus: 'accepted',
  status: 'pending',
  handover: null,
  authorizations: [],
  activeAuthorization: null,
  ...overrides,
});

export const handover = (overrides: Partial<Handover> = {}): Handover => ({
  id: '66666666-6666-4666-8666-666666666666',
  method: 'personal',
  authorizationId: null,
  recipientName: null,
  recipientPhone: null,
  conditionNotes: null,
  confirmedAt: '2026-11-12T09:30:00Z',
  confirmedBy: { id: 'user-2', displayName: 'Ahmed' },
  photos: [],
  ...overrides,
});

export const listing = (overrides: Partial<Listing> = {}): Listing => ({
  id: '11111111-1111-4111-8111-111111111111',
  owner: { id: 'user-2', displayName: 'Ahmed' },
  title: 'Bosch power drill',
  description: 'Cordless drill with two batteries.',
  category: 'tools',
  condition: 'good',
  replacementValuePkr: 15000,
  borrowingTerms: null,
  area: 'UAF Hostel 3',
  city: 'Faisalabad',
  approximateLocation: null,
  distanceKm: null,
  availability: 'available',
  teachMeEnabled: false,
  tags: ['DIY'],
  archivedAt: null,
  createdAt: '2026-10-28T10:00:00Z',
  updatedAt: '2026-10-28T10:00:00Z',
  images: [],
  ...overrides,
});

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

// The pilot area: University of Agriculture, Faisalabad.
export const UAF = { latitude: 31.431, longitude: 73.07 };

// A device location stand-in. Starts "not asked yet", with location
// services on and Android's in-app "turn on" dialog; tests change it.
export function fakeLocation(
  overrides: Partial<{ [K in keyof LocationService]: LocationService[K] extends (...args: never[]) => unknown ? jest.Mock : LocationService[K] }> = {},
) {
  let permission: PermissionInfo = { status: 'undetermined', canAskAgain: true };
  let servicesOn = true;
  const watchers = new Set<(p: { latitude: number; longitude: number }) => void>();
  const fake = {
    permission: jest.fn(async () => permission),
    requestPermission: jest.fn(async () => {
      permission = { status: 'granted', canAskAgain: true };
      return permission;
    }),
    servicesEnabled: jest.fn(async () => servicesOn),
    // The user confirms the system dialog by default.
    enableServices: jest.fn(async () => {
      servicesOn = true;
      return true;
    }),
    canEnableServicesInApp: true,
    // Like the real service: no fix while location services are off.
    current: jest.fn(async () => {
      if (!servicesOn) throw new LocationServicesOffError();
      return UAF;
    }),
    watch: jest.fn(async (cb: (p: { latitude: number; longitude: number }) => void) => {
      watchers.add(cb);
      return () => watchers.delete(cb);
    }),
    openSettings: jest.fn(),
    ...overrides,
    setPermission(next: PermissionInfo) {
      permission = next;
    },
    setServices(on: boolean) {
      servicesOn = on;
    },
    // Simulates the device reporting a new position.
    move(point: { latitude: number; longitude: number }) {
      for (const w of watchers) w(point);
    },
    watcherCount: () => watchers.size,
  };
  return fake;
}
