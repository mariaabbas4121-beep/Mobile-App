import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { SupabaseClients } from '../config/supabase.js';
import type { Logger } from '../lib/logger.js';
import { AppError } from '../lib/errors.js';
import { timed } from '../lib/timing.js';
import { IMAGE_EXTENSIONS } from '../listings/listing.schemas.js';
import { LISTING_IMAGES_BUCKET, SIGNED_URL_TTL_SECONDS } from '../listings/supabase-listing.repository.js';
import type { BorrowRole, BorrowStatus } from '../borrow/borrow.types.js';
import type {
  Handover,
  HandoverEvent,
  HandoverEventKind,
  HandoverMethod,
  HandoverRepository,
  HandoverState,
  PickupAuthorization,
  PickupAuthorizationStatus,
} from './handover.types.js';

export const HANDOVER_EVIDENCE_BUCKET = 'handover-evidence';

interface AuthorizationRow {
  id: string;
  borrow_request_id: string;
  operation: 'pickup';
  status: PickupAuthorizationStatus;
  recipient_name: string;
  recipient_phone: string | null;
  note: string | null;
  expires_at: string;
  created_at: string;
  revoked_at: string | null;
  redeemed_at: string | null;
}

interface PhotoRow {
  id: string;
  storage_path: string;
  content_type: string;
  created_at: string;
}

interface StateRow {
  borrow_request_id: string;
  request_status: BorrowStatus;
  handover: {
    id: string;
    method: HandoverMethod;
    authorization_id: string | null;
    recipient_name: string | null;
    recipient_phone: string | null;
    condition_notes: string | null;
    confirmed_at: string;
    confirmed_by: { id: string; display_name: string | null };
    photos: PhotoRow[];
  } | null;
  authorizations: AuthorizationRow[];
}

interface EventRow {
  id: number | string;
  kind: HandoverEventKind;
  created_at: string;
  actor: { id: string; display_name: string | null };
  recipient_name: string | null;
  method: HandoverMethod | null;
  request: { id: string; status: BorrowStatus; start_date: string; end_date: string; viewer_role: BorrowRole };
  listing: { id: string; title: string; cover_path: string | null };
}

export const toAuthorization = (r: AuthorizationRow): PickupAuthorization => ({
  id: r.id,
  borrowRequestId: r.borrow_request_id,
  operation: r.operation,
  status: r.status,
  recipientName: r.recipient_name,
  recipientPhone: r.recipient_phone,
  note: r.note,
  expiresAt: r.expires_at,
  createdAt: r.created_at,
  revokedAt: r.revoked_at,
  redeemedAt: r.redeemed_at,
});

// SQLSTATEs raised by 20261108120000_pickup_handover.sql.
export function handoverError(code: string | undefined): AppError | null {
  switch (code) {
    case 'NSH01':
      return AppError.notFound('Borrow request not found', 'BORROW_REQUEST_NOT_FOUND');
    case '42501':
      return AppError.forbidden('You cannot do this for this request');
    case 'NSH03':
      return AppError.conflict('REQUEST_NOT_ACCEPTED', 'Pickup is only possible for an accepted request');
    case 'NSH04':
      return AppError.conflict('ALREADY_HANDED_OVER', 'This item has already been handed over');
    case 'NSH05':
      return AppError.conflict('ACTIVE_AUTHORIZATION_EXISTS', 'Revoke the current pickup authorization before creating another');
    case 'NSH06':
      return AppError.conflict('AUTHORIZATION_NOT_ACTIVE', 'This authorization is no longer active');
    case 'NSH07':
      return AppError.badRequest('INVALID_PICKUP_CODE', 'This is not a valid pickup code for this request');
    case 'NSH08':
      return AppError.conflict('AUTHORIZATION_REVOKED', 'The borrower revoked this pickup authorization');
    case 'NSH09':
      return AppError.conflict('AUTHORIZATION_ALREADY_USED', 'This pickup code has already been used');
    case 'NSH10':
      return AppError.conflict('AUTHORIZATION_EXPIRED', 'This pickup code has expired');
    case 'NSH11':
      return AppError.conflict('EVIDENCE_LIMIT_REACHED', 'At most 5 condition photos can be added');
    case 'NSH12':
      return AppError.conflict('EVIDENCE_WINDOW_CLOSED', 'Condition photos can only be added within 24 hours of the handover');
    case '22023':
      return AppError.badRequest('VALIDATION_ERROR', 'Request validation failed');
    default:
      return null;
  }
}

export function createSupabaseHandoverRepository(clients: SupabaseClients, logger: Logger): HandoverRepository {
  // Error codes only: arguments include a code hash and personal details.
  const fail = (operation: string, error: { code?: string }) => {
    const mapped = handoverError(error.code);
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

  return {
    async getState(caller, requestId) {
      const client = clients.forUser(caller.accessToken);
      const row = await rpc<StateRow | null>(client, 'get_handover_state', { p_request_id: requestId });
      if (!row) return null;
      const h = row.handover;
      const urls = await sign(client, HANDOVER_EVIDENCE_BUCKET, h ? h.photos.map((p) => p.storage_path) : []);
      const authorizations = row.authorizations.map(toAuthorization);
      const handover: Handover | null = h
        ? {
            id: h.id,
            method: h.method,
            authorizationId: h.authorization_id,
            recipientName: h.recipient_name,
            recipientPhone: h.recipient_phone,
            conditionNotes: h.condition_notes,
            confirmedAt: h.confirmed_at,
            confirmedBy: { id: h.confirmed_by.id, displayName: h.confirmed_by.display_name },
            photos: h.photos.map((p) => ({ id: p.id, url: urls.get(p.storage_path) ?? null, contentType: p.content_type, createdAt: p.created_at })),
          }
        : null;
      return {
        borrowRequestId: row.borrow_request_id,
        requestStatus: row.request_status,
        status: handover ? 'completed' : 'pending',
        handover,
        authorizations,
        activeAuthorization: authorizations.find((a) => a.status === 'active') ?? null,
      } satisfies HandoverState;
    },

    async createAuthorization(caller, requestId, input) {
      const row = await rpc<AuthorizationRow>(clients.forUser(caller.accessToken), 'create_pickup_authorization', {
        p_request_id: requestId,
        p_token_hash: input.tokenHash,
        p_recipient_name: input.recipientName,
        p_recipient_phone: input.recipientPhone,
        p_note: input.note,
        p_ttl_hours: input.ttlHours,
      });
      return toAuthorization(row);
    },

    async revokeAuthorization(caller, requestId, authorizationId) {
      const row = await rpc<AuthorizationRow>(clients.forUser(caller.accessToken), 'revoke_pickup_authorization', {
        p_request_id: requestId,
        p_authorization_id: authorizationId,
      });
      return toAuthorization(row);
    },

    async verifyCode(caller, requestId, tokenHash) {
      const row = await rpc<AuthorizationRow>(clients.forUser(caller.accessToken), 'verify_pickup_code', {
        p_request_id: requestId,
        p_token_hash: tokenHash,
      });
      return toAuthorization(row);
    },

    async confirm(caller, requestId, input) {
      const client = clients.forUser(caller.accessToken);
      const { data, error } = await db(
        'confirm_handover',
        client.rpc('confirm_handover', {
          p_request_id: requestId,
          p_method: input.method,
          p_token_hash: input.tokenHash,
          p_condition_notes: input.conditionNotes,
        }),
      );
      // The unique handover per request is the last line of defence.
      if (error?.code === '23505') throw handoverError('NSH04')!;
      if (error) throw fail('confirm_handover', error);
      return data as string;
    },

    async addPhoto(caller, requestId, handoverId, file) {
      const client = clients.forUser(caller.accessToken);
      // Server-chosen name; Storage policies allow it only for the lender who
      // confirmed this handover, within 24 hours.
      const path = `${requestId}/${handoverId}/${randomUUID()}.${IMAGE_EXTENSIONS[file.contentType]}`;
      const { error: uploadError } = await timed(logger, 'storage.upload_handover_photo', async () =>
        client.storage.from(HANDOVER_EVIDENCE_BUCKET).upload(path, file.data, { contentType: file.contentType, upsert: false }),
      );
      if (uploadError) {
        const status = Number((uploadError as { statusCode?: unknown }).statusCode ?? 0);
        logger.error({ operation: 'upload_handover_photo', status }, 'storage request failed');
        if (/bucket not found/i.test(uploadError.message ?? '')) {
          throw AppError.unavailable('Photo storage is not set up on the server', 'STORAGE_NOT_CONFIGURED');
        }
        if (status === 403 || status === 401) throw AppError.forbidden('You cannot add photos to this handover');
        throw AppError.unavailable('Photo storage is temporarily unavailable', 'STORAGE_UNAVAILABLE');
      }

      const { data, error } = await db(
        'add_handover_photo',
        client
          .from('handover_photos')
          .insert({ handover_id: handoverId, borrow_request_id: requestId, storage_path: path, content_type: file.contentType })
          .select('id, storage_path, content_type, created_at')
          .single<PhotoRow>(),
      );
      if (error) {
        // Never leave a file without its record.
        await client.storage.from(HANDOVER_EVIDENCE_BUCKET).remove([path]).catch(() => undefined);
        throw fail('add_handover_photo', error);
      }
      const urls = await sign(client, HANDOVER_EVIDENCE_BUCKET, [path]);
      return { id: data.id, url: urls.get(path) ?? null, contentType: data.content_type, createdAt: data.created_at };
    },

    async listEvents(caller, limit) {
      const client = clients.forUser(caller.accessToken);
      const rows = await rpc<EventRow[]>(client, 'list_handover_events', { p_limit: limit });
      const covers = await sign(
        client,
        LISTING_IMAGES_BUCKET,
        [...new Set(rows.map((r) => r.listing.cover_path).filter((p): p is string => Boolean(p)))],
      );
      return rows.map(
        (r): HandoverEvent => ({
          id: String(r.id),
          kind: r.kind,
          createdAt: r.created_at,
          actor: { id: r.actor.id, displayName: r.actor.display_name },
          recipientName: r.recipient_name,
          method: r.method,
          request: {
            id: r.request.id,
            status: r.request.status,
            startDate: r.request.start_date,
            endDate: r.request.end_date,
            viewerRole: r.request.viewer_role,
          },
          listing: { id: r.listing.id, title: r.listing.title, imageUrl: r.listing.cover_path ? (covers.get(r.listing.cover_path) ?? null) : null },
        }),
      );
    },
  };
}

// Used when the app is built without a handover repository (some tests).
export function unconfiguredHandovers(): HandoverRepository {
  const refuse = async (): Promise<never> => {
    throw AppError.unavailable('Handovers are not configured on the server', 'SERVER_NOT_CONFIGURED');
  };
  return {
    getState: refuse,
    createAuthorization: refuse,
    revokeAuthorization: refuse,
    verifyCode: refuse,
    confirm: refuse,
    addPhoto: refuse,
    listEvents: refuse,
  };
}
