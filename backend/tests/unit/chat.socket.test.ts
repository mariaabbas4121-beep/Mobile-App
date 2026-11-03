// The Socket.IO chat server, attached to a real HTTP server on localhost and
// driven by real socket.io-client connections. Repositories are in memory;
// the database rules are tested in tests/db/chat.test.ts.
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server as HttpServer } from 'node:http';
import request from 'supertest';
import { io as connectClient, type Socket as ClientSocket } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { AppError } from '../../src/lib/errors.js';
import { attachChatSocket } from '../../src/realtime/chat.socket.js';
import { OTHER_TOKEN, VALID_TOKEN, profileFor, silentLogger, testApp, testConfig, userA } from '../helpers.js';
import type { AuthUser, Profile } from '../../src/auth/auth.types.js';

const THIRD_TOKEN = 'header.payload-user-c.signature';
const lender = userA;
const borrower: AuthUser = { ...userA, id: '00000000-0000-4000-8000-00000000000b', email: 'b@example.test' };
const outsider: AuthUser = { ...userA, id: '00000000-0000-4000-8000-00000000000c', email: 'c@example.test' };
const asLender = { Authorization: `Bearer ${VALID_TOKEN}` };
const asBorrower = { Authorization: `Bearer ${OTHER_TOKEN}` };

// A token whose payload carries `exp`, to test the expiry disconnect.
const EXP = 1_900_000_000;
const EXPIRING_TOKEN = `header.${Buffer.from(JSON.stringify({ exp: EXP })).toString('base64url')}.signature`;

let t: ReturnType<typeof testApp>;
let server: HttpServer;
let realtime: ReturnType<typeof attachChatSocket>;
let url: string;
let statuses: Record<string, Profile['accountStatus']>;
const clients: ClientSocket[] = [];

async function start(now?: () => number) {
  t = testApp();
  statuses = { [lender.id]: 'active', [borrower.id]: 'active', [outsider.id]: 'active' };
  t.gateway.getUser.mockImplementation(async (token) => {
    const user = { [VALID_TOKEN]: lender, [OTHER_TOKEN]: borrower, [THIRD_TOKEN]: outsider, [EXPIRING_TOKEN]: borrower }[token];
    if (!user) throw AppError.unauthenticated('Access token is invalid or expired', 'INVALID_TOKEN');
    return { user, roles: [] };
  });
  t.profiles.getProfile.mockImplementation(async (_token, userId) => {
    const user = [lender, borrower, outsider].find((u) => u.id === userId);
    return user ? profileFor(user, { accountStatus: statuses[user.id]! }) : null;
  });
  server = t.app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  realtime = attachChatSocket(server, {
    config: testConfig(),
    logger: silentLogger,
    gateway: t.gateway,
    chat: t.chat,
    events: t.chatEvents,
    ...(now ? { now } : {}),
  });
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeEach(async () => {
  await start();
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.disconnect();
  await realtime.close();
});

function client(token?: string) {
  // WebSocket only, as the mobile app connects.
  const c = connectClient(url, { transports: ['websocket'], auth: token ? { token } : {}, reconnection: false, forceNew: true });
  clients.push(c);
  return c;
}

async function connected(token: string) {
  const c = client(token);
  await new Promise<void>((resolve, reject) => {
    c.once('connect', () => resolve());
    c.once('connect_error', reject);
  });
  return c;
}

const call = <T = any>(c: ClientSocket, event: string, payload: unknown): Promise<T> => c.timeout(3000).emitWithAck(event, payload);

// Everything `c` receives for `event`, from now on.
function collect<T = any>(c: ClientSocket, event: string): T[] {
  const seen: T[] = [];
  c.on(event, (payload: T) => seen.push(payload));
  return seen;
}

const settle = () => new Promise((r) => setTimeout(r, 150));

async function acceptedConversation(start = '2099-01-10') {
  // Dates far ahead of the test app's real clock would be refused, so use the
  // repositories directly for setup: a listing, a request, accepted.
  const listing = await t.listings.create({ userId: lender.id, accessToken: VALID_TOKEN }, {
    title: 'Camping tent',
    description: 'Four person tent, waterproof.',
    category: 'outdoor',
    condition: 'good',
    availability: 'available',
    teachMeEnabled: false,
    tags: [],
  } as never);
  const req = await t.borrowRequests.create({ userId: borrower.id, accessToken: OTHER_TOKEN }, {
    listingId: listing.id,
    startDate: start,
    endDate: start,
    message: null,
  });
  await t.borrowRequests.setStatus({ userId: lender.id, accessToken: VALID_TOKEN }, req.id, 'accepted');
  const conversation = await t.chat.openForRequest({ userId: lender.id, accessToken: VALID_TOKEN }, req.id);
  return { conversationId: conversation.id, requestId: req.id };
}

describe('authentication', () => {
  test('connections without a token are refused', async () => {
    const c = client();
    const err = await new Promise<Error & { data?: { code: string } }>((resolve) => c.once('connect_error', resolve));
    expect(err.data?.code).toBe('UNAUTHENTICATED');
    expect(c.connected).toBe(false);
  });

  test('connections with a malformed or rejected token are refused', async () => {
    for (const [token, code] of [
      ['not-a-jwt', 'UNAUTHENTICATED'],
      ['header.payload-unknown.signature', 'INVALID_TOKEN'],
    ] as const) {
      const c = client(token);
      const err = await new Promise<Error & { data?: { code: string } }>((resolve) => c.once('connect_error', resolve));
      expect(err.data?.code, token).toBe(code);
    }
  });

  test('a valid token connects; the user id comes from the token alone', async () => {
    const c = await connected(OTHER_TOKEN);
    expect(c.connected).toBe(true);
    expect(t.gateway.getUser).toHaveBeenCalledWith(OTHER_TOKEN);
  });

  test('the socket is told and disconnected when its access token expires', async () => {
    await realtime.close();
    await start(() => EXP * 1000 - 100);
    const c = await connected(EXPIRING_TOKEN);
    const expired = new Promise<void>((resolve) => c.once('session:expired', () => resolve()));
    const gone = new Promise<string>((resolve) => c.once('disconnect', resolve));
    await expired;
    expect(await gone).toBe('io server disconnect');
  });
});

describe('joining conversations', () => {
  test('participants can join; outsiders and unknown ids get CONVERSATION_NOT_FOUND', async () => {
    const { conversationId } = await acceptedConversation();
    const [b, l, o] = [await connected(OTHER_TOKEN), await connected(VALID_TOKEN), await connected(THIRD_TOKEN)];
    expect(await call(b, 'conversation:join', { conversationId })).toMatchObject({ ok: true, conversation: { id: conversationId, viewerRole: 'borrower' } });
    expect(await call(l, 'conversation:join', { conversationId })).toMatchObject({ ok: true, conversation: { viewerRole: 'lender' } });
    expect(await call(o, 'conversation:join', { conversationId })).toEqual({
      ok: false,
      error: { code: 'CONVERSATION_NOT_FOUND', message: 'Conversation not found' },
    });
    expect((await call(o, 'conversation:join', { conversationId: randomUUID() })).error.code).toBe('CONVERSATION_NOT_FOUND');
    expect((await call(o, 'conversation:join', { conversationId: 'x' })).error.code).toBe('VALIDATION_ERROR');
    // The outsider's socket was never added to the room.
    const sockets = await realtime.io.in(`conversation:${conversationId}`).fetchSockets();
    expect(sockets.map((s) => s.data.userId).sort()).toEqual([lender.id, borrower.id].sort());
  });
});

describe('sending', () => {
  test('a message is stored, acknowledged with its id, and delivered only to the room', async () => {
    const { conversationId } = await acceptedConversation();
    const [b, l, o] = [await connected(OTHER_TOKEN), await connected(VALID_TOKEN), await connected(THIRD_TOKEN)];
    await call(b, 'conversation:join', { conversationId });
    await call(l, 'conversation:join', { conversationId });
    await call(o, 'conversation:join', { conversationId });
    const toLender = collect(l, 'message:new');
    const toOutsider = collect(o, 'message:new');
    const outsiderHints = collect(o, 'conversation:updated');

    // Stored before it is broadcast.
    let storedWhenBroadcast = -1;
    l.once('message:new', () => (storedWhenBroadcast = t.chatRepository.stored.length));

    const clientId = randomUUID();
    const ack = await call(b, 'message:send', { conversationId, clientId, body: '  Is 5pm ok?  ' });
    expect(ack).toMatchObject({ ok: true, duplicate: false, message: { conversationId, senderId: borrower.id, body: 'Is 5pm ok?', clientId } });
    expect(ack.message.id).toBeTruthy();
    expect(ack.message.createdAt).toBeTruthy();

    await settle();
    expect(toLender).toEqual([{ conversationId, message: ack.message }]);
    expect(storedWhenBroadcast).toBe(1);
    expect(toOutsider).toEqual([]);
    expect(outsiderHints).toEqual([]);
  });

  test('participants not in the room get a content-free hint, never the message', async () => {
    const { conversationId } = await acceptedConversation();
    const b = await connected(OTHER_TOKEN);
    const l = await connected(VALID_TOKEN);
    const messages = collect(l, 'message:new');
    const hints = collect(l, 'conversation:updated');
    await call(b, 'message:send', { conversationId, clientId: randomUUID(), body: 'Hello' });
    await settle();
    expect(messages).toEqual([]);
    expect(hints).toEqual([{ conversationId }]);
  });

  test('a retried send (same clientId) is stored and delivered once', async () => {
    const { conversationId } = await acceptedConversation();
    const [b, l] = [await connected(OTHER_TOKEN), await connected(VALID_TOKEN)];
    await call(l, 'conversation:join', { conversationId });
    const toLender = collect(l, 'message:new');
    const clientId = randomUUID();
    const first = await call(b, 'message:send', { conversationId, clientId, body: 'Hello' });
    const retry = await call(b, 'message:send', { conversationId, clientId, body: 'Hello' });
    expect(retry).toMatchObject({ ok: true, duplicate: true, message: { id: first.message.id } });
    await settle();
    expect(toLender).toHaveLength(1);
    expect(t.chatRepository.stored).toHaveLength(1);
  });

  test('invalid messages and client-supplied sender ids are refused', async () => {
    const { conversationId } = await acceptedConversation();
    const b = await connected(OTHER_TOKEN);
    for (const payload of [
      { conversationId, clientId: randomUUID(), body: '   ' },
      { conversationId, clientId: randomUUID(), body: 'x'.repeat(2001) },
      { conversationId, clientId: 'nope', body: 'hi' },
      { conversationId, clientId: randomUUID(), body: 'hi', senderId: lender.id },
      { conversationId: 'nope', clientId: randomUUID(), body: 'hi' },
      null,
    ]) {
      const ack = await call(b, 'message:send', payload);
      expect(ack.ok, JSON.stringify(payload)?.slice(0, 50)).toBe(false);
      expect(ack.error.code).toBe('VALIDATION_ERROR');
    }
    expect(t.chatRepository.stored).toHaveLength(0);
  });

  test('outsiders cannot send, even without joining', async () => {
    const { conversationId } = await acceptedConversation();
    const o = await connected(THIRD_TOKEN);
    const ack = await call(o, 'message:send', { conversationId, clientId: randomUUID(), body: 'hi' });
    expect(ack).toMatchObject({ ok: false, error: { code: 'CONVERSATION_NOT_FOUND' } });
    expect(t.chatRepository.stored).toHaveLength(0);
  });

  test('chat is refused once the request is no longer accepted', async () => {
    const { conversationId, requestId } = await acceptedConversation();
    // Accepted is final in this phase; this guards later phases.
    t.borrowRequests.rows.get(requestId)!.status = 'cancelled';
    const b = await connected(OTHER_TOKEN);
    const ack = await call(b, 'message:send', { conversationId, clientId: randomUUID(), body: 'hi' });
    expect(ack).toMatchObject({ ok: false, error: { code: 'CHAT_NOT_AVAILABLE' } });
  });

  test('a suspended account cannot send; the check is made on every send', async () => {
    const { conversationId } = await acceptedConversation();
    const b = await connected(OTHER_TOKEN);
    expect((await call(b, 'message:send', { conversationId, clientId: randomUUID(), body: 'one' })).ok).toBe(true);
    statuses[borrower.id] = 'suspended';
    const ack = await call(b, 'message:send', { conversationId, clientId: randomUUID(), body: 'two' });
    expect(ack).toMatchObject({ ok: false, error: { code: 'ACCOUNT_SUSPENDED' } });
  });

  test('without an acknowledgement callback, failures arrive as message:error', async () => {
    const { conversationId } = await acceptedConversation();
    const o = await connected(THIRD_TOKEN);
    const clientId = randomUUID();
    const error = new Promise((resolve) => o.once('message:error', resolve));
    o.emit('message:send', { conversationId, clientId, body: 'hi' });
    expect(await error).toEqual({
      conversationId,
      clientId,
      error: { code: 'CONVERSATION_NOT_FOUND', message: 'Conversation not found' },
    });
  });

  test('messages sent over REST reach sockets in the room too', async () => {
    const { conversationId } = await acceptedConversation();
    const l = await connected(VALID_TOKEN);
    await call(l, 'conversation:join', { conversationId });
    const toLender = collect(l, 'message:new');
    const res = await request(server)
      .post(`/api/v1/conversations/${conversationId}/messages`)
      .set(asBorrower)
      .send({ clientId: randomUUID(), body: 'Sent while offline' });
    expect(res.status).toBe(201);
    await settle();
    expect(toLender).toEqual([{ conversationId, message: res.body.data.message }]);
  });

  test('after leaving, a socket no longer receives the conversation’s messages', async () => {
    const { conversationId } = await acceptedConversation();
    const [b, l] = [await connected(OTHER_TOKEN), await connected(VALID_TOKEN)];
    await call(l, 'conversation:join', { conversationId });
    expect(await call(l, 'conversation:leave', { conversationId })).toEqual({ ok: true });
    const toLender = collect(l, 'message:new');
    await call(b, 'message:send', { conversationId, clientId: randomUUID(), body: 'hi' });
    await settle();
    expect(toLender).toEqual([]);
    // REST check that the lender is still a participant.
    expect((await request(server).get(`/api/v1/conversations/${conversationId}`).set(asLender)).status).toBe(200);
  });
});
