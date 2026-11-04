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
import type { Caller, Listing, ListingImage, ListingRepository, PickupLocation } from '../src/listings/listing.types.js';
import type { BorrowRequest, BorrowRequestRepository, BorrowStatus } from '../src/borrow/borrow.types.js';
import { inclusiveDays, rangesOverlap } from '../src/borrow/dates.js';
import type { ChatMessage, ChatRepository, Conversation } from '../src/chat/chat.types.js';
import { createChatEvents, createChatService } from '../src/chat/chat.service.js';
import { DEFAULT_RATE_LIMITS } from '../src/middleware/rate-limit.middleware.js';

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

// --- Listing fakes -----------------------------------------------------------
export const haversineKm = (a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }) => {
  const r = (d: number) => (d * Math.PI) / 180;
  const h =
    Math.sin(r(b.latitude - a.latitude) / 2) ** 2 +
    Math.cos(r(a.latitude)) * Math.cos(r(b.latitude)) * Math.sin(r(b.longitude - a.longitude) / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(h)));
};

// The fake's public point: 300 m north of the precise one, rounded to 3
// decimals (the database uses a secret random direction instead).
export const fakePublicPoint = (p: { latitude: number; longitude: number }) => ({
  latitude: Math.round((p.latitude + 0.3 / 111.32) * 1000) / 1000,
  longitude: Math.round(p.longitude * 1000) / 1000,
});

// In-memory stand-in for the listing repository with the database's access
// rules: archived listings are visible only to their owner, and writes by
// anyone but the owner match nothing (as Row-Level Security would).
export function memoryListings() {
  const rows = new Map<string, Listing>();
  let seq = 0;
  const id = () => `00000000-0000-4000-9000-${String(++seq).padStart(12, '0')}`;
  const visible = (caller: Caller | null, l: Listing) => !l.archivedAt || l.owner.id === caller?.userId;
  const owned = (caller: Caller, listingId: string) => {
    const l = rows.get(listingId);
    return l && l.owner.id === caller.userId && !l.archivedAt ? l : null;
  };

  const locations = new Map<string, PickupLocation>();
  const repo = {
    rows,
    locations,
    search: vi.fn<ListingRepository['search']>(async (caller, s) => {
      const words = (s.q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
      let list = [...rows.values()].filter(
        (l) =>
          (l.archivedAt ? s.includeArchived && l.owner.id === caller?.userId : true) &&
          (!s.category || l.category === s.category) &&
          (!s.condition || l.condition === s.condition) &&
          (!s.availability || l.availability === s.availability) &&
          (!s.ownerId || l.owner.id === s.ownerId) &&
          (!s.excludeOwnerId || l.owner.id !== s.excludeOwnerId) &&
          words.every((w) => `${l.title} ${l.description} ${l.tags.join(' ')}`.toLowerCase().includes(w)) &&
          (!s.city || (l.city ?? '').toLowerCase() === s.city.trim().toLowerCase()),
      );
      const near = s.near;
      if (near) {
        list = list
          .filter((l) => l.approximateLocation && haversineKm(near, l.approximateLocation) <= near.radiusKm)
          .map((l) => ({ ...l, distanceKm: Math.round(haversineKm(near, l.approximateLocation!) * 10) / 10 }));
      } else {
        list = list.map((l) => ({ ...l, distanceKm: null }));
      }
      list =
        s.sort === 'distance'
          ? list.sort((a, b) => (a.distanceKm ?? 0) - (b.distanceKm ?? 0))
          : s.sort === 'title'
          ? list.sort((a, b) => a.title.localeCompare(b.title))
          : s.sort === 'oldest'
            ? list
            : list.reverse();
      const start = (s.page - 1) * s.pageSize;
      return { items: list.slice(start, start + s.pageSize), total: list.length };
    }),
    get: vi.fn<ListingRepository['get']>(async (caller, listingId) => {
      const l = rows.get(listingId);
      return l && visible(caller, l) ? { ...structuredClone(l), distanceKm: null } : null;
    }),
    create: vi.fn<ListingRepository['create']>(async (caller, input) => {
      const now = new Date().toISOString();
      const l: Listing = {
        id: id(),
        owner: { id: caller.userId, displayName: 'Owner' },
        title: input.title,
        description: input.description,
        category: input.category,
        condition: input.condition,
        replacementValuePkr: input.replacementValuePkr ?? null,
        borrowingTerms: input.borrowingTerms ?? null,
        area: input.area ?? null,
        city: input.city ?? null,
        approximateLocation: null,
        distanceKm: null,
        availability: input.availability,
        teachMeEnabled: input.teachMeEnabled,
        tags: input.tags,
        archivedAt: null,
        createdAt: now,
        updatedAt: now,
        images: [],
      };
      rows.set(l.id, l);
      return structuredClone(l);
    }),
    update: vi.fn<ListingRepository['update']>(async (caller, listingId, changes) => {
      const l = owned(caller, listingId);
      if (!l) return null;
      Object.assign(l, Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined)), {
        updatedAt: new Date().toISOString(),
      });
      return structuredClone(l);
    }),
    archive: vi.fn<ListingRepository['archive']>(async (caller, listingId) => {
      const l = owned(caller, listingId);
      if (!l) return false;
      l.archivedAt = new Date().toISOString();
      return true;
    }),
    addImage: vi.fn<ListingRepository['addImage']>(async (caller, listingId, file) => {
      const l = owned(caller, listingId);
      if (!l) throw AppError.forbidden();
      const image: ListingImage = {
        id: id(),
        url: `https://storage.test/signed/${listingId}/${l.images.length}`,
        contentType: file.contentType,
        createdAt: new Date().toISOString(),
      };
      l.images.push(image);
      return image;
    }),
    removeImage: vi.fn<ListingRepository['removeImage']>(async (caller, listingId, imageId) => {
      const l = rows.get(listingId);
      if (!l || l.owner.id !== caller.userId) return false;
      const before = l.images.length;
      l.images = l.images.filter((i) => i.id !== imageId);
      return l.images.length < before;
    }),
    getLocation: vi.fn<ListingRepository['getLocation']>(async (caller, listingId) => {
      const l = rows.get(listingId);
      return l && l.owner.id === caller.userId ? (locations.get(listingId) ?? null) : null;
    }),
    setLocation: vi.fn<ListingRepository['setLocation']>(async (caller, listingId, point) => {
      const l = owned(caller, listingId);
      if (!l) throw AppError.notFound('Listing not found', 'LISTING_NOT_FOUND');
      const location = { ...point, updatedAt: new Date().toISOString() };
      locations.set(listingId, location);
      l.approximateLocation = fakePublicPoint(point);
      return location;
    }),
    clearLocation: vi.fn<ListingRepository['clearLocation']>(async (caller, listingId) => {
      const l = owned(caller, listingId);
      if (!l) throw AppError.notFound('Listing not found', 'LISTING_NOT_FOUND');
      locations.delete(listingId);
      l.approximateLocation = null;
    }),
  };
  return repo;
}

// --- Borrow-request fakes ---------------------------------------------------
// In-memory stand-in with the database's rules: participants only, lender
// taken from the listing, one pending request per borrower per listing,
// transitions only from pending by the right side, and no overlapping
// accepted requests (the exclusion constraint).
export function memoryBorrowRequests(listings: ReturnType<typeof memoryListings>) {
  interface Row {
    id: string;
    listingId: string;
    lenderId: string;
    borrowerId: string;
    startDate: string;
    endDate: string;
    message: string | null;
    status: BorrowStatus;
    createdAt: string;
    updatedAt: string;
    decidedAt: string | null;
    cancelledAt: string | null;
  }
  const rows = new Map<string, Row>();
  let seq = 0;
  let clock = Date.parse('2026-11-01T00:00:00Z');
  const stamp = () => new Date((clock += 1000)).toISOString();

  const view = (r: Row, viewerId: string): BorrowRequest => {
    const l = listings.rows.get(r.listingId)!;
    return {
      id: r.id,
      status: r.status,
      startDate: r.startDate,
      endDate: r.endDate,
      days: inclusiveDays(r.startDate, r.endDate),
      message: r.message,
      listing: { id: l.id, title: l.title, archived: Boolean(l.archivedAt), imageUrl: l.images[0]?.url ?? null },
      borrower: { id: r.borrowerId, displayName: 'Borrower' },
      lender: { id: r.lenderId, displayName: 'Lender' },
      viewerRole: r.borrowerId === viewerId ? 'borrower' : 'lender',
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      decidedAt: r.decidedAt,
      cancelledAt: r.cancelledAt,
    };
  };
  const party = (caller: Caller, r: Row) => r.borrowerId === caller.userId || r.lenderId === caller.userId;
  const accepted = (listingId: string) => [...rows.values()].filter((r) => r.listingId === listingId && r.status === 'accepted');

  const repo = {
    rows,
    list: vi.fn<BorrowRequestRepository['list']>(async (caller, { role, status, page, pageSize }) => {
      const mine = [...rows.values()]
        .filter((r) => (role === 'borrower' ? r.borrowerId : r.lenderId) === caller.userId)
        .filter((r) => !status || r.status === status)
        .reverse();
      return { items: mine.slice((page - 1) * pageSize, page * pageSize).map((r) => view(r, caller.userId)), total: mine.length };
    }),
    get: vi.fn<BorrowRequestRepository['get']>(async (caller, id) => {
      const r = rows.get(id);
      return r && party(caller, r) ? view(r, caller.userId) : null;
    }),
    create: vi.fn<BorrowRequestRepository['create']>(async (caller, input) => {
      const l = listings.rows.get(input.listingId);
      if (!l || l.archivedAt || l.availability !== 'available') throw AppError.conflict('LISTING_NOT_BORROWABLE', 'x');
      if (l.owner.id === caller.userId) throw AppError.forbidden('x', 'CANNOT_BORROW_OWN_LISTING');
      if ([...rows.values()].some((r) => r.listingId === l.id && r.borrowerId === caller.userId && r.status === 'pending')) {
        throw AppError.conflict('DUPLICATE_PENDING_REQUEST', 'x');
      }
      if (accepted(l.id).some((r) => rangesOverlap(r, input))) throw AppError.conflict('DATES_UNAVAILABLE', 'x');
      const now = stamp();
      const r: Row = {
        id: `00000000-0000-4000-a000-${String(++seq).padStart(12, '0')}`,
        listingId: l.id,
        lenderId: l.owner.id,
        borrowerId: caller.userId,
        startDate: input.startDate,
        endDate: input.endDate,
        message: input.message,
        status: 'pending',
        createdAt: now,
        updatedAt: now,
        decidedAt: null,
        cancelledAt: null,
      };
      rows.set(r.id, r);
      return view(r, caller.userId);
    }),
    setStatus: vi.fn<BorrowRequestRepository['setStatus']>(async (caller, id, status) => {
      const r = rows.get(id);
      if (!r || !party(caller, r)) return null;
      if (r.status !== 'pending') throw AppError.conflict('INVALID_STATUS_TRANSITION', 'x');
      const actorOk = status === 'cancelled' ? r.borrowerId === caller.userId : r.lenderId === caller.userId;
      if (!actorOk) throw AppError.forbidden();
      if (status === 'accepted' && accepted(r.listingId).some((a) => rangesOverlap(a, r))) {
        throw AppError.conflict('DATES_UNAVAILABLE', 'x');
      }
      const now = stamp();
      Object.assign(r, { status, updatedAt: now }, status === 'cancelled' ? { cancelledAt: now } : { decidedAt: now });
      return view(r, caller.userId);
    }),
    bookedRanges: vi.fn<BorrowRequestRepository['bookedRanges']>(async (_caller, listingId) =>
      accepted(listingId).map((r) => ({ startDate: r.startDate, endDate: r.endDate })),
    ),
  };
  return repo;
}

// --- Chat fakes ------------------------------------------------------------
// In-memory stand-in with the migration's rules: a conversation exists for
// each accepted request (as the accept trigger creates it), participants
// only, sends only while the request is accepted, one message per client id.
export function memoryChat(listings: ReturnType<typeof memoryListings>, borrowRequests: ReturnType<typeof memoryBorrowRequests>) {
  interface Row {
    id: string;
    borrowRequestId: string;
    borrowerId: string;
    lenderId: string;
    readAt: Record<string, string | null>;
    lastMessageAt: string | null;
    createdAt: string;
  }
  const conversations = new Map<string, Row>();
  const messages: ChatMessage[] = [];
  let seq = 0;
  let clock = Date.parse('2026-11-10T00:00:00Z');
  const stamp = () => new Date((clock += 1000)).toISOString();
  const uuid = (prefix: string) => `00000000-0000-4000-${prefix}-${String(++seq).padStart(12, '0')}`;

  // What the accept trigger does.
  const sync = () => {
    for (const r of borrowRequests.rows.values()) {
      if (r.status !== 'accepted' || [...conversations.values()].some((c) => c.borrowRequestId === r.id)) continue;
      const c: Row = {
        id: uuid('b000'),
        borrowRequestId: r.id,
        borrowerId: r.borrowerId,
        lenderId: r.lenderId,
        readAt: { [r.borrowerId]: null, [r.lenderId]: null },
        lastMessageAt: null,
        createdAt: stamp(),
      };
      conversations.set(c.id, c);
    }
  };
  const party = (caller: Caller, c: Row) => c.borrowerId === caller.userId || c.lenderId === caller.userId;
  const inConversation = (id: string) => messages.filter((m) => m.conversationId === id);
  const view = (c: Row, viewerId: string): Conversation => {
    const r = borrowRequests.rows.get(c.borrowRequestId)!;
    const l = listings.rows.get(r.listingId)!;
    const own = inConversation(c.id);
    const last = own[own.length - 1];
    const readAt = c.readAt[viewerId] ?? null;
    return {
      id: c.id,
      borrowRequestId: c.borrowRequestId,
      viewerRole: c.borrowerId === viewerId ? 'borrower' : 'lender',
      request: { id: r.id, status: r.status, startDate: r.startDate, endDate: r.endDate },
      listing: { id: l.id, title: l.title, archived: Boolean(l.archivedAt), imageUrl: l.images[0]?.url ?? null },
      otherParticipant: c.borrowerId === viewerId ? { id: c.lenderId, displayName: 'Lender' } : { id: c.borrowerId, displayName: 'Borrower' },
      lastMessage: last ? { id: last.id, senderId: last.senderId, body: last.body.slice(0, 200), createdAt: last.createdAt } : null,
      unreadCount: own.filter((m) => m.senderId !== viewerId && (!readAt || m.createdAt > readAt)).length,
      lastMessageAt: c.lastMessageAt,
      createdAt: c.createdAt,
    };
  };
  const notFound = () => AppError.notFound('Conversation not found', 'CONVERSATION_NOT_FOUND');

  const repo = {
    conversations,
    stored: messages,
    list: vi.fn<ChatRepository['list']>(async (caller, { page, pageSize }) => {
      sync();
      const mine = [...conversations.values()]
        .filter((c) => party(caller, c))
        .sort((a, b) => (b.lastMessageAt ?? b.createdAt).localeCompare(a.lastMessageAt ?? a.createdAt));
      return { items: mine.slice((page - 1) * pageSize, page * pageSize).map((c) => view(c, caller.userId)), total: mine.length };
    }),
    get: vi.fn<ChatRepository['get']>(async (caller, id) => {
      sync();
      const c = conversations.get(id);
      return c && party(caller, c) ? view(c, caller.userId) : null;
    }),
    open: vi.fn<ChatRepository['open']>(async (caller, borrowRequestId) => {
      const r = borrowRequests.rows.get(borrowRequestId);
      if (!r || (r.borrowerId !== caller.userId && r.lenderId !== caller.userId)) return null;
      if (r.status !== 'accepted') throw AppError.conflict('CHAT_NOT_AVAILABLE', 'x');
      sync();
      return [...conversations.values()].find((c) => c.borrowRequestId === r.id)!.id;
    }),
    messages: vi.fn<ChatRepository['messages']>(async (caller, id, { before, limit }) => {
      const c = conversations.get(id);
      if (!c || !party(caller, c)) return [];
      return inConversation(id)
        .reverse()
        .filter((m) => !before || m.createdAt < before.createdAt || (m.createdAt === before.createdAt && m.id < before.id))
        .slice(0, limit);
    }),
    send: vi.fn<ChatRepository['send']>(async (caller, id, { clientId, body }) => {
      sync();
      const c = conversations.get(id);
      if (!c || !party(caller, c)) throw notFound();
      if (borrowRequests.rows.get(c.borrowRequestId)!.status !== 'accepted') throw AppError.conflict('CHAT_NOT_AVAILABLE', 'x');
      const participantIds = [c.borrowerId, c.lenderId];
      const existing = messages.find((m) => m.conversationId === id && m.senderId === caller.userId && m.clientId === clientId);
      if (existing) {
        if (existing.body !== body) throw AppError.conflict('CLIENT_ID_REUSED', 'x');
        return { message: { ...existing }, created: false, participantIds };
      }
      const message: ChatMessage = { id: uuid('b100'), conversationId: id, senderId: caller.userId, body, clientId, createdAt: stamp() };
      messages.push(message);
      c.lastMessageAt = message.createdAt;
      c.readAt[caller.userId] = message.createdAt;
      return { message: { ...message }, created: true, participantIds };
    }),
    markRead: vi.fn<ChatRepository['markRead']>(async (caller, id) => {
      const c = conversations.get(id);
      if (!c || !party(caller, c)) return false;
      c.readAt[caller.userId] = stamp();
      return true;
    }),
  };
  return repo;
}

export function testApp(overrides: { config?: Config; rateLimits?: RateLimitPolicy; now?: () => number } = {}) {
  const config = overrides.config ?? testConfig();
  const gateway = fakeGateway();
  const profiles = fakeProfiles();
  const phoneAuth = fakePhoneAuth();
  const phoneStore = memoryPhoneStore(overrides.now);
  const listings = memoryListings();
  const borrowRequests = memoryBorrowRequests(listings);
  const chatRepository = memoryChat(listings, borrowRequests);
  const chatEvents = createChatEvents(silentLogger);
  const chat = createChatService({
    repository: chatRepository,
    profiles,
    events: chatEvents,
    sendLimit: (overrides.rateLimits ?? DEFAULT_RATE_LIMITS).chatMessagePerUser,
    ...(overrides.now ? { now: overrides.now } : {}),
  });
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
    listings,
    borrowRequests,
    chat,
    ...(overrides.now ? { now: overrides.now } : {}),
    ...(overrides.rateLimits ? { rateLimits: overrides.rateLimits } : {}),
  });
  return { app, gateway, profiles, phoneAuth, phoneStore, listings, borrowRequests, chat, chatRepository, chatEvents };
}
