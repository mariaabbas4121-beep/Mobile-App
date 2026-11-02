import type { Caller } from '../listings/listing.types.js';

// Shapes returned by the borrow-request endpoints. Participants see each
// other's id and display name only; contact details stay private (chat comes
// after acceptance, in a later phase).

export const BORROW_STATUSES = ['pending', 'accepted', 'declined', 'cancelled'] as const;
export type BorrowStatus = (typeof BORROW_STATUSES)[number];
export type BorrowDecision = Exclude<BorrowStatus, 'pending'>;
export type BorrowRole = 'borrower' | 'lender';

export interface DateRange {
  startDate: string;
  endDate: string;
}

export interface BorrowRequest {
  id: string;
  status: BorrowStatus;
  // Inclusive calendar dates, YYYY-MM-DD.
  startDate: string;
  endDate: string;
  days: number;
  message: string | null;
  listing: { id: string; title: string; archived: boolean; imageUrl: string | null };
  borrower: { id: string; displayName: string | null };
  lender: { id: string; displayName: string | null };
  // The caller's side of this request.
  viewerRole: BorrowRole;
  createdAt: string;
  updatedAt: string;
  decidedAt: string | null;
  cancelledAt: string | null;
}

export interface BorrowRequestInput {
  listingId: string;
  startDate: string;
  endDate: string;
  message: string | null;
}

// Database access for borrow requests. Every call runs with the caller's
// token; Row-Level Security and the table's triggers enforce the rules again.
// Implementations throw AppError.
export interface BorrowRequestRepository {
  list(
    caller: Caller,
    query: { role: BorrowRole; status?: BorrowStatus | undefined; page: number; pageSize: number },
  ): Promise<{ items: BorrowRequest[]; total: number }>;
  // Null unless the caller is the borrower or the lender.
  get(caller: Caller, id: string): Promise<BorrowRequest | null>;
  create(caller: Caller, input: BorrowRequestInput): Promise<BorrowRequest>;
  // Null when Row-Level Security matched no row.
  setStatus(caller: Caller, id: string, status: BorrowDecision): Promise<BorrowRequest | null>;
  // Accepted (reserved) ranges of a listing from today on. Dates only.
  bookedRanges(caller: Caller | null, listingId: string): Promise<DateRange[]>;
}
