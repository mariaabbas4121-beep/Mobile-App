import type { BorrowRole, BorrowStatus } from '../borrow/borrow.types.js';
import type { Caller } from '../listings/listing.types.js';

// Shapes returned by the chat endpoints and socket events. Participants see
// each other's id and display name only; no email, phone or address.

export interface ChatMessage {
  id: string;
  conversationId: string;
  senderId: string;
  body: string;
  // The sender's idempotency key; lets the sending device match its own
  // optimistic copy to the stored message.
  clientId: string;
  // As stored (microsecond precision); also the history cursor.
  createdAt: string;
}

export interface Conversation {
  id: string;
  borrowRequestId: string;
  // The caller's side of the request.
  viewerRole: BorrowRole;
  request: { id: string; status: BorrowStatus; startDate: string; endDate: string };
  listing: { id: string; title: string; archived: boolean; imageUrl: string | null };
  otherParticipant: { id: string; displayName: string | null };
  // First 200 characters of the latest message.
  lastMessage: { id: string; senderId: string; body: string; createdAt: string } | null;
  unreadCount: number;
  lastMessageAt: string | null;
  createdAt: string;
}

export interface MessageCursor {
  createdAt: string;
  id: string;
}

export interface SendMessageInput {
  clientId: string;
  body: string;
}

export interface SendResult {
  message: ChatMessage;
  // False when this client id was already stored (a retry).
  created: boolean;
  // Borrower and lender, from the database.
  participantIds: string[];
}

// Database access for chat. Every call runs with the caller's token;
// Row-Level Security limits it to the caller's own conversations.
// Implementations throw AppError.
export interface ChatRepository {
  list(caller: Caller, query: { page: number; pageSize: number }): Promise<{ items: Conversation[]; total: number }>;
  // Null unless the caller is a participant.
  get(caller: Caller, id: string): Promise<Conversation | null>;
  // The conversation id of an accepted request the caller takes part in,
  // created if missing. Null when there is no such request for the caller;
  // throws CHAT_NOT_AVAILABLE when the request is not accepted.
  open(caller: Caller, borrowRequestId: string): Promise<string | null>;
  // Newest first, strictly older than `before`.
  messages(caller: Caller, conversationId: string, query: { before: MessageCursor | null; limit: number }): Promise<ChatMessage[]>;
  send(caller: Caller, conversationId: string, input: SendMessageInput): Promise<SendResult>;
  // False when the caller is not a participant.
  markRead(caller: Caller, conversationId: string): Promise<boolean>;
}

// Published after a message is stored, never before.
export interface MessageCreatedEvent {
  conversationId: string;
  message: ChatMessage;
  participantIds: string[];
}
