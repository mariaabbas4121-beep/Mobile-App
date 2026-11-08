import type { BorrowRole, BorrowStatus } from '../borrow/borrow.types.js';
import type { Caller, ImageContentType } from '../listings/listing.types.js';

// Shapes returned by the handover endpoints (Phase 3B.1: pickup only). The
// authorization code itself appears only once, in the response that creates
// it; nothing here ever carries it or its hash.

export const PICKUP_AUTHORIZATION_STATUSES = ['active', 'redeemed', 'revoked', 'expired'] as const;
export type PickupAuthorizationStatus = (typeof PICKUP_AUTHORIZATION_STATUSES)[number];
export const HANDOVER_METHODS = ['personal', 'authorized'] as const;
export type HandoverMethod = (typeof HANDOVER_METHODS)[number];

export interface PickupAuthorization {
  id: string;
  borrowRequestId: string;
  operation: 'pickup';
  // 'expired' is derived from expiresAt, whether or not it is stored yet.
  status: PickupAuthorizationStatus;
  recipientName: string;
  recipientPhone: string | null;
  note: string | null;
  expiresAt: string;
  createdAt: string;
  revokedAt: string | null;
  redeemedAt: string | null;
}

export interface HandoverPhoto {
  id: string;
  // Short-lived signed URL; null when Storage could not sign it.
  url: string | null;
  contentType: string;
  createdAt: string;
}

export interface Handover {
  id: string;
  method: HandoverMethod;
  authorizationId: string | null;
  // For an authorized pickup: who collected it, as the borrower named them.
  recipientName: string | null;
  recipientPhone: string | null;
  conditionNotes: string | null;
  // Server time.
  confirmedAt: string;
  confirmedBy: { id: string; displayName: string | null };
  photos: HandoverPhoto[];
}

export interface HandoverState {
  borrowRequestId: string;
  requestStatus: BorrowStatus;
  // 'completed' once the lender confirmed; 'pending' until then.
  status: 'pending' | 'completed';
  handover: Handover | null;
  // Newest first.
  authorizations: PickupAuthorization[];
  // The usable one, if any (at most one).
  activeAuthorization: PickupAuthorization | null;
}

export interface NewAuthorization {
  recipientName: string;
  recipientPhone: string | null;
  note: string | null;
}

// For Activity.
export type HandoverEventKind = 'authorization_created' | 'authorization_revoked' | 'authorization_redeemed' | 'handover_confirmed';

export interface HandoverEvent {
  id: string;
  kind: HandoverEventKind;
  createdAt: string;
  actor: { id: string; displayName: string | null };
  // For authorization events: the person the borrower named.
  recipientName: string | null;
  method: HandoverMethod | null;
  request: { id: string; status: BorrowStatus; startDate: string; endDate: string; viewerRole: BorrowRole };
  listing: { id: string; title: string; imageUrl: string | null };
}

// Database access. Every call runs with the caller's token; the database
// functions check participant, role, request status, code and expiry, and
// do so atomically. Implementations throw AppError.
export interface HandoverRepository {
  // Null unless the caller takes part in the request.
  getState(caller: Caller, requestId: string): Promise<HandoverState | null>;
  createAuthorization(
    caller: Caller,
    requestId: string,
    input: NewAuthorization & { tokenHash: string; ttlHours: number },
  ): Promise<PickupAuthorization>;
  revokeAuthorization(caller: Caller, requestId: string, authorizationId: string): Promise<PickupAuthorization>;
  // Checks a code without using it.
  verifyCode(caller: Caller, requestId: string, tokenHash: string): Promise<PickupAuthorization>;
  // Returns the new handover's id.
  confirm(
    caller: Caller,
    requestId: string,
    input: { method: HandoverMethod; tokenHash: string | null; conditionNotes: string | null },
  ): Promise<string>;
  addPhoto(
    caller: Caller,
    requestId: string,
    handoverId: string,
    file: { data: Buffer; contentType: ImageContentType },
  ): Promise<HandoverPhoto>;
  listEvents(caller: Caller, limit: number): Promise<HandoverEvent[]>;
}
