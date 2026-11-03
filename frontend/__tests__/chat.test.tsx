import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import Toast from 'react-native-toast-message';
import { AuthProvider } from '../context/AuthContext';
import { ListingsProvider } from '../context/ListingsContext';
import { BorrowRequestsProvider } from '../context/BorrowRequestsContext';
import { ChatProvider } from '../context/ChatContext';
import { AppProvider } from '../context/AppContext';
import ChatListScreen from '../app/(tabs)/chat';
import ConversationScreen from '../app/chat/[id]';
import BorrowRequestsScreen from '../app/requests/index';
import type { ApiClient } from '../lib/api/client';
import { ChatConnection, type SocketLike } from '../lib/chat/connection';
import { apiError, borrowRequest, chatMessage, conversation, fakeApi, services, session } from './support/fakes';

const mockRouter = { replace: jest.fn(), push: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => true) };
let mockParams: Record<string, string> = {};
jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useLocalSearchParams: () => mockParams,
  useFocusEffect: (effect: () => void) => jest.requireActual('react').useEffect(effect, [effect]),
}));
jest.mock('react-native-toast-message', () => ({ __esModule: true, default: { show: jest.fn() } }));

const CONVERSATION_ID = conversation().id;

// Stands in for a socket.io-client Socket. Tests play the server: connect,
// disconnect, push events, and answer acknowledgements.
class FakeSocket implements SocketLike {
  connected = false;
  connectCalls = 0;
  emitted: { event: string; payload: any }[] = [];
  answer: (event: string, payload: any) => Promise<any> = async (event) =>
    event === 'conversation:join' ? { ok: true, conversation: conversation() } : { ok: true };
  private handlers = new Map<string, Set<(...args: any[]) => void>>();

  connect() {
    this.connectCalls += 1;
  }
  disconnect() {
    this.connected = false;
  }
  on(event: string, listener: (...args: any[]) => void) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(listener);
  }
  off(event: string, listener?: (...args: any[]) => void) {
    if (listener) this.handlers.get(event)?.delete(listener);
    else this.handlers.delete(event);
  }
  timeout() {
    return {
      emitWithAck: (event: string, payload: unknown) => {
        this.emitted.push({ event, payload });
        return this.answer(event, payload);
      },
    };
  }
  fire(event: string, ...args: unknown[]) {
    for (const l of this.handlers.get(event) ?? []) l(...args);
  }
  serverConnect() {
    this.connected = true;
    this.fire('connect');
  }
  serverDisconnect(reason = 'transport close') {
    this.connected = false;
    this.fire('disconnect', reason);
  }
  sent(event: string) {
    return this.emitted.filter((e) => e.event === event).map((e) => e.payload);
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  mockParams = {};
});

let ids = 0;
async function renderApp(element: React.ReactElement, { api = fakeApi(), socket = null as FakeSocket | null } = {}) {
  const s = services({ api });
  await s.sessionManager.setSession(session(1));
  const svc = { api: s.api as unknown as ApiClient, sessionManager: s.sessionManager };
  const chat = {
    ...svc,
    socket: socket ? { url: 'http://api.test', create: () => socket } : null,
    newId: () => `client-${++ids}`,
  };
  await render(
    <AuthProvider services={s.asServices}>
      <ListingsProvider services={svc}>
        <BorrowRequestsProvider services={svc}>
          <ChatProvider services={chat}>
            <AppProvider>{element}</AppProvider>
          </ChatProvider>
        </BorrowRequestsProvider>
      </ListingsProvider>
    </AuthProvider>,
  );
  return { api, socket };
}

const page = (items: ReturnType<typeof conversation>[]) => ({
  items,
  pagination: { page: 1, pageSize: 50, total: items.length, totalPages: 1 },
});

describe('conversation list', () => {
  test('shows a spinner, then the empty state for someone with no accepted requests', async () => {
    const api = fakeApi();
    let resolve!: (v: unknown) => void;
    api.listConversations.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    await renderApp(<ChatListScreen />, { api });
    expect(screen.getByLabelText('Loading conversations')).toBeTruthy();
    await act(async () => resolve(page([])));
    expect(await screen.findByText('No chats yet')).toBeTruthy();
    expect(screen.getByText(/A chat opens when a borrow request is accepted/)).toBeTruthy();
  });

  test('an error offers a retry that loads the list', async () => {
    const api = fakeApi();
    api.listConversations.mockRejectedValueOnce(apiError(0, 'NETWORK_ERROR')).mockResolvedValue(page([conversation()]));
    await renderApp(<ChatListScreen />, { api });
    expect(await screen.findByText('Could not load your chats')).toBeTruthy();
    expect(screen.getByText('Could not reach NeighborShare. Check your connection and try again.')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Ahmed')).toBeTruthy();
  });

  test('rows show the other person, the item, the latest message and unread count, and open the chat', async () => {
    const api = fakeApi();
    api.listConversations.mockResolvedValue(
      page([
        conversation({
          lastMessage: { id: 'm1', senderId: 'user-2', body: 'Pickup at 5?', createdAt: '2026-11-10T10:00:00Z' },
          lastMessageAt: '2026-11-10T10:00:00Z',
          unreadCount: 2,
        }),
        conversation({
          id: '66666666-6666-4666-8666-666666666666',
          viewerRole: 'lender',
          otherParticipant: { id: 'user-3', displayName: 'Bilal' },
          listing: { id: 'l2', title: 'Ladder', archived: false, imageUrl: null },
          lastMessage: { id: 'm2', senderId: 'user-1', body: 'See you then', createdAt: '2026-11-09T10:00:00Z' },
        }),
      ]),
    );
    await renderApp(<ChatListScreen />, { api });
    expect(await screen.findByText('Pickup at 5?')).toBeTruthy();
    expect(screen.getByText(/Lending you Bosch power drill/)).toBeTruthy();
    expect(screen.getByText(/Borrowing your Ladder/)).toBeTruthy();
    // Own latest message is prefixed.
    expect(screen.getByText('You: See you then')).toBeTruthy();
    expect(screen.getByText('2')).toBeTruthy();

    await fireEvent.press(screen.getByRole('button', { name: 'Chat with Ahmed about Bosch power drill, 2 unread' }));
    expect(mockRouter.push).toHaveBeenCalledWith(`/chat/${CONVERSATION_ID}`);
  });

  test('a conversation:updated hint from the server reloads the list', async () => {
    const api = fakeApi();
    const socket = new FakeSocket();
    api.listConversations.mockResolvedValue(page([conversation()]));
    await renderApp(<ChatListScreen />, { api, socket });
    await screen.findByText('Ahmed');
    expect(screen.getByLabelText('Live updates: Connecting…')).toBeTruthy();
    await act(async () => socket.serverConnect());
    expect(screen.queryByLabelText(/Live updates/)).toBeNull();

    const before = api.listConversations.mock.calls.length;
    api.listConversations.mockResolvedValue(
      page([conversation({ lastMessage: { id: 'm9', senderId: 'user-2', body: 'New reply', createdAt: '2026-11-10T11:00:00Z' }, unreadCount: 1 })]),
    );
    await act(async () => socket.fire('conversation:updated', { conversationId: CONVERSATION_ID }));
    expect(await screen.findByText('New reply')).toBeTruthy();
    expect(api.listConversations.mock.calls.length).toBe(before + 1);
  });
});

describe('conversation screen', () => {
  beforeEach(() => {
    mockParams = { id: CONVERSATION_ID };
  });

  const typeAndSend = async (text: string) => {
    await fireEvent.changeText(screen.getByLabelText('Message'), text);
    await fireEvent.press(screen.getByRole('button', { name: 'Send message' }));
  };

  test('shows the history with both sides, the item and dates, and marks it read', async () => {
    const api = fakeApi();
    api.listMessages.mockResolvedValue({
      items: [chatMessage({ body: 'Sure, 5pm works', senderId: 'user-2' }), chatMessage({ body: 'Can I pick it up at 5?', senderId: 'user-1' })],
      nextCursor: null,
    });
    await renderApp(<ConversationScreen />, { api });
    expect(await screen.findByText('Sure, 5pm works')).toBeTruthy();
    expect(screen.getByText('Can I pick it up at 5?')).toBeTruthy();
    expect(screen.getByText('Ahmed')).toBeTruthy();
    expect(screen.getByText('Bosch power drill · 12 Nov – 14 Nov')).toBeTruthy();
    await waitFor(() => expect(api.markConversationRead).toHaveBeenCalledWith('access-1', CONVERSATION_ID));
  });

  test('an empty conversation invites a first message; blank text cannot be sent', async () => {
    await renderApp(<ConversationScreen />);
    expect(await screen.findByText(/No messages yet/)).toBeTruthy();
    const send = screen.getByRole('button', { name: 'Send message' });
    expect(send.props.accessibilityState.disabled).toBe(true);
    await fireEvent.changeText(screen.getByLabelText('Message'), '   ');
    expect(screen.getByRole('button', { name: 'Send message' }).props.accessibilityState.disabled).toBe(true);
  });

  test('sends over the socket when connected and shows the stored message', async () => {
    const api = fakeApi();
    const socket = new FakeSocket();
    socket.answer = async (event, payload) =>
      event === 'message:send'
        ? { ok: true, duplicate: false, message: chatMessage({ ...payload, senderId: 'user-1', id: 'stored-1' }) }
        : { ok: true, conversation: conversation() };
    await renderApp(<ConversationScreen />, { api, socket });
    await act(async () => socket.serverConnect());
    await screen.findByText(/No messages yet/);

    await typeAndSend('  Hello there  ');
    expect(await screen.findByText('Hello there')).toBeTruthy();
    expect(socket.sent('message:send')).toEqual([{ conversationId: CONVERSATION_ID, clientId: expect.stringMatching(/^client-/), body: 'Hello there' }]);
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Message').props.value).toBe('');
  });

  test('falls back to REST with the same clientId when the socket does not answer', async () => {
    const api = fakeApi();
    const socket = new FakeSocket();
    socket.answer = async (event) => {
      if (event === 'message:send') throw new Error('operation has timed out');
      return { ok: true, conversation: conversation() };
    };
    await renderApp(<ConversationScreen />, { api, socket });
    await act(async () => socket.serverConnect());
    await screen.findByText(/No messages yet/);

    await typeAndSend('Are you home?');
    expect(await screen.findByText('Are you home?')).toBeTruthy();
    const [{ clientId }] = socket.sent('message:send');
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalledWith('access-1', CONVERSATION_ID, { clientId, body: 'Are you home?' }));
  });

  test('a failed send stays visible with a retry that reuses its clientId', async () => {
    const api = fakeApi();
    api.sendMessage.mockRejectedValueOnce(apiError(0, 'NETWORK_ERROR'));
    await renderApp(<ConversationScreen />, { api });
    await screen.findByText(/No messages yet/);

    await typeAndSend('Running late');
    expect(await screen.findByText('Not sent')).toBeTruthy();
    expect(screen.getByText('You are offline. Tap to retry.')).toBeTruthy();
    const firstClientId = api.sendMessage.mock.calls[0][2].clientId;

    await fireEvent.press(screen.getByRole('button', { name: 'Retry sending message' }));
    await waitFor(() => expect(screen.queryByText('Not sent')).toBeNull());
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    expect(api.sendMessage.mock.calls[1][2]).toEqual({ clientId: firstClientId, body: 'Running late' });
    expect(screen.getAllByText('Running late')).toHaveLength(1);
  });

  test('errors that retrying will not fix are shown as such', async () => {
    const api = fakeApi();
    api.sendMessage.mockRejectedValueOnce(apiError(409, 'CHAT_NOT_AVAILABLE'));
    await renderApp(<ConversationScreen />, { api });
    await screen.findByText(/No messages yet/);
    await typeAndSend('Hi');
    expect(await screen.findByText('Chat opens once the owner accepts the borrow request. Tap to retry.')).toBeTruthy();
  });

  test('live messages for this conversation appear once; other conversations are ignored', async () => {
    const api = fakeApi();
    const socket = new FakeSocket();
    await renderApp(<ConversationScreen />, { api, socket });
    await act(async () => socket.serverConnect());
    await screen.findByText(/No messages yet/);
    await waitFor(() => expect(socket.sent('conversation:join')).toEqual([{ conversationId: CONVERSATION_ID }]));

    const incoming = chatMessage({ body: 'Door code is 1234' });
    await act(async () => {
      socket.fire('message:new', { conversationId: CONVERSATION_ID, message: incoming });
      socket.fire('message:new', { conversationId: CONVERSATION_ID, message: incoming });
      socket.fire('message:new', { conversationId: 'another', message: chatMessage({ body: 'Not for this screen' }) });
    });
    expect(await screen.findByText('Door code is 1234')).toBeTruthy();
    expect(screen.getAllByText('Door code is 1234')).toHaveLength(1);
    expect(screen.queryByText('Not for this screen')).toBeNull();
    // A message from the other person is marked read while the chat is open.
    await waitFor(() => expect(api.markConversationRead.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  test('shows the reconnecting state, then rejoins and fetches what was missed', async () => {
    const api = fakeApi();
    const socket = new FakeSocket();
    await renderApp(<ConversationScreen />, { api, socket });
    await act(async () => socket.serverConnect());
    await screen.findByText(/No messages yet/);
    expect(screen.queryByText(/Reconnecting to live chat/)).toBeNull();

    await act(async () => socket.serverDisconnect());
    expect(screen.getByText(/Reconnecting to live chat/)).toBeTruthy();

    api.listMessages.mockResolvedValue({ items: [chatMessage({ body: 'Sent while you were away' })], nextCursor: null });
    await act(async () => socket.serverConnect());
    expect(await screen.findByText('Sent while you were away')).toBeTruthy();
    expect(screen.queryByText(/Reconnecting to live chat/)).toBeNull();
    expect(socket.sent('conversation:join').length).toBe(2);
  });

  test('older messages load on request with the cursor', async () => {
    const api = fakeApi();
    api.listMessages
      .mockResolvedValueOnce({ items: [chatMessage({ body: 'Newest' })], nextCursor: 'cursor-1' })
      .mockResolvedValueOnce({ items: [chatMessage({ body: 'Oldest', createdAt: '2026-11-01T10:00:00Z' })], nextCursor: null });
    await renderApp(<ConversationScreen />, { api });
    await screen.findByText('Newest');
    await fireEvent.press(screen.getByRole('button', { name: 'Load earlier messages' }));
    expect(await screen.findByText('Oldest')).toBeTruthy();
    expect(api.listMessages).toHaveBeenLastCalledWith('access-1', CONVERSATION_ID, { before: 'cursor-1' });
    expect(screen.queryByRole('button', { name: 'Load earlier messages' })).toBeNull();
  });

  test('a conversation the user is not part of is shown as unavailable', async () => {
    const api = fakeApi();
    api.getConversation.mockRejectedValue(apiError(404, 'CONVERSATION_NOT_FOUND'));
    await renderApp(<ConversationScreen />, { api });
    expect(await screen.findByText('Chat not available')).toBeTruthy();
    expect(screen.queryByLabelText('Message')).toBeNull();
  });

  test('a removed listing is explained, and chatting continues', async () => {
    const api = fakeApi();
    api.getConversation.mockResolvedValue({
      conversation: conversation({ listing: { ...conversation().listing, archived: true } }),
    });
    await renderApp(<ConversationScreen />, { api });
    expect(await screen.findByText(/This item is no longer listed/)).toBeTruthy();
    expect(screen.getByLabelText('Message')).toBeTruthy();
  });
});

describe('borrow requests and chat', () => {
  const requests = (items: ReturnType<typeof borrowRequest>[]) => ({
    items,
    pagination: { page: 1, pageSize: 50, total: items.length, totalPages: 1 },
  });

  test('an accepted request has an Open chat action; pending ones do not', async () => {
    const api = fakeApi();
    api.listOutgoingRequests.mockResolvedValue(
      requests([
        borrowRequest({ status: 'accepted', decidedAt: '2026-11-10T09:00:00Z' }),
        borrowRequest({ id: '77777777-7777-4777-8777-777777777777', listing: { ...borrowRequest().listing, title: 'Ladder' } }),
      ]),
    );
    await renderApp(<BorrowRequestsScreen />, { api });
    await fireEvent.press(await screen.findByRole('button', { name: 'Open chat about Bosch power drill' }));
    await waitFor(() => expect(mockRouter.push).toHaveBeenCalledWith(`/chat/${CONVERSATION_ID}`));
    expect(api.openConversation).toHaveBeenCalledWith('access-1', borrowRequest().id);
    expect(screen.queryByRole('button', { name: 'Open chat about Ladder' })).toBeNull();
  });

  test('if the chat cannot be opened, the card says why', async () => {
    const api = fakeApi();
    api.listOutgoingRequests.mockResolvedValue(requests([borrowRequest({ status: 'accepted', decidedAt: '2026-11-10T09:00:00Z' })]));
    api.openConversation.mockRejectedValue(apiError(0, 'NETWORK_ERROR'));
    await renderApp(<BorrowRequestsScreen />, { api });
    await fireEvent.press(await screen.findByRole('button', { name: 'Open chat about Bosch power drill' }));
    expect(await screen.findByText('Could not reach NeighborShare. Check your connection and try again.')).toBeTruthy();
    expect(mockRouter.push).not.toHaveBeenCalled();
  });

  test('after accepting, the lender goes straight to the conversation', async () => {
    mockParams = { tab: 'lending' };
    const api = fakeApi();
    const incoming = borrowRequest({ viewerRole: 'lender' });
    api.listIncomingRequests.mockResolvedValue(requests([incoming]));
    api.decideBorrowRequest.mockResolvedValue({ request: { ...incoming, status: 'accepted', decidedAt: '2026-11-10T09:00:00Z' } });
    await renderApp(<BorrowRequestsScreen />, { api });
    await fireEvent.press(await screen.findByRole('button', { name: 'Accept request for Bosch power drill' }));

    await waitFor(() => expect(mockRouter.push).toHaveBeenCalledWith(`/chat/${CONVERSATION_ID}`));
    expect(api.decideBorrowRequest).toHaveBeenCalledWith('access-1', incoming.id, 'accept');
    expect(api.openConversation).toHaveBeenCalledWith('access-1', incoming.id);
    // Accepted first, conversation second.
    expect(api.decideBorrowRequest.mock.invocationCallOrder[0]).toBeLessThan(api.openConversation.mock.invocationCallOrder[0]);
  });

  test('if opening the chat fails after accepting, the request stays accepted and the lender is told where to find it', async () => {
    mockParams = { tab: 'lending' };
    const api = fakeApi();
    const incoming = borrowRequest({ viewerRole: 'lender' });
    api.listIncomingRequests
      .mockResolvedValueOnce(requests([incoming]))
      .mockResolvedValue(requests([{ ...incoming, status: 'accepted', decidedAt: '2026-11-10T09:00:00Z' }]));
    api.openConversation.mockRejectedValue(apiError(503, 'DATABASE_UNAVAILABLE'));
    await renderApp(<BorrowRequestsScreen />, { api });
    await fireEvent.press(await screen.findByRole('button', { name: 'Accept request for Bosch power drill' }));

    await waitFor(() =>
      expect(Toast.show).toHaveBeenCalledWith(expect.objectContaining({ type: 'info', text1: 'Request accepted', text2: expect.stringMatching(/Chat tab/) })),
    );
    expect(mockRouter.push).not.toHaveBeenCalled();
    expect(await screen.findByText('These dates are reserved for Sara.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open chat about Bosch power drill' })).toBeTruthy();
  });
});

describe('chat connection', () => {
  const make = (overrides: Partial<ConstructorParameters<typeof ChatConnection>[0]> = {}) => {
    const socket = new FakeSocket();
    let auth: ((cb: (d: { token?: string }) => void) => void) | undefined;
    const refreshSession = jest.fn(async () => undefined);
    const connection = new ChatConnection({
      url: 'http://api.test',
      createSocket: (_url, options) => {
        auth = options.auth;
        return socket;
      },
      getAccessToken: async () => 'token-1',
      refreshSession,
      setTimer: (fn) => fn(),
      ...overrides,
    });
    connection.start();
    return { socket, connection, refreshSession, auth: () => auth! };
  };

  test('sends the current access token with every connection attempt', async () => {
    const { auth } = make();
    const token = await new Promise((resolve) => auth()(resolve));
    expect(token).toEqual({ token: 'token-1' });
  });

  test('a rejected token refreshes the session and reconnects once; a second rejection goes offline', async () => {
    const { socket, connection, refreshSession } = make();
    expect(socket.connectCalls).toBe(1);
    socket.fire('connect_error', { data: { code: 'INVALID_TOKEN' } });
    await waitFor(() => expect(socket.connectCalls).toBe(2));
    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(connection.state).toBe('connecting');
    socket.fire('connect_error', { data: { code: 'INVALID_TOKEN' } });
    expect(connection.state).toBe('offline');
    expect(socket.connectCalls).toBe(2);
  });

  test('when the server ends the connection (token expired), it reconnects', () => {
    const { socket, connection } = make();
    socket.serverConnect();
    expect(connection.state).toBe('connected');
    socket.serverDisconnect('io server disconnect');
    expect(connection.state).toBe('connecting');
    expect(socket.connectCalls).toBe(2);
  });

  test('server-side errors become ApiErrors; sending while disconnected is a network error', async () => {
    const { socket, connection } = make();
    await expect(connection.send('c1', { clientId: 'x', body: 'hi' })).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    socket.serverConnect();
    socket.answer = async () => ({ ok: false, error: { code: 'RATE_LIMITED', message: 'slow down', retryAfterSeconds: 30 } });
    await expect(connection.send('c1', { clientId: 'x', body: 'hi' })).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      status: 429,
      retryAfterSeconds: 30,
    });
  });

  test('rooms are rejoined after reconnecting and left when the last listener leaves', async () => {
    const { socket, connection } = make();
    socket.serverConnect();
    await connection.join('c1');
    await connection.join('c1');
    socket.serverDisconnect();
    socket.serverConnect();
    await waitFor(() => expect(socket.sent('conversation:join')).toHaveLength(3));
    connection.leave('c1');
    expect(socket.sent('conversation:leave')).toHaveLength(0);
    connection.leave('c1');
    await waitFor(() => expect(socket.sent('conversation:leave')).toEqual([{ conversationId: 'c1' }]));
  });
});
