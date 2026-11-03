// Chat REST endpoints with in-memory repositories. The same rules are tested
// against the real migration in tests/db/chat.test.ts.
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeEach, describe, expect, test } from 'vitest';
import { AppError } from '../../src/lib/errors.js';
import { DEFAULT_RATE_LIMITS } from '../../src/middleware/rate-limit.middleware.js';
import { encodeCursor } from '../../src/chat/chat.schemas.js';
import type { MessageCreatedEvent } from '../../src/chat/chat.types.js';
import { OTHER_TOKEN, VALID_TOKEN, profileFor, testApp, userA } from '../helpers.js';
import type { AuthUser, Profile } from '../../src/auth/auth.types.js';

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
let published: MessageCreatedEvent[];

function setup(rateLimits = DEFAULT_RATE_LIMITS) {
  t = testApp({ now: () => NOW, rateLimits });
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
  published = [];
  t.chatEvents.subscribe((e) => published.push(e));
}

beforeEach(async () => {
  setup();
  const created = await request(t.app).post('/api/v1/items').set(asLender).send({
    title: 'Camping tent',
    description: 'Four person tent, waterproof.',
    category: 'outdoor',
    condition: 'good',
  });
  listingId = created.body.data.listing.id;
});

async function borrowRequest(decision?: 'accept' | 'decline' | 'cancel', start = '2026-11-12') {
  const res = await request(t.app)
    .post('/api/v1/borrow-requests')
    .set(asBorrower)
    .send({ listingId, startDate: start, endDate: start });
  expect(res.status).toBe(201);
  const id = res.body.data.request.id as string;
  if (decision) {
    const decided = await request(t.app).post(`/api/v1/borrow-requests/${id}/${decision}`).set(decision === 'cancel' ? asBorrower : asLender).send({});
    expect(decided.status).toBe(200);
  }
  return id;
}

const open = (borrowRequestId: string, headers: Record<string, string>) =>
  request(t.app).post('/api/v1/conversations').set(headers).send({ borrowRequestId });

async function acceptedConversation() {
  const requestId = await borrowRequest('accept');
  const res = await open(requestId, asLender);
  expect(res.status).toBe(200);
  return { requestId, conversationId: res.body.data.conversation.id as string };
}

const send = (conversationId: string, body: unknown, headers: Record<string, string> = asBorrower) =>
  request(t.app).post(`/api/v1/conversations/${conversationId}/messages`).set(headers).send(body as object);

describe('opening a conversation', () => {
  test('both participants get the same conversation for an accepted request, however often they ask', async () => {
    const requestId = await borrowRequest('accept');
    const first = await open(requestId, asLender);
    expect(first.status).toBe(200);
    expect(first.body.data.conversation).toMatchObject({
      borrowRequestId: requestId,
      viewerRole: 'lender',
      request: { id: requestId, status: 'accepted' },
      listing: { id: listingId, title: 'Camping tent', archived: false },
      otherParticipant: { id: borrower.id },
      lastMessage: null,
      unreadCount: 0,
    });
    const again = await open(requestId, asLender);
    const forBorrower = await open(requestId, asBorrower);
    expect(again.body.data.conversation.id).toBe(first.body.data.conversation.id);
    expect(forBorrower.body.data.conversation).toMatchObject({
      id: first.body.data.conversation.id,
      viewerRole: 'borrower',
      otherParticipant: { id: lender.id },
    });
    expect(t.chatRepository.conversations.size).toBe(1);
  });

  test('pending, declined and cancelled requests cannot be chatted about', async () => {
    // One pending request per borrower per listing, so the pending one last.
    const declined = await borrowRequest('decline', '2026-11-13');
    const cancelled = await borrowRequest('cancel', '2026-11-14');
    const pending = await borrowRequest(undefined, '2026-11-12');
    for (const id of [pending, declined, cancelled]) {
      for (const who of [asBorrower, asLender]) {
        const res = await open(id, who);
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('CHAT_NOT_AVAILABLE');
      }
    }
    expect(t.chatRepository.conversations.size).toBe(0);
  });

  test('outsiders and unknown requests get 404', async () => {
    const requestId = await borrowRequest('accept');
    expect((await open(requestId, asOutsider)).body.code).toBe('BORROW_REQUEST_NOT_FOUND');
    expect((await open(randomUUID(), asBorrower)).status).toBe(404);
  });

  test('participant ids are never accepted from the client', async () => {
    const requestId = await borrowRequest('accept');
    const res = await request(t.app).post('/api/v1/conversations').set(asOutsider).send({ borrowRequestId: requestId, borrowerId: outsider.id });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  test('authentication is required everywhere', async () => {
    const { conversationId } = await acceptedConversation();
    const calls = [
      request(t.app).get('/api/v1/conversations'),
      request(t.app).post('/api/v1/conversations').send({ borrowRequestId: randomUUID() }),
      request(t.app).get(`/api/v1/conversations/${conversationId}`),
      request(t.app).get(`/api/v1/conversations/${conversationId}/messages`),
      request(t.app).post(`/api/v1/conversations/${conversationId}/messages`).send({ clientId: randomUUID(), body: 'hi' }),
      request(t.app).post(`/api/v1/conversations/${conversationId}/read`),
    ];
    for (const res of await Promise.all(calls)) expect(res.status).toBe(401);
  });
});

describe('reading', () => {
  test('lists the caller’s conversations with the latest message and unread count', async () => {
    const { conversationId } = await acceptedConversation();
    await send(conversationId, { clientId: randomUUID(), body: 'Hi, is 5pm ok?' });

    const forLender = await request(t.app).get('/api/v1/conversations').set(asLender);
    expect(forLender.status).toBe(200);
    expect(forLender.body.data.pagination).toMatchObject({ total: 1 });
    expect(forLender.body.data.items[0]).toMatchObject({
      id: conversationId,
      lastMessage: { body: 'Hi, is 5pm ok?', senderId: borrower.id },
      unreadCount: 1,
    });
    const forOutsider = await request(t.app).get('/api/v1/conversations').set(asOutsider);
    expect(forOutsider.body.data.items).toEqual([]);

    const read = await request(t.app).post(`/api/v1/conversations/${conversationId}/read`).set(asLender);
    expect(read.status).toBe(200);
    expect(read.body.data.conversation.unreadCount).toBe(0);
  });

  test('outsiders get 404 for the conversation, its messages and marking it read', async () => {
    const { conversationId } = await acceptedConversation();
    for (const res of [
      await request(t.app).get(`/api/v1/conversations/${conversationId}`).set(asOutsider),
      await request(t.app).get(`/api/v1/conversations/${conversationId}/messages`).set(asOutsider),
      await request(t.app).post(`/api/v1/conversations/${conversationId}/read`).set(asOutsider),
    ]) {
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('CONVERSATION_NOT_FOUND');
    }
  });

  test('history pages newest first; the cursor gives the next older page', async () => {
    const { conversationId } = await acceptedConversation();
    for (let i = 1; i <= 5; i++) {
      expect((await send(conversationId, { clientId: randomUUID(), body: `m${i}` }, i % 2 ? asBorrower : asLender)).status).toBe(201);
    }
    const url = `/api/v1/conversations/${conversationId}/messages`;
    const first = await request(t.app).get(url).query({ limit: 2 }).set(asLender);
    expect(first.status).toBe(200);
    expect(first.body.data.items.map((m: { body: string }) => m.body)).toEqual(['m5', 'm4']);
    const second = await request(t.app).get(url).query({ limit: 2, before: first.body.data.nextCursor }).set(asLender);
    expect(second.body.data.items.map((m: { body: string }) => m.body)).toEqual(['m3', 'm2']);
    const third = await request(t.app).get(url).query({ limit: 2, before: second.body.data.nextCursor }).set(asLender);
    expect(third.body.data.items.map((m: { body: string }) => m.body)).toEqual(['m1']);
    expect(third.body.data.nextCursor).toBeNull();
  });

  test('a malformed cursor or limit is a validation error', async () => {
    const { conversationId } = await acceptedConversation();
    const url = `/api/v1/conversations/${conversationId}/messages`;
    expect((await request(t.app).get(url).query({ before: 'nonsense' }).set(asLender)).status).toBe(400);
    expect((await request(t.app).get(url).query({ limit: 500 }).set(asLender)).status).toBe(400);
    const forged = encodeCursor({ createdAt: 'yesterday', id: randomUUID() });
    expect((await request(t.app).get(url).query({ before: forged }).set(asLender)).status).toBe(400);
  });
});

describe('sending over REST', () => {
  test('stores the message, returns it with a stable id and time, and publishes it once', async () => {
    const { conversationId } = await acceptedConversation();
    const clientId = randomUUID();
    const res = await send(conversationId, { clientId, body: '  See you at 5  ' });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      duplicate: false,
      message: { conversationId, senderId: borrower.id, body: 'See you at 5', clientId },
    });
    expect(res.body.data.message.id).toBeTruthy();
    expect(res.body.data.message.createdAt).toBeTruthy();
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ conversationId, participantIds: [borrower.id, lender.id] });
  });

  test('a retry with the same clientId returns the stored message and is not published again', async () => {
    const { conversationId } = await acceptedConversation();
    const clientId = randomUUID();
    const first = await send(conversationId, { clientId, body: 'Hello' });
    const retry = await send(conversationId, { clientId, body: 'Hello' });
    expect(retry.status).toBe(200);
    expect(retry.body.data).toMatchObject({ duplicate: true, message: { id: first.body.data.message.id } });
    expect(t.chatRepository.stored).toHaveLength(1);
    expect(published).toHaveLength(1);
    const reused = await send(conversationId, { clientId, body: 'Different text' });
    expect(reused.status).toBe(409);
    expect(reused.body.code).toBe('CLIENT_ID_REUSED');
  });

  test('empty, blank, over-long and malformed messages are refused', async () => {
    const { conversationId } = await acceptedConversation();
    for (const body of [
      { clientId: randomUUID(), body: '' },
      { clientId: randomUUID(), body: ' \n\t ' },
      { clientId: randomUUID(), body: 'x'.repeat(2001) },
      { clientId: randomUUID(), body: 42 },
      { clientId: 'not-a-uuid', body: 'hi' },
      { body: 'hi' },
    ]) {
      const res = await send(conversationId, body);
      expect(res.status, JSON.stringify(body).slice(0, 40)).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    }
    expect((await send(conversationId, { clientId: randomUUID(), body: '😀'.repeat(2000) })).status).toBe(201);
    expect(t.chatRepository.stored).toHaveLength(1);
  });

  test('control characters are removed; newlines are kept', async () => {
    const { conversationId } = await acceptedConversation();
    const res = await send(conversationId, { clientId: randomUUID(), body: 'line one\r\nline\u0000 two\u0007' });
    expect(res.body.data.message.body).toBe('line one\nline two');
  });

  test('sender and conversation can never be set in the body', async () => {
    const { conversationId } = await acceptedConversation();
    const res = await send(conversationId, { clientId: randomUUID(), body: 'hi', senderId: lender.id });
    expect(res.status).toBe(400);
    expect(t.chatRepository.stored).toHaveLength(0);
  });

  test('outsiders cannot send', async () => {
    const { conversationId } = await acceptedConversation();
    const res = await send(conversationId, { clientId: randomUUID(), body: 'hi' }, asOutsider);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('CONVERSATION_NOT_FOUND');
    expect(published).toHaveLength(0);
  });

  test('suspended accounts cannot send; restricted ones can', async () => {
    const { conversationId } = await acceptedConversation();
    statuses[borrower.id] = 'suspended';
    const refused = await send(conversationId, { clientId: randomUUID(), body: 'hi' });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('ACCOUNT_SUSPENDED');
    statuses[lender.id] = 'restricted';
    expect((await send(conversationId, { clientId: randomUUID(), body: 'hi' }, asLender)).status).toBe(201);
  });

  test('archiving the listing keeps the conversation usable', async () => {
    const { conversationId } = await acceptedConversation();
    expect((await request(t.app).delete(`/api/v1/items/${listingId}`).set(asLender)).status).toBe(200);
    expect((await send(conversationId, { clientId: randomUUID(), body: 'Still on?' })).status).toBe(201);
    const res = await request(t.app).get(`/api/v1/conversations/${conversationId}`).set(asBorrower);
    expect(res.body.data.conversation.listing.archived).toBe(true);
  });

  test('sending is rate limited per user', async () => {
    setup({ ...DEFAULT_RATE_LIMITS, chatMessagePerUser: { windowMs: 60_000, limit: 2 } });
    const created = await request(t.app).post('/api/v1/items').set(asLender).send({
      title: 'Camping tent',
      description: 'Four person tent, waterproof.',
      category: 'outdoor',
      condition: 'good',
    });
    listingId = created.body.data.listing.id;
    const { conversationId } = await acceptedConversation();
    expect((await send(conversationId, { clientId: randomUUID(), body: '1' })).status).toBe(201);
    expect((await send(conversationId, { clientId: randomUUID(), body: '2' })).status).toBe(201);
    const limited = await send(conversationId, { clientId: randomUUID(), body: '3' });
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBeTruthy();
    // The other participant has their own allowance.
    expect((await send(conversationId, { clientId: randomUUID(), body: 'reply' }, asLender)).status).toBe(201);
  });
});
