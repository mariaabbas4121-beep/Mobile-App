import React, { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { ApiClient } from '../lib/api/client';
import type { ChatMessage, Conversation, ConversationPage, MessagePage } from '../lib/api/types';
import type { SessionManager } from '../lib/auth/sessionManager';
import { ChatConnection, isTransportError, type ConnectionState, type SocketFactory } from '../lib/chat/connection';

export interface ChatServices {
  api: ApiClient;
  sessionManager: SessionManager;
  // Null: no live connection (REST only), e.g. when no API URL is set.
  socket: { url: string; create: SocketFactory } | null;
  // Client message ids (UUID v4): the idempotency key for sends.
  newId: () => string;
}

export interface ChatContextValue {
  connection: ConnectionState;
  // Bumped when the server says a conversation has new activity, and after
  // this device sends, so conversation lists reload.
  revision: number;
  // Bumped when the server says a borrow request's pickup changed (on either
  // participant's device), so request and activity screens reload.
  handoverRevision: number;
  // Same, for this device's own changes (the server does not echo them
  // reliably when the socket is down).
  handoverChanged: () => void;
  // Total unread messages, as of the last conversation list load.
  unreadTotal: number;
  listConversations: () => Promise<ConversationPage>;
  // Get-or-create for an accepted borrow request.
  openForRequest: (borrowRequestId: string) => Promise<Conversation>;
  getConversation: (id: string) => Promise<Conversation>;
  loadMessages: (id: string, before?: string) => Promise<MessagePage>;
  // Over the socket when connected, otherwise (or if that fails in transit)
  // over REST with the same clientId, so a message is never stored twice.
  send: (conversationId: string, clientId: string, body: string) => Promise<ChatMessage>;
  markRead: (id: string) => Promise<void>;
  // Live messages for one conversation while subscribed (joins its room).
  subscribe: (conversationId: string, listener: (message: ChatMessage) => void) => () => void;
  newClientId: () => string;
}

const ChatContext = createContext<ChatContextValue | null>(null);

function defaultServices(): ChatServices {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { api, sessionManager } = require('../lib/auth') as typeof import('../lib/auth');
  const { config } = require('../lib/config') as typeof import('../lib/config');
  const { io } = require('socket.io-client') as typeof import('socket.io-client');
  const { randomUUID } = require('expo-crypto') as typeof import('expo-crypto');
  /* eslint-enable @typescript-eslint/no-require-imports */
  return {
    api,
    sessionManager,
    socket: config.apiUrl
      ? {
          url: config.apiUrl,
          // WebSocket only: long-polling is unreliable on React Native.
          create: (url, { auth }) =>
            io(url, { transports: ['websocket'], autoConnect: false, auth, reconnectionDelayMax: 10_000 }),
        }
      : null,
    newId: randomUUID,
  };
}

export function ChatProvider({ children, services }: { children: ReactNode; services?: ChatServices }) {
  const [{ api, sessionManager, socket, newId }] = useState<ChatServices>(() => services ?? defaultServices());
  const [connection] = useState(() =>
    socket
      ? new ChatConnection({
          url: socket.url,
          createSocket: socket.create,
          getAccessToken: () => sessionManager.getAccessToken(),
          refreshSession: () => sessionManager.refresh(),
        })
      : null,
  );
  const [state, setState] = useState<ConnectionState>('offline');
  const [revision, setRevision] = useState(0);
  const [unreadTotal, setUnreadTotal] = useState(0);
  const changed = useCallback(() => setRevision((r) => r + 1), []);
  const [handoverRevision, setHandoverRevision] = useState(0);
  const handoverChanged = useCallback(() => setHandoverRevision((r) => r + 1), []);

  // Connected while signed in, disconnected otherwise.
  useEffect(() => {
    if (!connection) return;
    const offState = connection.onState(setState);
    const offUpdates = connection.onConversationUpdated(changed);
    const offHandovers = connection.onHandoverUpdated(handoverChanged);
    const sync = () => (sessionManager.current ? connection.start() : connection.stop());
    sync();
    const offSession = sessionManager.subscribe(sync);
    return () => {
      offState();
      offUpdates();
      offHandovers();
      offSession();
      connection.stop();
    };
  }, [connection, sessionManager, changed, handoverChanged]);

  const listConversations = useCallback(async () => {
    const page = await sessionManager.authorized((t) => api.listConversations(t, { pageSize: 50 }));
    setUnreadTotal(page.items.reduce((n, c) => n + c.unreadCount, 0));
    return page;
  }, [api, sessionManager]);

  const openForRequest = useCallback(
    async (borrowRequestId: string) => (await sessionManager.authorized((t) => api.openConversation(t, borrowRequestId))).conversation,
    [api, sessionManager],
  );

  const getConversation = useCallback(
    async (id: string) => (await sessionManager.authorized((t) => api.getConversation(t, id))).conversation,
    [api, sessionManager],
  );

  const loadMessages = useCallback(
    (id: string, before?: string) => sessionManager.authorized((t) => api.listMessages(t, id, before ? { before } : {})),
    [api, sessionManager],
  );

  const send = useCallback(
    async (conversationId: string, clientId: string, body: string) => {
      let message: ChatMessage | null = null;
      if (connection?.state === 'connected') {
        try {
          message = (await connection.send(conversationId, { clientId, body })).message;
        } catch (err) {
          // Not delivered in transit: the REST retry below is safe because
          // the server stores each clientId once.
          if (!isTransportError(err)) throw err;
        }
      }
      message ??= (await sessionManager.authorized((t) => api.sendMessage(t, conversationId, { clientId, body }))).message;
      changed();
      return message;
    },
    [api, sessionManager, connection, changed],
  );

  const markRead = useCallback(
    async (id: string) => {
      await sessionManager.authorized((t) => api.markConversationRead(t, id));
      changed();
    },
    [api, sessionManager, changed],
  );

  const subscribe = useCallback(
    (conversationId: string, listener: (message: ChatMessage) => void) => {
      if (!connection) return () => undefined;
      const off = connection.onMessage((id, message) => {
        if (id === conversationId) listener(message);
      });
      void connection.join(conversationId).catch(() => undefined);
      return () => {
        off();
        connection.leave(conversationId);
      };
    },
    [connection],
  );

  const value = useMemo<ChatContextValue>(
    () => ({
      connection: state,
      revision,
      handoverRevision,
      handoverChanged,
      unreadTotal,
      listConversations,
      openForRequest,
      getConversation,
      loadMessages,
      send,
      markRead,
      subscribe,
      newClientId: newId,
    }),
    [state, revision, handoverRevision, handoverChanged, unreadTotal, listConversations, openForRequest, getConversation, loadMessages, send, markRead, subscribe, newId],
  );

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

export function useChat(): ChatContextValue {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error('useChat must be used within ChatProvider');
  return ctx;
}
