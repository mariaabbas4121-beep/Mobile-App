import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import { z } from 'zod';
import type { AuthGateway } from '../auth/auth.types.js';
import type { Config } from '../config/env.js';
import type { Logger } from '../lib/logger.js';
import { AppError } from '../lib/errors.js';
import { formatIssues } from '../middleware/validate.middleware.js';
import type { Caller } from '../listings/listing.types.js';
import type { ChatEvents, ChatService } from '../chat/chat.service.js';
import type { ChatMessage, Conversation } from '../chat/chat.types.js';
import type { HandoverEvents } from '../handover/handover.service.js';

// Real-time chat over Socket.IO, attached to the API's own HTTP server (same
// port, path /socket.io). The event contract is documented in docs/API.md.
//
// Rules, identical to the REST endpoints because both go through ChatService:
//   * The connection must present a valid Supabase access token, checked with
//     the Auth server exactly like requireAuth. The user id comes only from it.
//   * A socket joins a conversation room only after the database confirms the
//     user is a participant. Message content is only sent to those rooms.
//   * Every send is authorized again (participant, accepted request, account
//     status) and stored before it is broadcast.

export const conversationRoom = (id: string) => `conversation:${id}`;
const userRoom = (id: string) => `user:${id}`;

// Same shape check as the Authorization header (three base64url segments).
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const MAX_TOKEN_LENGTH = 8192;
const MAX_ROOMS_PER_SOCKET = 50;
// Per-socket ceiling on all events, on top of the per-user send limit.
const EVENTS_PER_MINUTE = 120;
// setTimeout cannot wait longer than this.
const MAX_TIMER_MS = 2 ** 31 - 1;

export interface AckError {
  code: string;
  message: string;
  details?: unknown;
  retryAfterSeconds?: number;
}
export type Ack<T> = (response: ({ ok: true } & T) | { ok: false; error: AckError }) => void;

export interface ClientToServerEvents {
  'conversation:join': (payload: { conversationId: string }, ack?: Ack<{ conversation: Conversation }>) => void;
  'conversation:leave': (payload: { conversationId: string }, ack?: Ack<object>) => void;
  'message:send': (
    payload: { conversationId: string; clientId: string; body: string },
    ack?: Ack<{ message: ChatMessage; duplicate: boolean }>,
  ) => void;
}

export interface ServerToClientEvents {
  // A stored message, to everyone in the conversation room (the sender too).
  'message:new': (payload: { conversationId: string; message: ChatMessage }) => void;
  // Sent only when message:send was emitted without an acknowledgement callback.
  'message:error': (payload: { conversationId: string | null; clientId: string | null; error: AckError }) => void;
  // Content-free hint to the two participants' own sockets: reload the list.
  'conversation:updated': (payload: { conversationId: string }) => void;
  // Content-free hint to a borrow request's two participants: its pickup
  // state changed (authorization created/revoked, handover confirmed, photo
  // added). Clients reload GET /borrow-requests/:id/handover.
  'handover:updated': (payload: { borrowRequestId: string }) => void;
  // The same, for its return or due date (return initiated, return code
  // created/revoked, receipt confirmed, photo added, extension requested or
  // decided). Clients reload GET /borrow-requests/:id/return.
  'return:updated': (payload: { borrowRequestId: string }) => void;
  // The access token expired; the socket is about to be disconnected.
  // Reconnect with a fresh token.
  'session:expired': () => void;
}

interface SocketData {
  userId: string;
  accessToken: string;
}

type ChatSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

const conversationPayload = z.object({ conversationId: z.uuid({ error: 'must be a valid id' }) });
const sendPayload = z.object({ conversationId: z.uuid({ error: 'must be a valid id' }) }).loose();

export interface ChatSocketDeps {
  config: Pick<Config, 'corsOrigins'>;
  logger: Logger;
  gateway: AuthGateway;
  chat: ChatService;
  events: ChatEvents;
  handoverEvents?: HandoverEvents;
  returnEvents?: HandoverEvents;
  now?: () => number;
}

// Unix seconds from a token Supabase has already validated. Only used to
// schedule a disconnect; never trusted for identity.
export function tokenExpiry(token: string): number | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { exp?: unknown };
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch {
    return null;
  }
}

function connectError(code: string, message: string) {
  // socket.io-client receives this as connect_error with err.message and err.data.
  return Object.assign(new Error(message), { data: { code } });
}

export function attachChatSocket(
  httpServer: HttpServer,
  { config, logger, gateway, chat, events, handoverEvents, returnEvents, now = Date.now }: ChatSocketDeps,
) {
  const io = new Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>(httpServer, {
    serveClient: false,
    // Browsers (Expo web) need CORS; native apps send no Origin header.
    cors: { origin: config.corsOrigins, methods: ['GET', 'POST'] },
    // A 2000-character message is at most 8 KB of UTF-8.
    maxHttpBufferSize: 16 * 1024,
    connectTimeout: 10_000,
  });

  const toAckError = (err: unknown): AckError => {
    if (err instanceof AppError) {
      return {
        code: err.code,
        message: err.message,
        ...(err.details !== undefined ? { details: err.details } : {}),
        ...(err.retryAfterSeconds !== undefined ? { retryAfterSeconds: Math.max(1, Math.ceil(err.retryAfterSeconds)) } : {}),
      };
    }
    logger.error({ err }, 'chat socket event failed');
    return { code: 'INTERNAL_ERROR', message: 'Internal server error' };
  };

  const parse = <S extends z.ZodType>(schema: S, value: unknown): z.infer<S> => {
    const result = schema.safeParse(value ?? {});
    if (!result.success) throw AppError.badRequest('VALIDATION_ERROR', 'Request validation failed', formatIssues(result.error));
    return result.data;
  };

  io.use(async (socket, next) => {
    const token: unknown = socket.handshake.auth?.token;
    if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH || !JWT.test(token)) {
      next(connectError('UNAUTHENTICATED', 'Authentication required'));
      return;
    }
    try {
      const { user } = await gateway.getUser(token);
      socket.data.userId = user.id;
      socket.data.accessToken = token;
      next();
    } catch (err) {
      const e = err instanceof AppError ? err : AppError.unauthenticated('Access token is invalid or expired', 'INVALID_TOKEN');
      next(connectError(e.code, e.message));
    }
  });

  io.on('connection', (socket: ChatSocket) => {
    const caller = (): Caller => ({ userId: socket.data.userId, accessToken: socket.data.accessToken });
    // For conversation:updated hints; never carries message content.
    void socket.join(userRoom(socket.data.userId));

    // Disconnect when the token expires, so a socket never acts on a stale
    // session; the client reconnects with a fresh token.
    const exp = tokenExpiry(socket.data.accessToken);
    const expiryTimer =
      exp === null
        ? null
        : setTimeout(
            () => {
              socket.emit('session:expired');
              socket.disconnect(true);
            },
            Math.min(Math.max(0, exp * 1000 - now()), MAX_TIMER_MS),
          );
    expiryTimer?.unref();

    let window = { start: now(), count: 0 };
    const checkRate = () => {
      const t = now();
      if (t - window.start >= 60_000) window = { start: t, count: 0 };
      if (++window.count > EVENTS_PER_MINUTE) {
        throw AppError.rateLimited('Too many requests, please slow down', (window.start + 60_000 - t) / 1000);
      }
    };

    // Runs a handler and always answers: through the acknowledgement when
    // the client asked for one, otherwise not at all (or message:error).
    const handle =
      <P, T extends object>(work: (payload: P) => Promise<T>, onUnacked?: (payload: P, error: AckError) => void) =>
      async (payload: P, ack?: Ack<T>) => {
        const reply = typeof ack === 'function' ? ack : null;
        try {
          checkRate();
          const result = await work(payload);
          reply?.({ ok: true, ...result });
        } catch (err) {
          const error = toAckError(err);
          if (reply) reply({ ok: false, error });
          else onUnacked?.(payload, error);
        }
      };

    socket.on(
      'conversation:join',
      handle(async (payload: unknown) => {
        const { conversationId } = parse(conversationPayload, payload);
        // Rooms include the socket's own id and its user room.
        if (!socket.rooms.has(conversationRoom(conversationId)) && socket.rooms.size - 2 >= MAX_ROOMS_PER_SOCKET) {
          throw AppError.badRequest('TOO_MANY_CONVERSATIONS', 'Leave a conversation before joining another');
        }
        // Authorization: throws CONVERSATION_NOT_FOUND unless a participant.
        const conversation = await chat.get(caller(), conversationId);
        await socket.join(conversationRoom(conversationId));
        return { conversation };
      }),
    );

    socket.on(
      'conversation:leave',
      handle(async (payload: unknown) => {
        const { conversationId } = parse(conversationPayload, payload);
        await socket.leave(conversationRoom(conversationId));
        return {};
      }),
    );

    socket.on(
      'message:send',
      handle(
        async (payload: unknown) => {
          const { conversationId, ...input } = parse(sendPayload, payload);
          // Stores first; the broadcast happens through `events` below.
          return chat.send(caller(), conversationId, input);
        },
        (payload, error) => {
          const p = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<string, unknown>;
          socket.emit('message:error', {
            conversationId: typeof p.conversationId === 'string' ? p.conversationId : null,
            clientId: typeof p.clientId === 'string' ? p.clientId : null,
            error,
          });
        },
      ),
    );

    socket.on('disconnect', () => {
      if (expiryTimer) clearTimeout(expiryTimer);
    });
  });

  // Every newly stored message, from either transport.
  const unsubscribe = events.subscribe(({ conversationId, message, participantIds }) => {
    io.to(conversationRoom(conversationId)).emit('message:new', { conversationId, message });
    io.to(participantIds.map(userRoom)).emit('conversation:updated', { conversationId });
  });
  // Every stored handover change. Participants come from the database.
  const unsubscribeHandovers = handoverEvents?.subscribe(({ borrowRequestId, participantIds }) => {
    io.to(participantIds.map(userRoom)).emit('handover:updated', { borrowRequestId });
  });
  const unsubscribeReturns = returnEvents?.subscribe(({ borrowRequestId, participantIds }) => {
    io.to(participantIds.map(userRoom)).emit('return:updated', { borrowRequestId });
  });

  return {
    io,
    // Disconnects every socket and closes the HTTP server too.
    close(): Promise<void> {
      unsubscribe();
      unsubscribeHandovers?.();
      unsubscribeReturns?.();
      return new Promise((resolve) => {
        void io.close(() => resolve());
      });
    },
  };
}
