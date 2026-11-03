import type { SupabaseClient } from '@supabase/supabase-js';
import type { SupabaseClients } from '../config/supabase.js';
import type { Logger } from '../lib/logger.js';
import { AppError } from '../lib/errors.js';
import { timed } from '../lib/timing.js';
import type { BorrowRole, BorrowStatus } from '../borrow/borrow.types.js';
import { LISTING_IMAGES_BUCKET, SIGNED_URL_TTL_SECONDS } from '../listings/supabase-listing.repository.js';
import type { ChatMessage, ChatRepository, Conversation } from './chat.types.js';

// One element of list_conversations' "items".
interface ConversationRow {
  id: string;
  borrow_request_id: string;
  viewer_role: BorrowRole;
  created_at: string;
  last_message_at: string | null;
  request: { id: string; status: BorrowStatus; start_date: string; end_date: string };
  listing: { id: string; title: string; archived: boolean; cover_path: string | null };
  other: { id: string; display_name: string | null };
  last_message: { id: string; sender_id: string; body: string; created_at: string } | null;
  unread_count: number;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  sender_id: string;
  client_id: string;
  body: string;
  created_at: string;
}

export const toMessage = (m: MessageRow): ChatMessage => ({
  id: m.id,
  conversationId: m.conversation_id,
  senderId: m.sender_id,
  body: m.body,
  clientId: m.client_id,
  createdAt: m.created_at,
});

const toConversation = (r: ConversationRow, imageUrl: string | null): Conversation => ({
  id: r.id,
  borrowRequestId: r.borrow_request_id,
  viewerRole: r.viewer_role,
  request: { id: r.request.id, status: r.request.status, startDate: r.request.start_date, endDate: r.request.end_date },
  listing: { id: r.listing.id, title: r.listing.title, archived: r.listing.archived, imageUrl },
  otherParticipant: { id: r.other.id, displayName: r.other.display_name },
  lastMessage: r.last_message
    ? { id: r.last_message.id, senderId: r.last_message.sender_id, body: r.last_message.body, createdAt: r.last_message.created_at }
    : null,
  unreadCount: Number(r.unread_count),
  lastMessageAt: r.last_message_at,
  createdAt: r.created_at,
});

export function createSupabaseChatRepository(clients: SupabaseClients, logger: Logger): ChatRepository {
  const fail = (operation: string, error: { code?: string }) => {
    // PostgREST error codes only; messages can echo query details.
    logger.error({ operation, code: error.code }, 'database query failed');
    return AppError.unavailable('Data service is temporarily unavailable', 'DATABASE_UNAVAILABLE');
  };

  // SQLSTATEs raised by 20261103120000_chat.sql, plus PostgREST's JWT errors
  // (a socket can outlive its access token).
  const toError = (operation: string, error: { code?: string }) => {
    switch (error.code) {
      case 'NSC01':
        return AppError.conflict('CHAT_NOT_AVAILABLE', 'Chat opens once the borrow request is accepted');
      case 'NSC02':
        return AppError.notFound('Conversation not found', 'CONVERSATION_NOT_FOUND');
      case 'NSC03':
        return AppError.conflict('CLIENT_ID_REUSED', 'This message id was already used for a different message');
      case '23514':
        return AppError.badRequest('INVALID_MESSAGE', 'Messages must be 1 to 2000 characters and not blank');
      case '42501':
        return AppError.forbidden();
      case 'PGRST301':
      case 'PGRST303':
        return AppError.unauthenticated('Access token is invalid or expired', 'INVALID_TOKEN');
      default:
        return fail(operation, error);
    }
  };

  const db = <T>(operation: string, query: PromiseLike<T>) => timed(logger, `database.${operation}`, async () => query);

  async function fetchConversations(accessToken: string, args: Record<string, unknown>) {
    const client = clients.forUser(accessToken);
    const { data, error } = await db('list_conversations', client.rpc('list_conversations', args));
    if (error) throw toError('list_conversations', error);
    const result = data as { total: number; items: ConversationRow[] };
    const urls = await coverUrls(client, result.items);
    return {
      total: Number(result.total),
      items: result.items.map((r) => toConversation(r, r.listing.cover_path ? (urls.get(r.listing.cover_path) ?? null) : null)),
    };
  }

  // Signed with the caller's token, like the borrow-request list.
  async function coverUrls(client: SupabaseClient, rows: ConversationRow[]) {
    const paths = [...new Set(rows.map((r) => r.listing.cover_path).filter((p): p is string => Boolean(p)))];
    const urls = new Map<string, string>();
    if (paths.length === 0) return urls;
    const { data } = await timed(logger, 'storage.sign_conversation_covers', async () =>
      client.storage.from(LISTING_IMAGES_BUCKET).createSignedUrls(paths, SIGNED_URL_TTL_SECONDS),
    );
    for (const s of data ?? []) if (s.path && s.signedUrl && !s.error) urls.set(s.path, s.signedUrl);
    return urls;
  }

  return {
    list(caller, { page, pageSize }) {
      return fetchConversations(caller.accessToken, { p_limit: pageSize, p_offset: (page - 1) * pageSize });
    },

    async get(caller, id) {
      const { items } = await fetchConversations(caller.accessToken, { p_id: id, p_limit: 1 });
      return items[0] ?? null;
    },

    async open(caller, borrowRequestId) {
      const { data, error } = await db(
        'open_conversation',
        clients.forUser(caller.accessToken).rpc('open_conversation', { p_borrow_request_id: borrowRequestId }),
      );
      if (error) throw toError('open_conversation', error);
      return (data as string | null) ?? null;
    },

    async messages(caller, conversationId, { before, limit }) {
      const { data, error } = await db(
        'list_messages',
        clients.forUser(caller.accessToken).rpc('list_messages', {
          p_conversation_id: conversationId,
          p_before_created_at: before?.createdAt ?? null,
          p_before_id: before?.id ?? null,
          p_limit: limit,
        }),
      );
      if (error) throw toError('list_messages', error);
      return ((data ?? []) as MessageRow[]).map(toMessage);
    },

    async send(caller, conversationId, { clientId, body }) {
      const { data, error } = await db(
        'send_message',
        clients.forUser(caller.accessToken).rpc('send_message', {
          p_conversation_id: conversationId,
          p_client_id: clientId,
          p_body: body,
        }),
      );
      if (error) throw toError('send_message', error);
      const r = data as { created: boolean; borrower_id: string; lender_id: string; message: MessageRow };
      return { message: toMessage(r.message), created: r.created, participantIds: [r.borrower_id, r.lender_id] };
    },

    async markRead(caller, conversationId) {
      const { data, error } = await db(
        'mark_conversation_read',
        clients.forUser(caller.accessToken).rpc('mark_conversation_read', { p_conversation_id: conversationId }),
      );
      if (error) throw toError('mark_conversation_read', error);
      return data === true;
    },
  };
}

// Used when the app is built without a chat repository (some tests).
export function unconfiguredChat(): ChatRepository {
  const refuse = async (): Promise<never> => {
    throw AppError.unavailable('Chat is not configured on the server', 'SERVER_NOT_CONFIGURED');
  };
  return { list: refuse, get: refuse, open: refuse, messages: refuse, send: refuse, markRead: refuse };
}
