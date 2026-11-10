import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { SupabaseClients } from '../config/supabase.js';
import type { Logger } from '../lib/logger.js';
import { AppError } from '../lib/errors.js';
import { timed } from '../lib/timing.js';
import { IMAGE_EXTENSIONS } from '../listings/listing.schemas.js';
import { LISTING_IMAGES_BUCKET, SIGNED_URL_TTL_SECONDS } from '../listings/supabase-listing.repository.js';
import { inclusiveDays } from '../borrow/dates.js';
import type { BorrowRole, BorrowStatus } from '../borrow/borrow.types.js';
import { handoverError, toAuthorization } from '../handover/supabase-handover.repository.js';
import type { PickupAuthorization } from '../handover/handover.types.js';
import type {
  DueDateExtension,
  ExtensionStatus,
  ItemReturn,
  ReturnEvent,
  ReturnEventKind,
  ReturnMethod,
  ReturnRepository,
  ReturnState,
} from './return.types.js';

export const RETURN_EVIDENCE_BUCKET = 'return-evidence';

type AuthorizationRow = Parameters<typeof toAuthorization>[0];

interface PhotoRow {
  id: string;
  storage_path: string;
  content_type: string;
  created_at: string;
}

interface ExtensionRow {
  id: string;
  status: ExtensionStatus;
  previous_end_date: string;
  requested_end_date: string;
  reason: string | null;
  requested_while_overdue: boolean;
  overdue_at_decision: boolean | null;
  created_at: string;
  decided_at: string | null;
}

interface StateRow {
  borrow_request_id: string;
  request_status: BorrowStatus;
  start_date: string;
  due_date: string;
  original_due_date: string;
  today: string;
  picked_up: boolean;
  overdue: boolean;
  return: {
    id: string;
    method: ReturnMethod;
    delivery_provider: string | null;
    delivery_reference: string | null;
    delivery_note: string | null;
    initiated_at: string;
    updated_at: string;
    authorization_id: string | null;
    recipient_name: string | null;
    recipient_phone: string | null;
    confirmed_at: string | null;
    confirmed_by: { id: string; display_name: string | null } | null;
    condition_notes: string | null;
    photos: PhotoRow[];
  } | null;
  authorizations: AuthorizationRow[];
  extensions: ExtensionRow[];
}

interface EventRow {
  id: number | string;
  kind: ReturnEventKind;
  created_at: string;
  actor: { id: string; display_name: string | null };
  recipient_name: string | null;
  method: ReturnMethod | null;
  requested_end_date: string | null;
  request: { id: string; status: BorrowStatus; start_date: string; end_date: string; viewer_role: BorrowRole };
  listing: { id: string; title: string; cover_path: string | null };
}

export const toExtension = (e: ExtensionRow): DueDateExtension => ({
  id: e.id,
  status: e.status,
  previousEndDate: e.previous_end_date,
  requestedEndDate: e.requested_end_date,
  reason: e.reason,
  requestedWhileOverdue: e.requested_while_overdue,
  overdueAtDecision: e.overdue_at_decision,
  createdAt: e.created_at,
  decidedAt: e.decided_at,
});

// Derived, never stored: see return.types.ts.
export function returnStatus(pickedUp: boolean, r: { confirmedAt: string | null } | null): ReturnState['status'] {
  if (r?.confirmedAt) return 'returned';
  if (r) return 'awaiting_confirmation';
  return pickedUp ? 'ready' : 'not_picked_up';
}

export const daysOverdue = (overdue: boolean, today: string, dueDate: string) => (overdue ? inclusiveDays(dueDate, today) - 1 : 0);

// SQLSTATEs of 20261110120000_returns_extensions.sql; the shared ones (NSH*)
// mean what they mean for pickup.
export function returnError(code: string | undefined): AppError | null {
  switch (code) {
    case 'NSR01':
      return AppError.conflict('NOT_PICKED_UP', 'The item has not been picked up yet');
    case 'NSR02':
      return AppError.conflict('RETURN_NOT_INITIATED', 'The borrower has not started the return yet');
    case 'NSR03':
      return AppError.conflict('ALREADY_RETURNED', 'This item has already been returned');
    case 'NSR04':
      return AppError.conflict('AUTHORIZATION_NOT_ACTIVE', 'This authorization is no longer active');
    case 'NSH07':
      return AppError.badRequest('INVALID_RETURN_CODE', 'This is not a valid return code for this item');
    case 'NSH09':
      return AppError.conflict('AUTHORIZATION_ALREADY_USED', 'This return code has already been used');
    case 'NSH10':
      return AppError.conflict('AUTHORIZATION_EXPIRED', 'This return code has expired');
    case 'NSE01':
      return AppError.notFound('Extension request not found', 'EXTENSION_NOT_FOUND');
    case 'NSE02':
      return AppError.conflict('EXTENSION_PENDING', 'An extension request is already waiting for the owner');
    case 'NSE03':
      return AppError.badRequest(
        'INVALID_EXTENSION_DATE',
        'Choose a date after the current due date, not in the past, and at most 30 days after the start',
      );
    case 'NSE04':
      return AppError.conflict('EXTENSION_ALREADY_DECIDED', 'This extension request has already been answered');
    case 'NSE05':
      return AppError.conflict('DATES_UNAVAILABLE', 'Someone else has booked the item for those days');
    default:
      return handoverError(code);
  }
}

export function createSupabaseReturnRepository(clients: SupabaseClients, logger: Logger): ReturnRepository {
  // Error codes only: arguments include a code hash and personal details.
  const fail = (operation: string, error: { code?: string }) => {
    const mapped = returnError(error.code);
    if (mapped) return mapped;
    logger.error({ operation, code: error.code }, 'database query failed');
    return AppError.unavailable('Data service is temporarily unavailable', 'DATABASE_UNAVAILABLE');
  };

  const db = <T>(operation: string, query: PromiseLike<T>) => timed(logger, `database.${operation}`, async () => query);

  async function rpc<T>(client: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<T> {
    const { data, error } = await db(fn, client.rpc(fn, args));
    if (error) throw fail(fn, error);
    return data as T;
  }

  // Signed with the caller's token: Storage signs only for the participants.
  async function sign(client: SupabaseClient, bucket: string, paths: string[]) {
    const urls = new Map<string, string>();
    if (paths.length === 0) return urls;
    const { data, error } = await timed(logger, `storage.sign_${bucket}`, async () =>
      client.storage.from(bucket).createSignedUrls(paths, SIGNED_URL_TTL_SECONDS),
    );
    if (error) logger.warn({ operation: `sign_${bucket}` }, 'could not sign URLs');
    for (const s of data ?? []) if (s.path && s.signedUrl && !s.error) urls.set(s.path, s.signedUrl);
    return urls;
  }

  const user = (caller: { accessToken: string }) => clients.forUser(caller.accessToken);

  return {
    async getState(caller, requestId) {
      const client = user(caller);
      const row = await rpc<StateRow | null>(client, 'get_return_state', { p_request_id: requestId });
      if (!row) return null;
      const x = row.return;
      const urls = await sign(client, RETURN_EVIDENCE_BUCKET, x ? x.photos.map((p) => p.storage_path) : []);
      const ret: ItemReturn | null = x
        ? {
            id: x.id,
            method: x.method,
            delivery:
              x.delivery_provider || x.delivery_reference || x.delivery_note
                ? { provider: x.delivery_provider, reference: x.delivery_reference, note: x.delivery_note }
                : null,
            initiatedAt: x.initiated_at,
            updatedAt: x.updated_at,
            authorizationId: x.authorization_id,
            recipientName: x.recipient_name,
            recipientPhone: x.recipient_phone,
            confirmedAt: x.confirmed_at,
            confirmedBy: x.confirmed_by ? { id: x.confirmed_by.id, displayName: x.confirmed_by.display_name } : null,
            conditionNotes: x.condition_notes,
            photos: x.photos.map((p) => ({ id: p.id, url: urls.get(p.storage_path) ?? null, contentType: p.content_type, createdAt: p.created_at })),
          }
        : null;
      const authorizations = row.authorizations.map(toAuthorization);
      const extensions = row.extensions.map(toExtension);
      return {
        borrowRequestId: row.borrow_request_id,
        requestStatus: row.request_status,
        status: returnStatus(row.picked_up, ret),
        startDate: row.start_date,
        dueDate: row.due_date,
        originalDueDate: row.original_due_date,
        today: row.today,
        overdue: row.overdue,
        daysOverdue: daysOverdue(row.overdue, row.today, row.due_date),
        return: ret,
        authorizations,
        activeAuthorization: authorizations.find((a) => a.status === 'active') ?? null,
        extensions,
        pendingExtension: extensions.find((e) => e.status === 'pending') ?? null,
      } satisfies ReturnState;
    },

    async initiate(caller, requestId, { method, delivery }) {
      await rpc<string>(user(caller), 'initiate_return', {
        p_request_id: requestId,
        p_method: method,
        p_delivery_provider: delivery?.provider ?? null,
        p_delivery_reference: delivery?.reference ?? null,
        p_delivery_note: delivery?.note ?? null,
      });
    },

    async createAuthorization(caller, requestId, input): Promise<PickupAuthorization> {
      return toAuthorization(
        await rpc<AuthorizationRow>(user(caller), 'create_return_authorization', {
          p_request_id: requestId,
          p_token_hash: input.tokenHash,
          p_recipient_name: input.recipientName,
          p_recipient_phone: input.recipientPhone,
          p_note: input.note,
          p_ttl_hours: input.ttlHours,
        }),
      );
    },

    async revokeAuthorization(caller, requestId, authorizationId) {
      return toAuthorization(
        await rpc<AuthorizationRow>(user(caller), 'revoke_return_authorization', { p_request_id: requestId, p_authorization_id: authorizationId }),
      );
    },

    async verifyCode(caller, requestId, tokenHash) {
      return toAuthorization(await rpc<AuthorizationRow>(user(caller), 'verify_return_code', { p_request_id: requestId, p_token_hash: tokenHash }));
    },

    async confirm(caller, requestId, input) {
      const { data, error } = await db(
        'confirm_return',
        user(caller).rpc('confirm_return', {
          p_request_id: requestId,
          p_method: input.method,
          p_token_hash: input.tokenHash,
          p_condition_notes: input.conditionNotes,
        }),
      );
      // One return per request is the last line of defence.
      if (error?.code === '23505') throw returnError('NSR03')!;
      if (error) throw fail('confirm_return', error);
      return data as string;
    },

    async addPhoto(caller, requestId, returnId, file) {
      const client = user(caller);
      // Server-chosen name; Storage allows it only for the lender who
      // confirmed this return, within 24 hours. Never overwrites (upsert off).
      const path = `${requestId}/${returnId}/${randomUUID()}.${IMAGE_EXTENSIONS[file.contentType]}`;
      const { error: uploadError } = await timed(logger, 'storage.upload_return_photo', async () =>
        client.storage.from(RETURN_EVIDENCE_BUCKET).upload(path, file.data, { contentType: file.contentType, upsert: false }),
      );
      if (uploadError) {
        const status = Number((uploadError as { statusCode?: unknown }).statusCode ?? 0);
        logger.error({ operation: 'upload_return_photo', status }, 'storage request failed');
        if (/bucket not found/i.test(uploadError.message ?? '')) {
          throw AppError.unavailable('Photo storage is not set up on the server', 'STORAGE_NOT_CONFIGURED');
        }
        if (status === 403 || status === 401) throw AppError.forbidden('You cannot add photos to this return');
        throw AppError.unavailable('Photo storage is temporarily unavailable', 'STORAGE_UNAVAILABLE');
      }
      const { data, error } = await db(
        'add_return_photo',
        client
          .from('return_photos')
          .insert({ return_id: returnId, borrow_request_id: requestId, storage_path: path, content_type: file.contentType })
          .select('id, storage_path, content_type, created_at')
          .single<PhotoRow>(),
      );
      if (error) {
        // Never leave a file without its record.
        await client.storage.from(RETURN_EVIDENCE_BUCKET).remove([path]).catch(() => undefined);
        throw fail('add_return_photo', error);
      }
      const urls = await sign(client, RETURN_EVIDENCE_BUCKET, [path]);
      return { id: data.id, url: urls.get(path) ?? null, contentType: data.content_type, createdAt: data.created_at };
    },

    async requestExtension(caller, requestId, { requestedEndDate, reason }) {
      return toExtension(
        await rpc<ExtensionRow>(user(caller), 'request_extension', {
          p_request_id: requestId,
          p_requested_end_date: requestedEndDate,
          p_reason: reason,
        }),
      );
    },

    async decideExtension(caller, requestId, extensionId, decision) {
      return toExtension(
        await rpc<ExtensionRow>(user(caller), 'decide_extension', { p_request_id: requestId, p_extension_id: extensionId, p_decision: decision }),
      );
    },

    async listEvents(caller, limit) {
      const client = user(caller);
      const rows = await rpc<EventRow[]>(client, 'list_return_events', { p_limit: limit });
      const covers = await sign(
        client,
        LISTING_IMAGES_BUCKET,
        [...new Set(rows.map((r) => r.listing.cover_path).filter((p): p is string => Boolean(p)))],
      );
      return rows.map(
        (r): ReturnEvent => ({
          id: String(r.id),
          kind: r.kind,
          createdAt: r.created_at,
          actor: { id: r.actor.id, displayName: r.actor.display_name },
          recipientName: r.recipient_name,
          method: r.method,
          requestedEndDate: r.requested_end_date,
          request: { id: r.request.id, status: r.request.status, startDate: r.request.start_date, endDate: r.request.end_date, viewerRole: r.request.viewer_role },
          listing: { id: r.listing.id, title: r.listing.title, imageUrl: r.listing.cover_path ? (covers.get(r.listing.cover_path) ?? null) : null },
        }),
      );
    },
  };
}

// Used when the app is built without a return repository (some tests).
export function unconfiguredReturns(): ReturnRepository {
  const refuse = async (): Promise<never> => {
    throw AppError.unavailable('Returns are not configured on the server', 'SERVER_NOT_CONFIGURED');
  };
  return {
    getState: refuse,
    initiate: refuse,
    createAuthorization: refuse,
    revokeAuthorization: refuse,
    verifyCode: refuse,
    confirm: refuse,
    addPhoto: refuse,
    requestExtension: refuse,
    decideExtension: refuse,
    listEvents: refuse,
  };
}
