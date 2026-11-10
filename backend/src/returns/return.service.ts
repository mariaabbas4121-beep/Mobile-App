import { AppError } from '../lib/errors.js';
import type { BorrowRequestRepository } from '../borrow/borrow.types.js';
import type { Caller, ImageContentType } from '../listings/listing.types.js';
import type { HandoverEvents, CreatedAuthorization } from '../handover/handover.service.js';
import type { AuthorizationCreateBody } from '../handover/handover.schemas.js';
import { MAX_HANDOVER_PHOTOS } from '../handover/handover.schemas.js';
import type { HandoverPhoto, PickupAuthorization } from '../handover/handover.types.js';
import { formatPickupCode, generatePickupCode, hashPickupCode, returnQrPayload } from '../handover/pickup-code.js';
import type { ExtensionRequestBody, ReturnConfirmBody, ReturnInitiateBody } from './return.schemas.js';
import type { DueDateExtension, ItemReturn, ReturnRepository, ReturnState } from './return.types.js';

export interface ReturnServiceDeps {
  repository: ReturnRepository;
  borrowRequests: BorrowRequestRepository;
  // Same content-free bus shape as pickups; announced as "return:updated".
  events: HandoverEvents;
  authorizationTtlHours: number;
}

const notFound = () => AppError.notFound('Borrow request not found', 'BORROW_REQUEST_NOT_FOUND');

// Returns and due-date extensions. The rules live in the database functions,
// which apply them atomically; this layer creates and hashes codes and
// announces changes to both participants.
export function createReturnService({ repository, borrowRequests, events, authorizationTtlHours }: ReturnServiceDeps) {
  async function state(caller: Caller, requestId: string): Promise<ReturnState> {
    const s = await repository.getState(caller, requestId);
    if (!s) throw notFound();
    return s;
  }

  // Participants come from the stored request, never from the client.
  async function announce(caller: Caller, requestId: string) {
    const request = await borrowRequests.get(caller, requestId).catch(() => null);
    if (request) events.publish({ borrowRequestId: requestId, participantIds: [request.borrower.id, request.lender.id] });
  }

  return {
    state,

    async initiate(caller: Caller, requestId: string, body: ReturnInitiateBody): Promise<ReturnState> {
      await repository.initiate(caller, requestId, {
        method: body.method,
        delivery:
          body.method === 'delivery'
            ? { provider: body.deliveryProvider ?? null, reference: body.deliveryReference ?? null, note: body.deliveryNote ?? null }
            : null,
      });
      await announce(caller, requestId);
      return state(caller, requestId);
    },

    // The code is in this response only. A new one replaces (revokes) an
    // earlier unused return code.
    async authorize(caller: Caller, requestId: string, body: AuthorizationCreateBody): Promise<CreatedAuthorization> {
      const code = generatePickupCode();
      const authorization = await repository.createAuthorization(caller, requestId, {
        recipientName: body.recipientName,
        recipientPhone: body.recipientPhone ?? null,
        note: body.note ?? null,
        tokenHash: hashPickupCode(code),
        ttlHours: authorizationTtlHours,
      });
      await announce(caller, requestId);
      return { authorization, code, displayCode: formatPickupCode(code), qrPayload: returnQrPayload(code) };
    },

    async revoke(caller: Caller, requestId: string, authorizationId: string): Promise<PickupAuthorization> {
      const authorization = await repository.revokeAuthorization(caller, requestId, authorizationId);
      await announce(caller, requestId);
      return authorization;
    },

    // Lender: what the code authorizes. Changes nothing.
    verify: (caller: Caller, requestId: string, code: string) => repository.verifyCode(caller, requestId, hashPickupCode(code)),

    async confirm(caller: Caller, requestId: string, body: ReturnConfirmBody): Promise<ItemReturn> {
      await repository.confirm(caller, requestId, {
        method: body.method,
        tokenHash: body.method === 'authorized' ? hashPickupCode(body.code) : null,
        conditionNotes: body.conditionNotes ?? null,
      });
      await announce(caller, requestId);
      const s = await state(caller, requestId);
      if (!s.return?.confirmedAt) throw AppError.unavailable('Data service is temporarily unavailable', 'DATABASE_UNAVAILABLE');
      return s.return;
    },

    async addPhoto(caller: Caller, requestId: string, file: { data: Buffer; contentType: ImageContentType }): Promise<HandoverPhoto> {
      const { return: ret } = await state(caller, requestId);
      if (!ret?.confirmedAt) throw AppError.conflict('RETURN_NOT_CONFIRMED', 'Confirm receipt before adding condition photos');
      if (ret.confirmedBy?.id !== caller.userId) throw AppError.forbidden('Only the lender who confirmed the return can add photos');
      if (ret.photos.length >= MAX_HANDOVER_PHOTOS) {
        throw AppError.conflict('EVIDENCE_LIMIT_REACHED', `At most ${MAX_HANDOVER_PHOTOS} condition photos can be added`);
      }
      const photo = await repository.addPhoto(caller, requestId, ret.id, file);
      await announce(caller, requestId);
      return photo;
    },

    async requestExtension(caller: Caller, requestId: string, body: ExtensionRequestBody): Promise<DueDateExtension> {
      const extension = await repository.requestExtension(caller, requestId, { requestedEndDate: body.requestedEndDate, reason: body.reason ?? null });
      await announce(caller, requestId);
      return extension;
    },

    async decideExtension(caller: Caller, requestId: string, extensionId: string, decision: 'approved' | 'rejected'): Promise<DueDateExtension> {
      const extension = await repository.decideExtension(caller, requestId, extensionId, decision);
      await announce(caller, requestId);
      return extension;
    },
  };
}

export type ReturnService = ReturnType<typeof createReturnService>;
