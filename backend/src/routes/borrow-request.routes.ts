import { Router, type Request, type Response } from 'express';
import type { AuthGateway, ProfileRepository } from '../auth/auth.types.js';
import { AppError } from '../lib/errors.js';
import { getAuth, optionalAuth, requireAuth } from '../middleware/auth.middleware.js';
import { requireAccountStatus } from '../middleware/account-status.middleware.js';
import { validateBody } from '../middleware/validate.middleware.js';
import type { BorrowLimiters } from '../middleware/rate-limit.middleware.js';
import { listingParams, parseOrThrow } from '../listings/listing.schemas.js';
import type { Caller, ListingRepository } from '../listings/listing.types.js';
import {
  borrowRequestCreateBody,
  borrowRequestListQuery,
  borrowRequestParams,
  dateWindowIssues,
  type BorrowRequestCreateBody,
} from '../borrow/borrow.schemas.js';
import type { BorrowDecision, BorrowRequest, BorrowRequestRepository, BorrowRole } from '../borrow/borrow.types.js';
import { rangesOverlap, todayInPakistan } from '../borrow/dates.js';

export interface BorrowRequestRouteDeps {
  gateway: AuthGateway;
  profiles: ProfileRepository;
  listings: ListingRepository;
  borrowRequests: BorrowRequestRepository;
  limiters: BorrowLimiters;
  now?: () => number;
}

const requestNotFound = () => AppError.notFound('Borrow request not found', 'BORROW_REQUEST_NOT_FOUND');
const datesUnavailable = () => AppError.conflict('DATES_UNAVAILABLE', 'Those dates are already booked');

// Who may move a pending request where.
const DECISIONS: Record<BorrowDecision, BorrowRole> = { accepted: 'lender', declined: 'lender', cancelled: 'borrower' };

// Borrow requests. Every check here is repeated by the database (RLS,
// triggers and an exclusion constraint), which is what makes them hold
// under concurrency; the API checks first to give clear errors.
export function borrowRequestRoutes({ gateway, profiles, listings, borrowRequests, limiters, now = Date.now }: BorrowRequestRouteDeps) {
  const router = Router();
  const authenticated = requireAuth(gateway);
  const active = requireAccountStatus(profiles, ['active']);
  // Withdrawing (decline, cancel) stays possible for restricted accounts.
  const inGoodStanding = requireAccountStatus(profiles, ['active', 'restricted']);
  const caller = (req: Request): Caller => {
    const { user, accessToken } = getAuth(req);
    return { userId: user.id, accessToken };
  };

  const list = (role: BorrowRole) => async (req: Request, res: Response) => {
    const query = parseOrThrow(borrowRequestListQuery, req.query);
    const { items, total } = await borrowRequests.list(caller(req), { role, ...query });
    res.status(200).json({
      success: true,
      data: {
        items,
        pagination: { page: query.page, pageSize: query.pageSize, total, totalPages: Math.ceil(total / query.pageSize) },
      },
    });
  };

  // Requests the caller made, and requests for the caller's listings.
  router.get('/outgoing', authenticated, list('borrower'));
  router.get('/incoming', authenticated, list('lender'));

  // Participants only; anyone else gets 404, not 403, so ids reveal nothing.
  router.get('/:id', authenticated, async (req, res) => {
    const { id } = parseOrThrow(borrowRequestParams, req.params);
    const request = await borrowRequests.get(caller(req), id);
    if (!request) throw requestNotFound();
    res.status(200).json({ success: true, data: { request } });
  });

  router.post('/', authenticated, active, limiters.createPerUser, validateBody(borrowRequestCreateBody), async (req, res) => {
    const body = req.body as BorrowRequestCreateBody;
    const issues = dateWindowIssues(body.startDate, body.endDate, todayInPakistan(now()));
    if (issues.length > 0) throw AppError.badRequest('VALIDATION_ERROR', 'Request validation failed', issues);

    const me = caller(req);
    const listing = await listings.get(me, body.listingId);
    if (!listing || listing.archivedAt) {
      throw listing
        ? AppError.conflict('LISTING_NOT_BORROWABLE', 'This item is no longer listed')
        : AppError.notFound('Listing not found', 'LISTING_NOT_FOUND');
    }
    if (listing.owner.id === me.userId) throw AppError.forbidden('You cannot borrow your own item', 'CANNOT_BORROW_OWN_LISTING');
    if (listing.availability !== 'available') {
      throw AppError.conflict('LISTING_NOT_BORROWABLE', 'This item is not available to borrow right now');
    }
    const booked = await borrowRequests.bookedRanges(me, listing.id);
    if (booked.some((r) => rangesOverlap(r, body))) throw datesUnavailable();

    const request = await borrowRequests.create(me, {
      listingId: listing.id,
      startDate: body.startDate,
      endDate: body.endDate,
      message: body.message ?? null,
    });
    res.status(201).json({ success: true, data: { request } });
  });

  const decide = (status: BorrowDecision) => async (req: Request, res: Response) => {
    const { id } = parseOrThrow(borrowRequestParams, req.params);
    const me = caller(req);
    const current = await borrowRequests.get(me, id);
    if (!current) throw requestNotFound();
    if (current.viewerRole !== DECISIONS[status]) {
      throw AppError.forbidden(
        DECISIONS[status] === 'lender' ? 'Only the lender can accept or decline' : 'Only the borrower can cancel',
      );
    }
    if (current.status !== 'pending') {
      throw AppError.conflict('INVALID_STATUS_TRANSITION', `This request is already ${current.status}`);
    }
    const updated: BorrowRequest | null = await borrowRequests.setStatus(me, id, status);
    // RLS matched no row: the account status or request changed meanwhile.
    if (!updated) throw AppError.forbidden();
    res.status(200).json({ success: true, data: { request: updated } });
  };

  // Accepting reserves the dates; it fails with 409 DATES_UNAVAILABLE if
  // another accepted request already covers any of them.
  router.post('/:id/accept', authenticated, active, decide('accepted'));
  router.post('/:id/decline', authenticated, inGoodStanding, decide('declined'));
  router.post('/:id/cancel', authenticated, inGoodStanding, decide('cancelled'));

  return router;
}

// GET /items/:id/booked-dates: reserved ranges for the request form. Public
// like the listing itself; dates only, never who booked them.
export function listingBookingRoutes({
  gateway,
  listings,
  borrowRequests,
}: Pick<BorrowRequestRouteDeps, 'gateway' | 'listings' | 'borrowRequests'>) {
  const router = Router();
  router.get('/:id/booked-dates', optionalAuth(gateway), async (req, res) => {
    const { id } = parseOrThrow(listingParams, req.params);
    const me = req.auth ? { userId: req.auth.user.id, accessToken: req.auth.accessToken } : null;
    const listing = await listings.get(me, id);
    if (!listing) throw AppError.notFound('Listing not found', 'LISTING_NOT_FOUND');
    const bookedDates = await borrowRequests.bookedRanges(me, id);
    res.status(200).json({ success: true, data: { bookedDates } });
  });
  return router;
}
