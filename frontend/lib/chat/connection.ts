import { ApiError } from '../api/client';
import type { ChatMessage, Conversation } from '../api/types';

// The live chat connection (Socket.IO). It only carries messages faster; the
// REST API stays the source of truth, so anything missed while disconnected
// is fetched again after reconnecting. Event contract: backend/docs/API.md.

export type ConnectionState = 'connecting' | 'connected' | 'offline';

// How long to wait for the server to acknowledge an event.
export const ACK_TIMEOUT_MS = 10_000;
// After the server refuses the token for a reason other than the token
// (e.g. Supabase Auth briefly unavailable), try again after this long.
const RETRY_AFTER_REFUSAL_MS = 5_000;

type AckResponse<T> = ({ ok: true } & T) | { ok: false; error: { code: string; message: string; details?: unknown; retryAfterSeconds?: number } };

// The parts of socket.io-client's Socket used here, so tests can pass a fake.
export interface SocketLike {
  connected: boolean;
  connect(): unknown;
  disconnect(): unknown;
  on(event: string, listener: (...args: any[]) => void): unknown;
  off(event: string, listener?: (...args: any[]) => void): unknown;
  timeout(ms: number): { emitWithAck(event: string, payload: unknown): Promise<any> };
}

// Socket.IO calls `auth` before every (re)connection, so each attempt sends
// the current access token.
export type SocketFactory = (url: string, options: { auth: (cb: (data: { token?: string }) => void) => void }) => SocketLike;

export interface ChatConnectionOptions {
  url: string;
  createSocket: SocketFactory;
  getAccessToken: () => Promise<string>;
  // Called when the server rejects the token; should refresh the session.
  refreshSession: () => Promise<unknown>;
  setTimer?: (fn: () => void, ms: number) => unknown;
}

const STATUS: Record<string, number> = {
  VALIDATION_ERROR: 400,
  INVALID_MESSAGE: 400,
  UNAUTHENTICATED: 401,
  INVALID_TOKEN: 401,
  FORBIDDEN: 403,
  ACCOUNT_SUSPENDED: 403,
  ACCOUNT_DELETION_PENDING: 403,
  CONVERSATION_NOT_FOUND: 404,
  CHAT_NOT_AVAILABLE: 409,
  CLIENT_ID_REUSED: 409,
  RATE_LIMITED: 429,
};

// Errors that say nothing about the message itself: the same send may
// succeed over REST.
export const isTransportError = (err: unknown) =>
  err instanceof ApiError && ['NETWORK_ERROR', 'TIMEOUT', 'INVALID_TOKEN', 'UNAUTHENTICATED', 'INTERNAL_ERROR'].includes(err.code);

export class ChatConnection {
  private socket: SocketLike | null = null;
  private stateValue: ConnectionState = 'offline';
  private readonly stateListeners = new Set<(state: ConnectionState) => void>();
  private readonly messageListeners = new Set<(conversationId: string, message: ChatMessage) => void>();
  private readonly updateListeners = new Set<(conversationId: string) => void>();
  private readonly handoverListeners = new Set<(borrowRequestId: string) => void>();
  // Rooms to (re)join on every connect.
  private readonly rooms = new Map<string, number>();
  private refreshedAfterRefusal = false;

  constructor(private readonly options: ChatConnectionOptions) {}

  get state(): ConnectionState {
    return this.stateValue;
  }

  private setState(next: ConnectionState) {
    if (next === this.stateValue) return;
    this.stateValue = next;
    for (const l of this.stateListeners) l(next);
  }

  onState(listener: (state: ConnectionState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  onMessage(listener: (conversationId: string, message: ChatMessage) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  // Content-free hint that a conversation has new activity.
  onConversationUpdated(listener: (conversationId: string) => void): () => void {
    this.updateListeners.add(listener);
    return () => this.updateListeners.delete(listener);
  }

  // Content-free hint that a borrow request's pickup state changed.
  onHandoverUpdated(listener: (borrowRequestId: string) => void): () => void {
    this.handoverListeners.add(listener);
    return () => this.handoverListeners.delete(listener);
  }

  start(): void {
    if (this.socket) return;
    const { url, createSocket, getAccessToken } = this.options;
    const socket = createSocket(url, {
      auth: (cb) => {
        getAccessToken().then(
          (token) => cb({ token }),
          // Signed out: connect without a token; the server refuses it.
          () => cb({}),
        );
      },
    });
    this.socket = socket;
    this.setState('connecting');

    socket.on('connect', () => {
      this.refreshedAfterRefusal = false;
      this.setState('connected');
      for (const id of this.rooms.keys()) void this.emitJoin(id).catch(() => undefined);
    });
    socket.on('disconnect', (reason: string) => {
      if (this.socket !== socket) return;
      this.setState('connecting');
      // The server ended the connection (e.g. the token expired). Socket.IO
      // does not retry this on its own; `auth` supplies a fresh token.
      if (reason === 'io server disconnect') socket.connect();
    });
    socket.on('connect_error', (err: { data?: { code?: string } }) => {
      if (this.socket !== socket) return;
      const code = err?.data?.code;
      // No code: a transport failure, which Socket.IO retries by itself.
      if (!code) {
        this.setState('connecting');
        return;
      }
      // Refused by the server, which Socket.IO does not retry.
      if ((code === 'INVALID_TOKEN' || code === 'UNAUTHENTICATED') && !this.refreshedAfterRefusal) {
        this.refreshedAfterRefusal = true;
        this.setState('connecting');
        this.options.refreshSession().then(
          () => this.socket === socket && socket.connect(),
          () => this.socket === socket && this.setState('offline'),
        );
        return;
      }
      if (code === 'INVALID_TOKEN' || code === 'UNAUTHENTICATED') {
        this.setState('offline');
        return;
      }
      this.setState('connecting');
      (this.options.setTimer ?? setTimeout)(() => this.socket === socket && socket.connect(), RETRY_AFTER_REFUSAL_MS);
    });
    socket.on('message:new', (payload: { conversationId: string; message: ChatMessage }) => {
      for (const l of this.messageListeners) l(payload.conversationId, payload.message);
    });
    socket.on('conversation:updated', (payload: { conversationId: string }) => {
      for (const l of this.updateListeners) l(payload.conversationId);
    });
    socket.on('handover:updated', (payload: { borrowRequestId: string }) => {
      for (const l of this.handoverListeners) l(payload.borrowRequestId);
    });
    socket.connect();
  }

  stop(): void {
    const socket = this.socket;
    this.socket = null;
    this.rooms.clear();
    socket?.disconnect();
    this.setState('offline');
  }

  // Joins a conversation room (the server checks membership). Stays joined
  // across reconnects until every caller has left.
  async join(conversationId: string): Promise<Conversation | null> {
    this.rooms.set(conversationId, (this.rooms.get(conversationId) ?? 0) + 1);
    if (!this.socket?.connected) return null;
    return this.emitJoin(conversationId);
  }

  leave(conversationId: string): void {
    const n = (this.rooms.get(conversationId) ?? 0) - 1;
    if (n > 0) {
      this.rooms.set(conversationId, n);
      return;
    }
    this.rooms.delete(conversationId);
    if (this.socket?.connected) void this.call('conversation:leave', { conversationId }).catch(() => undefined);
  }

  private async emitJoin(conversationId: string): Promise<Conversation> {
    const { conversation } = await this.call<{ conversation: Conversation }>('conversation:join', { conversationId });
    return conversation;
  }

  // Throws ApiError; NETWORK_ERROR when not connected, TIMEOUT when the
  // server does not answer in time.
  send(conversationId: string, input: { clientId: string; body: string }): Promise<{ message: ChatMessage; duplicate: boolean }> {
    return this.call('message:send', { conversationId, ...input });
  }

  private async call<T>(event: string, payload: unknown): Promise<T> {
    const socket = this.socket;
    if (!socket?.connected) throw new ApiError(0, 'NETWORK_ERROR', 'Not connected to chat.');
    let response: AckResponse<T>;
    try {
      response = await socket.timeout(ACK_TIMEOUT_MS).emitWithAck(event, payload);
    } catch {
      throw new ApiError(0, 'TIMEOUT', 'The chat server did not answer in time.');
    }
    if (response.ok) {
      const { ok: _ok, ...data } = response;
      return data as unknown as T;
    }
    const { code, message, details, retryAfterSeconds } = response.error;
    throw new ApiError(STATUS[code] ?? 400, code, message, {
      ...(details !== undefined ? { details } : {}),
      ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
    });
  }
}
