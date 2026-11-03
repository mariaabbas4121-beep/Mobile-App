import type { ProfileRepository } from '../auth/auth.types.js';
import type { Logger } from '../lib/logger.js';
import { AppError } from '../lib/errors.js';
import { assertAccountStatus } from '../middleware/account-status.middleware.js';
import { DEFAULT_RATE_LIMITS, type LimitRule } from '../middleware/rate-limit.middleware.js';
import type { Caller } from '../listings/listing.types.js';
import { encodeCursor, sendMessageBody } from './chat.schemas.js';
import { unconfiguredChat } from './supabase-chat.repository.js';
import type { ChatMessage, ChatRepository, Conversation, MessageCreatedEvent, MessageCursor } from './chat.types.js';
import { formatIssues } from '../middleware/validate.middleware.js';

const conversationNotFound = () => AppError.notFound('Conversation not found', 'CONVERSATION_NOT_FOUND');

// Fan-out of stored messages to live connections (the Socket.IO server).
// In-process: running several API instances would need a shared bus
// (e.g. the Socket.IO Redis adapter).
export interface ChatEvents {
  publish(event: MessageCreatedEvent): void;
  subscribe(listener: (event: MessageCreatedEvent) => void): () => void;
}

export function createChatEvents(logger: Logger): ChatEvents {
  const listeners = new Set<(event: MessageCreatedEvent) => void>();
  return {
    publish(event) {
      for (const listener of listeners) {
        try {
          listener(event);
        } catch (err) {
          // A failed broadcast never fails the send: the message is stored.
          logger.error({ err }, 'chat event listener failed');
        }
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

// Fixed-window counter per user, shared by the REST and socket send paths so
// switching transport does not reset it. Per process, like the HTTP limits.
export function createSendLimiter(rule: LimitRule, now: () => number = Date.now) {
  const windows = new Map<string, { start: number; count: number }>();
  return (userId: string) => {
    const t = now();
    let w = windows.get(userId);
    if (!w || t - w.start >= rule.windowMs) {
      w = { start: t, count: 0 };
      windows.set(userId, w);
      // Keep the map from growing without bound.
      if (windows.size > 10_000) {
        for (const [k, v] of windows) if (t - v.start >= rule.windowMs) windows.delete(k);
      }
    }
    w.count += 1;
    if (w.count > rule.limit) throw AppError.rateLimited('You are sending messages too quickly', (w.start + rule.windowMs - t) / 1000);
  };
}

export interface ChatServiceDeps {
  repository: ChatRepository;
  profiles: ProfileRepository;
  events: ChatEvents;
  sendLimit: LimitRule;
  now?: () => number;
}

export interface MessagePage {
  // Newest first.
  items: ChatMessage[];
  // Pass as `before` for the next (older) page; null when there is none.
  nextCursor: string | null;
}

export interface SendOutcome {
  message: ChatMessage;
  // True when this was a retry of a message already stored.
  duplicate: boolean;
}

// The single path for chat reads and writes, used by both the REST routes
// and the socket server, so both apply identical rules. The database checks
// participation and request status again on every call.
export function createChatService({ repository, profiles, events, sendLimit, now = Date.now }: ChatServiceDeps) {
  const checkRate = createSendLimiter(sendLimit, now);

  async function get(caller: Caller, id: string): Promise<Conversation> {
    const conversation = await repository.get(caller, id);
    if (!conversation) throw conversationNotFound();
    return conversation;
  }

  return {
    list: (caller: Caller, query: { page: number; pageSize: number }) => repository.list(caller, query),

    get,

    // Idempotent: the same request always gives the same conversation.
    async openForRequest(caller: Caller, borrowRequestId: string): Promise<Conversation> {
      const id = await repository.open(caller, borrowRequestId);
      if (!id) throw AppError.notFound('Borrow request not found', 'BORROW_REQUEST_NOT_FOUND');
      const conversation = await repository.get(caller, id);
      if (!conversation) throw conversationNotFound();
      return conversation;
    },

    async history(caller: Caller, id: string, query: { before: MessageCursor | null; limit: number }): Promise<MessagePage> {
      // Distinguishes "not yours" (404) from "no messages yet".
      if (!(await repository.get(caller, id))) throw conversationNotFound();
      const rows = await repository.messages(caller, id, { before: query.before, limit: query.limit + 1 });
      const items = rows.slice(0, query.limit);
      const last = items[items.length - 1];
      return { items, nextCursor: rows.length > query.limit && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null };
    },

    // Validates, stores, then publishes. Publishing happens only for a newly
    // stored message, so a retried send is never delivered twice.
    async send(caller: Caller, conversationId: string, raw: unknown): Promise<SendOutcome> {
      const parsed = sendMessageBody.safeParse(raw ?? {});
      if (!parsed.success) throw AppError.badRequest('VALIDATION_ERROR', 'Request validation failed', formatIssues(parsed.error));
      checkRate(caller.userId);
      // Read from the database on every send, so a suspension applies at once.
      assertAccountStatus(await profiles.getProfile(caller.accessToken, caller.userId), ['active', 'restricted']);

      const result = await repository.send(caller, conversationId, parsed.data);
      if (result.created) {
        events.publish({ conversationId, message: result.message, participantIds: result.participantIds });
      }
      return { message: result.message, duplicate: !result.created };
    },

    async markRead(caller: Caller, id: string): Promise<Conversation> {
      if (!(await repository.markRead(caller, id))) throw conversationNotFound();
      return get(caller, id);
    },
  };
}

export type ChatService = ReturnType<typeof createChatService>;

export function unconfiguredChatService(profiles: ProfileRepository, logger: Logger): ChatService {
  return createChatService({
    repository: unconfiguredChat(),
    profiles,
    events: createChatEvents(logger),
    sendLimit: DEFAULT_RATE_LIMITS.chatMessagePerUser,
  });
}
