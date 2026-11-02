import type { SupabaseClient } from '@supabase/supabase-js';
import type { SupabaseClients } from '../config/supabase.js';
import type { Logger } from '../lib/logger.js';
import { AppError } from '../lib/errors.js';
import { timed } from '../lib/timing.js';
import type { Caller } from '../listings/listing.types.js';
import { LISTING_IMAGES_BUCKET, SIGNED_URL_TTL_SECONDS } from '../listings/supabase-listing.repository.js';
import { inclusiveDays } from './dates.js';
import type { BorrowRequest, BorrowRequestRepository, BorrowStatus, DateRange } from './borrow.types.js';

// One element of list_borrow_requests' "items".
interface RequestRow {
  id: string;
  status: BorrowStatus;
  start_date: string;
  end_date: string;
  message: string | null;
  decided_at: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
  listing: { id: string; title: string; archived: boolean; cover_path: string | null };
  borrower: { id: string; display_name: string | null };
  lender: { id: string; display_name: string | null };
}

const toRequest = (r: RequestRow, viewerId: string, imageUrl: string | null): BorrowRequest => ({
  id: r.id,
  status: r.status,
  startDate: r.start_date,
  endDate: r.end_date,
  days: inclusiveDays(r.start_date, r.end_date),
  message: r.message,
  listing: { id: r.listing.id, title: r.listing.title, archived: r.listing.archived, imageUrl },
  borrower: { id: r.borrower.id, displayName: r.borrower.display_name },
  lender: { id: r.lender.id, displayName: r.lender.display_name },
  viewerRole: r.borrower.id === viewerId ? 'borrower' : 'lender',
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  decidedAt: r.decided_at,
  cancelledAt: r.cancelled_at,
});

export function createSupabaseBorrowRequestRepository(clients: SupabaseClients, logger: Logger): BorrowRequestRepository {
  const fail = (operation: string, error: { code?: string }) => {
    // PostgREST error codes only; messages can echo query details.
    logger.error({ operation, code: error.code }, 'database query failed');
    return AppError.unavailable('Data service is temporarily unavailable', 'DATABASE_UNAVAILABLE');
  };

  // SQLSTATEs raised by 20261102120000_borrow_requests.sql.
  const writeError = (operation: string, error: { code?: string }) => {
    switch (error.code) {
      case 'NSB01':
        return AppError.conflict('LISTING_NOT_BORROWABLE', 'This item cannot be borrowed right now');
      case 'NSB02':
        return AppError.forbidden('You cannot borrow your own item', 'CANNOT_BORROW_OWN_LISTING');
      case 'NSB03':
      case '23514':
        return AppError.badRequest('INVALID_DATES', 'Those dates cannot be requested');
      case 'NSB04':
      case '23P01':
        return AppError.conflict('DATES_UNAVAILABLE', 'Those dates are already booked');
      case 'NSB05':
        return AppError.conflict('INVALID_STATUS_TRANSITION', 'This request can no longer be changed');
      case '23505':
        return AppError.conflict('DUPLICATE_PENDING_REQUEST', 'You already have a pending request for this item');
      case '42501':
        return AppError.forbidden();
      default:
        return fail(operation, error);
    }
  };

  const db = <T>(operation: string, query: PromiseLike<T>) => timed(logger, `database.${operation}`, async () => query);

  async function fetchRequests(caller: Caller, args: Record<string, unknown>) {
    const client = clients.forUser(caller.accessToken);
    const { data, error } = await db('list_borrow_requests', client.rpc('list_borrow_requests', args));
    if (error) throw fail('list_borrow_requests', error);
    const result = data as { total: number; items: RequestRow[] };
    const urls = await coverUrls(client, result.items);
    return {
      total: Number(result.total),
      items: result.items.map((r) => toRequest(r, caller.userId, r.listing.cover_path ? (urls.get(r.listing.cover_path) ?? null) : null)),
    };
  }

  // Signed with the caller's token, so a photo of a listing the caller can no
  // longer see (e.g. archived) simply has no URL.
  async function coverUrls(client: SupabaseClient, rows: RequestRow[]) {
    const paths = [...new Set(rows.map((r) => r.listing.cover_path).filter((p): p is string => Boolean(p)))];
    const urls = new Map<string, string>();
    if (paths.length === 0) return urls;
    const { data } = await timed(logger, 'storage.sign_request_covers', async () =>
      client.storage.from(LISTING_IMAGES_BUCKET).createSignedUrls(paths, SIGNED_URL_TTL_SECONDS),
    );
    for (const s of data ?? []) if (s.path && s.signedUrl && !s.error) urls.set(s.path, s.signedUrl);
    return urls;
  }

  const repository: BorrowRequestRepository = {
    list(caller, { role, status, page, pageSize }) {
      return fetchRequests(caller, {
        p_role: role,
        p_status: status ?? null,
        p_limit: pageSize,
        p_offset: (page - 1) * pageSize,
      });
    },

    async get(caller, id) {
      const { items } = await fetchRequests(caller, { p_id: id, p_limit: 1 });
      return items[0] ?? null;
    },

    async create(caller, input) {
      // The lender, status and timestamps are set by the database.
      const { data, error } = await db(
        'create_borrow_request',
        clients
          .forUser(caller.accessToken)
          .from('borrow_requests')
          .insert({
            listing_id: input.listingId,
            borrower_id: caller.userId,
            start_date: input.startDate,
            end_date: input.endDate,
            message: input.message,
          })
          .select('id')
          .single<{ id: string }>(),
      );
      if (error) throw writeError('create_borrow_request', error);
      const created = await repository.get(caller, data.id);
      if (!created) throw fail('create_borrow_request', {});
      return created;
    },

    async setStatus(caller, id, status) {
      const { data, error } = await db(
        'update_borrow_request',
        clients
          .forUser(caller.accessToken)
          .from('borrow_requests')
          .update({ status })
          .eq('id', id)
          .select('id')
          .maybeSingle<{ id: string }>(),
      );
      if (error) throw writeError('update_borrow_request', error);
      return data ? repository.get(caller, id) : null;
    },

    async bookedRanges(caller, listingId) {
      const client = caller ? clients.forUser(caller.accessToken) : clients.anon();
      const { data, error } = await db('listing_booked_ranges', client.rpc('listing_booked_ranges', { p_listing_id: listingId }));
      if (error) throw fail('listing_booked_ranges', error);
      return ((data ?? []) as { start_date: string; end_date: string }[]).map(
        (r): DateRange => ({ startDate: r.start_date, endDate: r.end_date }),
      );
    },
  };

  return repository;
}

// Used when the app is built without a borrow-request repository (some tests).
export function unconfiguredBorrowRequests(): BorrowRequestRepository {
  const refuse = async (): Promise<never> => {
    throw AppError.unavailable('Borrow requests are not configured on the server', 'SERVER_NOT_CONFIGURED');
  };
  return { list: refuse, get: refuse, create: refuse, setStatus: refuse, bookedRanges: refuse };
}
