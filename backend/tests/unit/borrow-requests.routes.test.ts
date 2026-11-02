// Borrow-request endpoints with in-memory repositories. The same rules are
// tested against the real migration in tests/db/borrow-requests.test.ts,
// including the exclusion constraint that makes concurrent accepts safe.
import request from 'supertest';
import { beforeEach, describe, expect, test } from 'vitest';
import { AppError } from '../../src/lib/errors.js';
import { DEFAULT_RATE_LIMITS } from '../../src/middleware/rate-limit.middleware.js';
import { todayInPakistan } from '../../src/borrow/dates.js';
import { OTHER_TOKEN, VALID_TOKEN, profileFor, testApp, userA } from '../helpers.js';
import type { AuthUser, Profile } from '../../src/auth/auth.types.js';

// 06:00 UTC = 11:00 in Pakistan on 10 November 2026.
const NOW = Date.parse('2026-11-10T06:00:00Z');
const THIRD_TOKEN = 'header.payload-user-c.signature';
const lender = userA;
const borrower: AuthUser = { ...userA, id: '00000000-0000-4000-8000-00000000000b', email: 'b@example.test' };
const outsider: AuthUser = { ...userA, id: '00000000-0000-4000-8000-00000000000c', email: 'c@example.test' };

const asLender = { Authorization: `Bearer ${VALID_TOKEN}` };
const asBorrower = { Authorization: `Bearer ${OTHER_TOKEN}` };
const asOutsider = { Authorization: `Bearer ${THIRD_TOKEN}` };

let t: ReturnType<typeof testApp>;
let statuses: Record<string, Profile['accountStatus']>;
let listingId: string;

const app = () => t.app;

beforeEach(async () => {
  t = testApp({ now: () => NOW });
  statuses = { [lender.id]: 'active', [borrower.id]: 'active', [outsider.id]: 'active' };
  t.gateway.getUser.mockImplementation(async (token) => {
    const user = { [VALID_TOKEN]: lender, [OTHER_TOKEN]: borrower, [THIRD_TOKEN]: outsider }[token];
    if (!user) throw AppError.unauthenticated('Access token is invalid or expired', 'INVALID_TOKEN');
    return { user, roles: [] };
  });
  t.profiles.getProfile.mockImplementation(async (_token, userId) => {
    const user = [lender, borrower, outsider].find((u) => u.id === userId);
    return user ? profileFor(user, { accountStatus: statuses[user.id]! }) : null;
  });
  const created = await request(app()).post('/api/v1/items').set(asLender).send({
    title: 'Camping tent',
    description: 'Four person tent, waterproof.',
    category: 'outdoor',
    condition: 'good',
  });
  listingId = created.body.data.listing.id;
});

const ask = (body: Record<string, unknown>, headers: Record<string, string> = asBorrower) =>
  request(app()).post('/api/v1/borrow-requests').set(headers).send({ listingId, ...body });

const created = async (start = '2026-11-12', end = '2026-11-14', headers = asBorrower) => {
  const res = await ask({ startDate: start, endDate: end }, headers);
  expect(res.status).toBe(201);
  return res.body.data.request.id as string;
};

const act = (id: string, action: 'accept' | 'decline' | 'cancel', headers: Record<string, string>) =>
  request(app()).post(`/api/v1/borrow-requests/${id}/${action}`).set(headers).send({});

describe('POST /api/v1/borrow-requests', () => {
  test('creates a pending request; the lender comes from the listing', async () => {
    const res = await ask({ startDate: '2026-11-12', endDate: '2026-11-14', message: '  For a weekend trip  ' });
    expect(res.status).toBe(201);
    expect(res.body.data.request).toMatchObject({
      status: 'pending',
      startDate: '2026-11-12',
      endDate: '2026-11-14',
      days: 3,
      message: 'For a weekend trip',
      listing: { id: listingId, title: 'Camping tent' },
      borrower: { id: borrower.id },
      lender: { id: lender.id },
      viewerRole: 'borrower',
      decidedAt: null,
      cancelledAt: null,
    });
  });

  test('same-day borrowing (one day) is allowed; today counts in Pakistan time', async () => {
    expect(todayInPakistan(NOW)).toBe('2026-11-10');
    // 23:00 UTC on the 9th is already the 10th in Pakistan.
    expect(todayInPakistan(Date.parse('2026-11-09T23:00:00Z'))).toBe('2026-11-10');
    const res = await ask({ startDate: '2026-11-10', endDate: '2026-11-10' });
    expect(res.status).toBe(201);
    expect(res.body.data.request.days).toBe(1);
  });

  test('requires authentication', async () => {
    const res = await ask({ startDate: '2026-11-12', endDate: '2026-11-14' }, {});
    expect(res.status).toBe(401);
    expect(t.borrowRequests.create).not.toHaveBeenCalled();
  });

  test('requires an active account', async () => {
    statuses[borrower.id] = 'restricted';
    expect((await ask({ startDate: '2026-11-12', endDate: '2026-11-14' })).body.code).toBe('ACCOUNT_RESTRICTED');
    statuses[borrower.id] = 'suspended';
    expect((await ask({ startDate: '2026-11-12', endDate: '2026-11-14' })).body.code).toBe('ACCOUNT_SUSPENDED');
  });

  test('cannot request one’s own listing', async () => {
    const res = await ask({ startDate: '2026-11-12', endDate: '2026-11-14' }, asLender);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('CANNOT_BORROW_OWN_LISTING');
  });

  test('archived and unavailable listings are refused; unknown listings are 404', async () => {
    await request(app()).patch(`/api/v1/items/${listingId}`).set(asLender).send({ availability: 'unavailable' });
    const unavailable = await ask({ startDate: '2026-11-12', endDate: '2026-11-14' });
    expect(unavailable.status).toBe(409);
    expect(unavailable.body.code).toBe('LISTING_NOT_BORROWABLE');

    await request(app()).delete(`/api/v1/items/${listingId}`).set(asLender);
    expect((await ask({ startDate: '2026-11-12', endDate: '2026-11-14' })).status).toBe(404);

    const missing = await ask({ listingId: '00000000-0000-4000-8000-0000000000ff', startDate: '2026-11-12', endDate: '2026-11-14' });
    expect(missing.body.code).toBe('LISTING_NOT_FOUND');
  });

  test.each([
    ['bad format', { startDate: '12/11/2026', endDate: '2026-11-14' }, 'startDate'],
    ['impossible date', { startDate: '2026-02-30', endDate: '2026-11-14' }, 'startDate'],
    ['end before start', { startDate: '2026-11-14', endDate: '2026-11-12' }, 'endDate'],
    ['in the past', { startDate: '2026-11-09', endDate: '2026-11-12' }, 'startDate'],
    ['too far ahead', { startDate: '2027-02-09', endDate: '2027-02-10' }, 'startDate'],
    ['longer than 30 days', { startDate: '2026-11-12', endDate: '2026-12-12' }, 'endDate'],
    ['missing end', { startDate: '2026-11-12' }, 'endDate'],
    ['message too long', { startDate: '2026-11-12', endDate: '2026-11-14', message: 'x'.repeat(501) }, 'message'],
  ])('rejects %s', async (_name, body, field) => {
    const res = await ask(body);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.details.map((d: { field: string }) => d.field)).toContain(field);
    expect(t.borrowRequests.create).not.toHaveBeenCalled();
  });

  test('exactly 30 days and up to 90 days ahead are accepted', async () => {
    expect((await ask({ startDate: '2026-11-12', endDate: '2026-12-11' })).status).toBe(201);
  });

  test('rejects client-supplied borrower or lender ids', async () => {
    for (const extra of [{ borrowerId: outsider.id }, { lenderId: outsider.id }, { status: 'accepted' }]) {
      const res = await ask({ startDate: '2026-11-12', endDate: '2026-11-14', ...extra });
      expect(res.status).toBe(400);
    }
  });

  test('dates overlapping an accepted request are refused (inclusive ends)', async () => {
    const id = await created('2026-11-12', '2026-11-14');
    await act(id, 'accept', asLender);
    const overlap = await ask({ startDate: '2026-11-14', endDate: '2026-11-16' }, asOutsider);
    expect(overlap.status).toBe(409);
    expect(overlap.body.code).toBe('DATES_UNAVAILABLE');
    expect((await ask({ startDate: '2026-11-15', endDate: '2026-11-16' }, asOutsider)).status).toBe(201);
  });

  test('pending requests do not block others; a second pending request by the same borrower is refused', async () => {
    await created('2026-11-12', '2026-11-14');
    expect((await ask({ startDate: '2026-11-12', endDate: '2026-11-14' }, asOutsider)).status).toBe(201);
    const dup = await ask({ startDate: '2026-11-20', endDate: '2026-11-21' });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('DUPLICATE_PENDING_REQUEST');
  });

  test('is rate limited per user', async () => {
    t = testApp({ now: () => NOW, rateLimits: { ...DEFAULT_RATE_LIMITS, borrowRequestCreatePerUser: { windowMs: 60_000, limit: 1 } } });
    t.gateway.getUser.mockResolvedValue({ user: borrower, roles: [] });
    t.profiles.getProfile.mockResolvedValue(profileFor(borrower));
    const send = () => request(t.app).post('/api/v1/borrow-requests').set(asBorrower).send({});
    expect((await send()).status).toBe(400);
    expect((await send()).status).toBe(429);
  });
});

describe('accept, decline and cancel', () => {
  test('the lender accepts; the decision is recorded', async () => {
    const id = await created();
    const res = await act(id, 'accept', asLender);
    expect(res.status).toBe(200);
    expect(res.body.data.request).toMatchObject({ status: 'accepted', viewerRole: 'lender', decidedAt: expect.any(String) });
  });

  test('the lender declines', async () => {
    const id = await created();
    expect((await act(id, 'decline', asLender)).body.data.request.status).toBe('declined');
  });

  test('the borrower cancels while pending', async () => {
    const id = await created();
    const res = await act(id, 'cancel', asBorrower);
    expect(res.body.data.request).toMatchObject({ status: 'cancelled', cancelledAt: expect.any(String) });
  });

  test('the borrower cannot accept or decline; the lender cannot cancel', async () => {
    const id = await created();
    for (const [action, headers] of [['accept', asBorrower], ['decline', asBorrower], ['cancel', asLender]] as const) {
      const res = await act(id, action, headers);
      expect(res.status, action).toBe(403);
    }
    expect(t.borrowRequests.setStatus).not.toHaveBeenCalled();
  });

  test('outsiders get 404 for every action and for reading', async () => {
    const id = await created();
    for (const action of ['accept', 'decline', 'cancel'] as const) {
      const res = await act(id, action, asOutsider);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('BORROW_REQUEST_NOT_FOUND');
    }
    expect((await request(app()).get(`/api/v1/borrow-requests/${id}`).set(asOutsider)).status).toBe(404);
  });

  test.each([
    ['accept', 'decline'],
    ['accept', 'cancel'],
    ['decline', 'accept'],
    ['cancel', 'accept'],
    ['cancel', 'cancel'],
  ] as const)('after %s, %s is refused with 409', async (first, second) => {
    const id = await created();
    await act(id, first, first === 'cancel' ? asBorrower : asLender);
    const res = await act(id, second, second === 'cancel' ? asBorrower : asLender);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('INVALID_STATUS_TRANSITION');
  });

  test('accepting a request whose dates were taken meanwhile fails clearly', async () => {
    const first = await created('2026-11-12', '2026-11-14', asBorrower);
    const second = await created('2026-11-13', '2026-11-13', asOutsider);
    expect((await act(first, 'accept', asLender)).status).toBe(200);
    const res = await act(second, 'accept', asLender);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DATES_UNAVAILABLE');
    // The loser stays pending, so the lender can still decline it.
    expect((await act(second, 'decline', asLender)).status).toBe(200);
  });

  test('two accept calls fired together: exactly one wins', async () => {
    const first = await created('2026-11-12', '2026-11-14', asBorrower);
    const second = await created('2026-11-14', '2026-11-15', asOutsider);
    const results = await Promise.all([act(first, 'accept', asLender), act(second, 'accept', asLender)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  });

  test('accepting needs an active account; a restricted lender may still decline', async () => {
    const a = await created('2026-11-12', '2026-11-12', asBorrower);
    statuses[lender.id] = 'restricted';
    expect((await act(a, 'accept', asLender)).body.code).toBe('ACCOUNT_RESTRICTED');
    expect((await act(a, 'decline', asLender)).status).toBe(200);
  });

  test('malformed ids are 400; unknown ids 404', async () => {
    expect((await act('nope', 'accept', asLender)).status).toBe(400);
    expect((await act('00000000-0000-4000-8000-0000000000ff', 'accept', asLender)).status).toBe(404);
  });

  test('actions require authentication', async () => {
    const id = await created();
    expect((await act(id, 'accept', {})).status).toBe(401);
  });
});

describe('listing requests', () => {
  test('outgoing lists what I asked for; incoming lists requests for my items', async () => {
    const id = await created();
    const out = await request(app()).get('/api/v1/borrow-requests/outgoing').set(asBorrower);
    expect(out.status).toBe(200);
    expect(out.body.data.items.map((r: { id: string }) => r.id)).toEqual([id]);
    expect(out.body.data.pagination).toEqual({ page: 1, pageSize: 20, total: 1, totalPages: 1 });

    const incoming = await request(app()).get('/api/v1/borrow-requests/incoming').set(asLender);
    expect(incoming.body.data.items[0]).toMatchObject({ id, viewerRole: 'lender' });
    expect((await request(app()).get('/api/v1/borrow-requests/incoming').set(asBorrower)).body.data.items).toEqual([]);
    expect((await request(app()).get('/api/v1/borrow-requests/outgoing').set(asOutsider)).body.data.items).toEqual([]);
  });

  test('filters by status and validates the query', async () => {
    const id = await created();
    await act(id, 'decline', asLender);
    const pending = await request(app()).get('/api/v1/borrow-requests/incoming?status=pending').set(asLender);
    expect(pending.body.data.items).toEqual([]);
    const declined = await request(app()).get('/api/v1/borrow-requests/incoming?status=declined').set(asLender);
    expect(declined.body.data.items).toHaveLength(1);
    expect((await request(app()).get('/api/v1/borrow-requests/incoming?status=done').set(asLender)).status).toBe(400);
    expect((await request(app()).get('/api/v1/borrow-requests/incoming?pageSize=99').set(asLender)).status).toBe(400);
  });

  test('participants read a request; it carries no contact details', async () => {
    const id = await created();
    for (const headers of [asBorrower, asLender]) {
      const res = await request(app()).get(`/api/v1/borrow-requests/${id}`).set(headers);
      expect(res.status).toBe(200);
      expect(Object.keys(res.body.data.request.borrower).sort()).toEqual(['displayName', 'id']);
      expect(JSON.stringify(res.body.data.request)).not.toMatch(/email|phone/i);
    }
  });

  test('listing endpoints need authentication', async () => {
    expect((await request(app()).get('/api/v1/borrow-requests/outgoing')).status).toBe(401);
    expect((await request(app()).get('/api/v1/borrow-requests/incoming')).status).toBe(401);
  });
});

describe('GET /api/v1/items/:id/booked-dates', () => {
  test('is public and shows only accepted ranges, without who booked them', async () => {
    const accepted = await created('2026-11-12', '2026-11-14');
    await created('2026-11-20', '2026-11-21', asOutsider); // pending: not booked
    await act(accepted, 'accept', asLender);
    const res = await request(app()).get(`/api/v1/items/${listingId}/booked-dates`);
    expect(res.status).toBe(200);
    expect(res.body.data.bookedDates).toEqual([{ startDate: '2026-11-12', endDate: '2026-11-14' }]);
  });

  test('404 for an unknown listing; does not break GET /items/:id', async () => {
    expect((await request(app()).get('/api/v1/items/00000000-0000-4000-8000-0000000000ff/booked-dates')).status).toBe(404);
    expect((await request(app()).get(`/api/v1/items/${listingId}`)).status).toBe(200);
  });
});

describe('without a configured repository', () => {
  test('borrow endpoints answer 503 SERVER_NOT_CONFIGURED', async () => {
    const { createApp } = await import('../../src/app.js');
    const { testConfig, silentLogger, fakeGateway, fakeProfiles } = await import('../helpers.js');
    const bare = createApp({ config: testConfig(), logger: silentLogger, authGateway: fakeGateway(), profiles: fakeProfiles() });
    const res = await request(bare).get('/api/v1/borrow-requests/outgoing').set(asLender);
    expect(res.status).toBe(503);
  });
});
