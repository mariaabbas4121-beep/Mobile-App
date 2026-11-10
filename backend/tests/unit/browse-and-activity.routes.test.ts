// Browsing other people's listings (owner=others) and the activity feed,
// through the API with in-memory repositories. The database side of
// owner=others is tested in tests/db/browse-exclude-owner.test.ts.
import request from 'supertest';
import { beforeEach, describe, expect, test } from 'vitest';
import { AppError } from '../../src/lib/errors.js';
import type { AuthUser } from '../../src/auth/auth.types.js';
import { OTHER_TOKEN, VALID_TOKEN, profileFor, testApp, userA } from '../helpers.js';

const NOW = Date.parse('2026-11-10T06:00:00Z');
const THIRD_TOKEN = 'header.payload-user-c.signature';
const lender = userA;
const borrower: AuthUser = { ...userA, id: '00000000-0000-4000-8000-00000000000b', email: 'b@example.test' };
const outsider: AuthUser = { ...userA, id: '00000000-0000-4000-8000-00000000000c', email: 'c@example.test' };
const asLender = { Authorization: `Bearer ${VALID_TOKEN}` };
const asBorrower = { Authorization: `Bearer ${OTHER_TOKEN}` };
const asOutsider = { Authorization: `Bearer ${THIRD_TOKEN}` };

let t: ReturnType<typeof testApp>;

beforeEach(() => {
  t = testApp({ now: () => NOW });
  t.gateway.getUser.mockImplementation(async (token) => {
    const user = { [VALID_TOKEN]: lender, [OTHER_TOKEN]: borrower, [THIRD_TOKEN]: outsider }[token];
    if (!user) throw AppError.unauthenticated('Access token is invalid or expired', 'INVALID_TOKEN');
    return { user, roles: [] };
  });
  t.profiles.getProfile.mockImplementation(async (_token, userId) => {
    const user = [lender, borrower, outsider].find((u) => u.id === userId);
    return user ? profileFor(user, { accountStatus: 'active' }) : null;
  });
});

async function listItem(headers: Record<string, string>, title: string, location?: { latitude: number; longitude: number }) {
  const res = await request(t.app)
    .post('/api/v1/items')
    .set(headers)
    .send({ title, description: 'A useful item to borrow.', category: 'tools', condition: 'good', city: 'Faisalabad' });
  expect(res.status).toBe(201);
  const id = res.body.data.listing.id as string;
  if (location) expect((await request(t.app).put(`/api/v1/items/${id}/location`).set(headers).send(location)).status).toBe(200);
  return id;
}

const UAF = { latitude: 31.431, longitude: 73.07 };
const titles = (res: request.Response) => (res.body.data.items as { title: string }[]).map((i) => i.title).sort();

describe('owner=others', () => {
  beforeEach(async () => {
    await listItem(asLender, 'Lender drill', UAF);
    await listItem(asLender, 'Lender ladder', UAF);
    await listItem(asBorrower, 'Borrower drill', UAF);
    await listItem(asBorrower, 'Borrower tent');
  });

  test('the signed-in caller never sees their own listings, in any kind of browsing', async () => {
    for (const q of ['', '&q=drill', `&lat=${UAF.latitude}&lng=${UAF.longitude}`, '&city=Faisalabad', '&page=1&pageSize=1']) {
      const res = await request(t.app).get(`/api/v1/items?owner=others${q}`).set(asLender);
      expect(res.status).toBe(200);
      expect(res.body.data.items.length).toBeGreaterThan(0);
      for (const item of res.body.data.items) expect(item.owner.id).toBe(borrower.id);
    }
    const all = await request(t.app).get('/api/v1/items?owner=others').set(asLender);
    expect(titles(all)).toEqual(['Borrower drill', 'Borrower tent']);
    expect(all.body.data.pagination.total).toBe(2);
    const nearby = await request(t.app).get(`/api/v1/items?owner=others&lat=${UAF.latitude}&lng=${UAF.longitude}`).set(asLender);
    expect(titles(nearby)).toEqual(['Borrower drill']);
  });

  test('the exclusion comes from the token: each user sees the other’s listings', async () => {
    expect(titles(await request(t.app).get('/api/v1/items?owner=others').set(asBorrower))).toEqual(['Lender drill', 'Lender ladder']);
    expect(titles(await request(t.app).get('/api/v1/items?owner=others').set(asOutsider))).toHaveLength(4);
  });

  test('anonymous callers have nothing to hide and see everything', async () => {
    const res = await request(t.app).get('/api/v1/items?owner=others');
    expect(res.status).toBe(200);
    expect(res.body.data.pagination.total).toBe(4);
  });

  test('owner=me still lists the caller’s own listings, and plain searches are unchanged', async () => {
    expect(titles(await request(t.app).get('/api/v1/items?owner=me').set(asLender))).toEqual(['Lender drill', 'Lender ladder']);
    expect((await request(t.app).get('/api/v1/items').set(asLender)).body.data.pagination.total).toBe(4);
  });

  test('a client cannot name someone else to exclude or include', async () => {
    for (const q of [`owner=${borrower.id}`, 'owner=everyone', `ownerId=${borrower.id}&owner=others`]) {
      const res = await request(t.app).get(`/api/v1/items?${q}`).set(asLender);
      if (res.status === 200) {
        for (const item of res.body.data.items) expect(item.owner.id).not.toBe(lender.id);
      } else {
        expect(res.status).toBe(400);
      }
    }
  });
});

describe('GET /activity', () => {
  let listingId: string;

  beforeEach(async () => {
    listingId = await listItem(asLender, 'Camping tent');
  });

  const borrow = async (start: string) => {
    const res = await request(t.app).post('/api/v1/borrow-requests').set(asBorrower).send({ listingId, startDate: start, endDate: start });
    expect(res.status).toBe(201);
    return res.body.data.request.id as string;
  };
  const decide = (id: string, action: 'accept' | 'decline' | 'cancel') =>
    request(t.app).post(`/api/v1/borrow-requests/${id}/${action}`).set(action === 'cancel' ? asBorrower : asLender).send({});
  const activity = (headers: Record<string, string>) => request(t.app).get('/api/v1/activity').set(headers);

  test('needs a token', async () => {
    expect((await request(t.app).get('/api/v1/activity')).status).toBe(401);
  });

  test('a new user has no activity, never made-up entries', async () => {
    const res = await activity(asOutsider);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ items: [], unavailable: [] });
  });

  test('requests, decisions, messages and listings, from each side, newest first', async () => {
    const accepted = await borrow('2026-11-12');
    expect((await decide(accepted, 'accept')).status).toBe(200);
    const declined = await borrow('2026-11-14');
    expect((await decide(declined, 'decline')).status).toBe(200);
    const cancelled = await borrow('2026-11-16');
    expect((await decide(cancelled, 'cancel')).status).toBe(200);
    const conversation = (await request(t.app).post('/api/v1/conversations').set(asLender).send({ borrowRequestId: accepted })).body.data
      .conversation.id as string;
    const sent = await request(t.app)
      .post(`/api/v1/conversations/${conversation}/messages`)
      .set(asBorrower)
      .send({ clientId: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d', body: 'Can I pick it up at 5?' });
    expect(sent.status).toBe(201);

    const forLender = (await activity(asLender)).body.data;
    const types = forLender.items.map((i: { type: string }) => i.type);
    expect(types.filter((x: string) => x === 'request_received')).toHaveLength(3);
    expect(types).toEqual(expect.arrayContaining(['request_accepted', 'request_declined', 'request_cancelled', 'message', 'listing_created']));
    expect(forLender.unavailable).toEqual([]);

    const times = forLender.items.map((i: { occurredAt: string }) => Date.parse(i.occurredAt));
    expect([...times].sort((a, b) => b - a)).toEqual(times);

    const message = forLender.items.find((i: { type: string }) => i.type === 'message');
    expect(message).toMatchObject({
      conversationId: conversation,
      preview: 'Can I pick it up at 5?',
      actor: { id: borrower.id, isYou: false },
      listing: { id: listingId, title: 'Camping tent' },
    });
    const acceptedEvent = forLender.items.find((i: { id: string }) => i.id === `request:${accepted}:accepted`);
    expect(acceptedEvent).toMatchObject({ actor: { id: lender.id, isYou: true }, request: { viewerRole: 'lender', status: 'accepted' } });

    const forBorrower = (await activity(asBorrower)).body.data.items;
    expect(forBorrower.filter((i: { type: string }) => i.type === 'request_sent')).toHaveLength(3);
    expect(forBorrower.find((i: { type: string }) => i.type === 'message')).toMatchObject({ actor: { id: borrower.id, isYou: true } });
    // The lender's listing is not the borrower's activity.
    expect(forBorrower.some((i: { type: string }) => i.type === 'listing_created')).toBe(false);
  });

  test('another user’s requests, messages and listings never appear', async () => {
    const id = await borrow('2026-11-12');
    await decide(id, 'accept');
    await listItem(asOutsider, 'Outsider bike');
    const items = (await activity(asOutsider)).body.data.items as { listing: { title: string } | null; request: unknown }[];
    expect(items.every((i) => i.request === null)).toBe(true);
    expect(items.map((i) => i.listing?.title)).toEqual(['Outsider bike']);
  });

  test('archiving a listing is recorded; ordinary edits are not', async () => {
    await request(t.app).patch(`/api/v1/items/${listingId}`).set(asLender).send({ title: 'Big camping tent' });
    expect((await request(t.app).delete(`/api/v1/items/${listingId}`).set(asLender)).status).toBe(200);
    const types = (await activity(asLender)).body.data.items.map((i: { type: string }) => i.type);
    expect(types).toEqual(['listing_archived', 'listing_created']);
  });

  test('one unavailable source is reported and the rest still returned; all unavailable is an error', async () => {
    t.chatRepository.list.mockRejectedValueOnce(AppError.unavailable('down', 'DATABASE_UNAVAILABLE'));
    const res = await activity(asLender);
    expect(res.status).toBe(200);
    expect(res.body.data.unavailable).toEqual(['conversations']);
    expect(res.body.data.items.map((i: { type: string }) => i.type)).toEqual(['listing_created']);

    const down = AppError.unavailable('down', 'DATABASE_UNAVAILABLE');
    t.chatRepository.list.mockRejectedValueOnce(down);
    t.borrowRequests.list.mockRejectedValue(down);
    t.listings.search.mockRejectedValueOnce(down);
    t.handovers.listEvents.mockRejectedValueOnce(down);
    t.returns.listEvents.mockRejectedValueOnce(down);
    const failed = await activity(asLender);
    expect(failed.status).toBe(503);
    expect(failed.body.code).toBe('DATABASE_UNAVAILABLE');
  });

  test('limit is validated and applied', async () => {
    await listItem(asLender, 'Second tent');
    expect((await request(t.app).get('/api/v1/activity?limit=1').set(asLender)).body.data.items).toHaveLength(1);
    expect((await request(t.app).get('/api/v1/activity?limit=0').set(asLender)).status).toBe(400);
  });
});
