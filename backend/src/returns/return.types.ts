import type { BorrowRole, BorrowStatus } from '../borrow/borrow.types.js';
import type { HandoverPhoto, NewAuthorization, PickupAuthorization } from '../handover/handover.types.js';
import type { Caller, ImageContentType } from '../listings/listing.types.js';

// Shapes returned by the return and extension endpoints (Phase 3B.2). Return
// authorizations are PickupAuthorization records with operation 'return';
// the code appears only in the response that creates one.

export const RETURN_METHODS = ['personal', 'authorized', 'delivery'] as const;
export type ReturnMethod = (typeof RETURN_METHODS)[number];
export type ExtensionStatus = 'pending' | 'approved' | 'rejected';

export interface ItemReturn {
  id: string;
  // As initiated; once confirmed, how it actually came back.
  method: ReturnMethod;
  // Delivery/courier details as the borrower gave them. No live tracking.
  delivery: { provider: string | null; reference: string | null; note: string | null } | null;
  initiatedAt: string;
  updatedAt: string;
  authorizationId: string | null;
  recipientName: string | null;
  recipientPhone: string | null;
  // Null until the lender confirms receipt.
  confirmedAt: string | null;
  confirmedBy: { id: string; displayName: string | null } | null;
  conditionNotes: string | null;
  photos: HandoverPhoto[];
}

export interface DueDateExtension {
  id: string;
  status: ExtensionStatus;
  previousEndDate: string;
  requestedEndDate: string;
  reason: string | null;
  requestedWhileOverdue: boolean;
  overdueAtDecision: boolean | null;
  createdAt: string;
  decidedAt: string | null;
}

// Where the return stands, derived from the records:
//   not_picked_up          nothing to return yet
//   ready                  picked up, return not started
//   awaiting_confirmation  the borrower initiated it; the lender has not confirmed
//   returned               the lender confirmed receipt
export type ReturnStatus = 'not_picked_up' | 'ready' | 'awaiting_confirmation' | 'returned';

export interface ReturnState {
  borrowRequestId: string;
  requestStatus: BorrowStatus;
  status: ReturnStatus;
  startDate: string;
  // The current (approved) due date, inclusive, Pakistan time.
  dueDate: string;
  originalDueDate: string;
  // Server's today (Pakistan), so clients never judge overdue by their own clock.
  today: string;
  overdue: boolean;
  daysOverdue: number;
  return: ItemReturn | null;
  // Return authorizations, newest first.
  authorizations: PickupAuthorization[];
  activeAuthorization: PickupAuthorization | null;
  // Newest first.
  extensions: DueDateExtension[];
  pendingExtension: DueDateExtension | null;
}

export interface DeliveryDetails {
  provider: string | null;
  reference: string | null;
  note: string | null;
}

export type ReturnEventKind =
  | 'return_initiated'
  | 'return_authorization_created'
  | 'return_authorization_revoked'
  | 'return_authorization_redeemed'
  | 'return_confirmed'
  | 'extension_requested'
  | 'extension_approved'
  | 'extension_rejected';

export interface ReturnEvent {
  id: string;
  kind: ReturnEventKind;
  createdAt: string;
  actor: { id: string; displayName: string | null };
  recipientName: string | null;
  method: ReturnMethod | null;
  requestedEndDate: string | null;
  request: { id: string; status: BorrowStatus; startDate: string; endDate: string; viewerRole: BorrowRole };
  listing: { id: string; title: string; imageUrl: string | null };
}

// Database access. Every call runs with the caller's token; the database
// functions decide who may do what, atomically. Implementations throw AppError.
export interface ReturnRepository {
  // Null unless the caller takes part in the request.
  getState(caller: Caller, requestId: string): Promise<ReturnState | null>;
  initiate(caller: Caller, requestId: string, input: { method: 'personal' | 'delivery'; delivery: DeliveryDetails | null }): Promise<void>;
  createAuthorization(
    caller: Caller,
    requestId: string,
    input: NewAuthorization & { tokenHash: string; ttlHours: number },
  ): Promise<PickupAuthorization>;
  revokeAuthorization(caller: Caller, requestId: string, authorizationId: string): Promise<PickupAuthorization>;
  verifyCode(caller: Caller, requestId: string, tokenHash: string): Promise<PickupAuthorization>;
  // Returns the return's id.
  confirm(
    caller: Caller,
    requestId: string,
    input: { method: ReturnMethod; tokenHash: string | null; conditionNotes: string | null },
  ): Promise<string>;
  addPhoto(caller: Caller, requestId: string, returnId: string, file: { data: Buffer; contentType: ImageContentType }): Promise<HandoverPhoto>;
  requestExtension(caller: Caller, requestId: string, input: { requestedEndDate: string; reason: string | null }): Promise<DueDateExtension>;
  decideExtension(caller: Caller, requestId: string, extensionId: string, decision: 'approved' | 'rejected'): Promise<DueDateExtension>;
  listEvents(caller: Caller, limit: number): Promise<ReturnEvent[]>;
}
