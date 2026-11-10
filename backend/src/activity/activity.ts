import type { BorrowRequest, BorrowRequestRepository, BorrowRole, BorrowStatus } from '../borrow/borrow.types.js';
import type { ChatService } from '../chat/chat.service.js';
import type { Conversation } from '../chat/chat.types.js';
import type { Logger } from '../lib/logger.js';
import type { Caller, Listing, ListingRepository } from '../listings/listing.types.js';
import type { HandoverEvent, HandoverMethod, HandoverRepository } from '../handover/handover.types.js';
import type { ReturnEvent, ReturnMethod, ReturnRepository } from '../returns/return.types.js';

// The caller's recent activity, derived from records they can already read:
// their borrow requests (both sides), their conversations, their own
// listings and their requests' pickup, return and extension audit trails.
// Every source is queried with the caller's token, so Row-Level
// Security decides what is included; nothing is stored and no other user's
// records can appear. No notification table is involved.

export const ACTIVITY_TYPES = [
  'request_received', // someone asked to borrow one of your items
  'request_sent', // you asked to borrow an item
  'request_accepted',
  'request_declined',
  'request_cancelled',
  'message', // latest message of a conversation
  'listing_created',
  'listing_archived',
  // Pickup (Phase 3B.1), from the handover audit trail.
  'pickup_authorized', // the borrower named someone to collect the item
  'pickup_authorization_revoked',
  'pickup_authorization_redeemed', // the lender accepted that person's code
  'item_handed_over', // the lender confirmed the handover
  // Returns and due dates (Phase 3B.2), from the return audit trail.
  'return_initiated', // the borrower started the return (returnMethod)
  'return_authorized', // the borrower named someone to return the item
  'return_authorization_revoked',
  'return_authorization_redeemed', // the lender accepted that person's code
  'item_returned', // the lender confirmed receipt
  'extension_requested', // requestedEndDate
  'extension_approved',
  'extension_rejected',
] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

export const ACTIVITY_SOURCES = ['borrowRequests', 'conversations', 'listings', 'handovers', 'returns'] as const;
export type ActivitySource = (typeof ACTIVITY_SOURCES)[number];

export interface ActivityItem {
  // Stable per event, e.g. "request:<id>:accepted".
  id: string;
  type: ActivityType;
  occurredAt: string;
  // Who did it; isYou when it was the caller.
  actor: { id: string; displayName: string | null; isYou: boolean } | null;
  listing: { id: string; title: string; imageUrl: string | null } | null;
  request: { id: string; status: BorrowStatus; startDate: string; endDate: string; viewerRole: BorrowRole } | null;
  conversationId: string | null;
  // Start of the message, for 'message' only.
  preview: string | null;
  // Pickup events: the person the borrower authorized (participants only
  // ever see their own requests' events), and how the item was handed over.
  recipientName: string | null;
  handoverMethod: HandoverMethod | null;
  // Return events: how the item is (or was) coming back.
  returnMethod: ReturnMethod | null;
  // Extension events: the due date asked for.
  requestedEndDate: string | null;
}

export interface ActivityFeed {
  items: ActivityItem[];
  // Sources that could not be read; the rest are still returned.
  unavailable: ActivitySource[];
}

// How many of the most recent records each source contributes.
export const ACTIVITY_SOURCE_WINDOW = 50;
export const ACTIVITY_PREVIEW_LENGTH = 120;

const party = (p: { id: string; displayName: string | null }, me: string) => ({ id: p.id, displayName: p.displayName, isYou: p.id === me });

function requestEvents(r: BorrowRequest, me: string): ActivityItem[] {
  const base = {
    listing: { id: r.listing.id, title: r.listing.title, imageUrl: r.listing.imageUrl },
    request: { id: r.id, status: r.status, startDate: r.startDate, endDate: r.endDate, viewerRole: r.viewerRole },
    conversationId: null,
    preview: null,
    recipientName: null,
    handoverMethod: null,
    returnMethod: null,
    requestedEndDate: null,
  };
  const events: ActivityItem[] = [
    {
      ...base,
      id: `request:${r.id}:created`,
      type: r.viewerRole === 'lender' ? 'request_received' : 'request_sent',
      occurredAt: r.createdAt,
      actor: party(r.borrower, me),
    },
  ];
  // Only the lender accepts or declines; only the borrower cancels.
  if ((r.status === 'accepted' || r.status === 'declined') && r.decidedAt) {
    events.push({ ...base, id: `request:${r.id}:${r.status}`, type: `request_${r.status}`, occurredAt: r.decidedAt, actor: party(r.lender, me) });
  }
  if (r.status === 'cancelled' && r.cancelledAt) {
    events.push({ ...base, id: `request:${r.id}:cancelled`, type: 'request_cancelled', occurredAt: r.cancelledAt, actor: party(r.borrower, me) });
  }
  return events;
}

function messageEvent(c: Conversation, me: string): ActivityItem | null {
  const m = c.lastMessage;
  if (!m) return null;
  const sender = m.senderId === me ? { id: me, displayName: null } : c.otherParticipant;
  return {
    id: `message:${m.id}`,
    type: 'message',
    occurredAt: m.createdAt,
    actor: party(sender, me),
    listing: { id: c.listing.id, title: c.listing.title, imageUrl: c.listing.imageUrl },
    request: { id: c.request.id, status: c.request.status, startDate: c.request.startDate, endDate: c.request.endDate, viewerRole: c.viewerRole },
    conversationId: c.id,
    preview: m.body.length > ACTIVITY_PREVIEW_LENGTH ? `${m.body.slice(0, ACTIVITY_PREVIEW_LENGTH - 1)}…` : m.body,
    recipientName: null,
    handoverMethod: null,
    returnMethod: null,
    requestedEndDate: null,
  };
}

const HANDOVER_TYPES: Record<HandoverEvent['kind'], ActivityType> = {
  authorization_created: 'pickup_authorized',
  authorization_revoked: 'pickup_authorization_revoked',
  authorization_redeemed: 'pickup_authorization_redeemed',
  handover_confirmed: 'item_handed_over',
};

function handoverEvent(e: HandoverEvent, me: string): ActivityItem {
  return {
    id: `handover:${e.id}`,
    type: HANDOVER_TYPES[e.kind],
    occurredAt: e.createdAt,
    actor: party(e.actor, me),
    listing: e.listing,
    request: e.request,
    conversationId: null,
    preview: null,
    recipientName: e.recipientName,
    handoverMethod: e.method,
    returnMethod: null,
    requestedEndDate: null,
  };
}

const RETURN_TYPES: Record<ReturnEvent['kind'], ActivityType> = {
  return_initiated: 'return_initiated',
  return_authorization_created: 'return_authorized',
  return_authorization_revoked: 'return_authorization_revoked',
  return_authorization_redeemed: 'return_authorization_redeemed',
  return_confirmed: 'item_returned',
  extension_requested: 'extension_requested',
  extension_approved: 'extension_approved',
  extension_rejected: 'extension_rejected',
};

function returnEvent(e: ReturnEvent, me: string): ActivityItem {
  return {
    id: `return:${e.id}`,
    type: RETURN_TYPES[e.kind],
    occurredAt: e.createdAt,
    actor: party(e.actor, me),
    listing: e.listing,
    request: e.request,
    conversationId: null,
    preview: null,
    recipientName: e.recipientName,
    handoverMethod: null,
    returnMethod: e.method,
    requestedEndDate: e.requestedEndDate,
  };
}

// Created and archived have reliable timestamps. Edits do not (updated_at
// also moves for availability toggles and photo changes), so they are left out.
function listingEvents(l: Listing, me: string): ActivityItem[] {
  const base = {
    actor: party({ id: me, displayName: l.owner.displayName }, me),
    listing: { id: l.id, title: l.title, imageUrl: l.images[0]?.url ?? null },
    request: null,
    conversationId: null,
    preview: null,
    recipientName: null,
    handoverMethod: null,
    returnMethod: null,
    requestedEndDate: null,
  };
  const events: ActivityItem[] = [{ ...base, id: `listing:${l.id}:created`, type: 'listing_created', occurredAt: l.createdAt }];
  if (l.archivedAt) events.push({ ...base, id: `listing:${l.id}:archived`, type: 'listing_archived', occurredAt: l.archivedAt });
  return events;
}

export interface ActivityDeps {
  listings: ListingRepository;
  borrowRequests: BorrowRequestRepository;
  chat: Pick<ChatService, 'list'>;
  handovers: Pick<HandoverRepository, 'listEvents'>;
  returns: Pick<ReturnRepository, 'listEvents'>;
  logger: Logger;
}

export function createActivityService({ listings, borrowRequests, chat, handovers, returns, logger }: ActivityDeps) {
  return {
    // Newest first. A source that fails is reported in `unavailable`; if all
    // fail, the first error is thrown.
    async recent(caller: Caller, limit: number): Promise<ActivityFeed> {
      const me = caller.userId;
      const window = { page: 1, pageSize: ACTIVITY_SOURCE_WINDOW };
      const sources: [ActivitySource, Promise<ActivityItem[]>][] = [
        [
          'borrowRequests',
          Promise.all([
            borrowRequests.list(caller, { role: 'borrower', ...window }),
            borrowRequests.list(caller, { role: 'lender', ...window }),
          ]).then(([asBorrower, asLender]) => [...asBorrower.items, ...asLender.items].flatMap((r) => requestEvents(r, me))),
        ],
        [
          'conversations',
          chat.list(caller, window).then(({ items }) => items.map((c) => messageEvent(c, me)).filter((e): e is ActivityItem => e !== null)),
        ],
        [
          'listings',
          listings
            .search(caller, { ownerId: me, includeArchived: true, sort: 'newest', ...window })
            .then(({ items }) => items.filter((l) => l.owner.id === me).flatMap((l) => listingEvents(l, me))),
        ],
        ['handovers', handovers.listEvents(caller, ACTIVITY_SOURCE_WINDOW).then((events) => events.map((e) => handoverEvent(e, me)))],
        ['returns', returns.listEvents(caller, ACTIVITY_SOURCE_WINDOW).then((events) => events.map((e) => returnEvent(e, me)))],
      ];

      const settled = await Promise.allSettled(sources.map(([, p]) => p));
      const unavailable: ActivitySource[] = [];
      const events = new Map<string, ActivityItem>();
      settled.forEach((result, i) => {
        const name = sources[i]![0];
        if (result.status === 'fulfilled') {
          for (const e of result.value) events.set(e.id, e);
        } else {
          unavailable.push(name);
          logger.warn({ source: name, code: (result.reason as { code?: string })?.code }, 'activity source unavailable');
        }
      });
      if (unavailable.length === sources.length) {
        throw (settled.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason;
      }

      const items = [...events.values()]
        .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt) || a.id.localeCompare(b.id))
        .slice(0, limit);
      return { items, unavailable };
    },
  };
}

export type ActivityService = ReturnType<typeof createActivityService>;
