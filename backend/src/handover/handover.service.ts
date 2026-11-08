import type { Logger } from '../lib/logger.js';
import { AppError } from '../lib/errors.js';
import type { BorrowRequestRepository } from '../borrow/borrow.types.js';
import type { Caller, ImageContentType } from '../listings/listing.types.js';
import { MAX_HANDOVER_PHOTOS, type AuthorizationCreateBody, type HandoverConfirmBody } from './handover.schemas.js';
import { formatPickupCode, generatePickupCode, hashPickupCode, pickupQrPayload } from './pickup-code.js';
import type { Handover, HandoverPhoto, HandoverRepository, HandoverState, PickupAuthorization } from './handover.types.js';

// A content-free "this request's handover changed" for both participants'
// live connections (the Socket.IO server). Published after the change is
// stored. In-process, like ChatEvents.
export interface HandoverChangedEvent {
  borrowRequestId: string;
  participantIds: string[];
}

export interface HandoverEvents {
  publish(event: HandoverChangedEvent): void;
  subscribe(listener: (event: HandoverChangedEvent) => void): () => void;
}

export function createHandoverEvents(logger: Logger): HandoverEvents {
  const listeners = new Set<(event: HandoverChangedEvent) => void>();
  return {
    publish(event) {
      for (const listener of listeners) {
        try {
          listener(event);
        } catch (err) {
          // A failed hint never fails the change: it is already stored.
          logger.error({ err }, 'handover event listener failed');
        }
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export interface CreatedAuthorization {
  authorization: PickupAuthorization;
  // Shown once. Only its hash is stored.
  code: string;
  // "ABCD-EFGH-...", for typing when a QR cannot be scanned.
  displayCode: string;
  // What the QR encodes.
  qrPayload: string;
}

export interface HandoverServiceDeps {
  repository: HandoverRepository;
  borrowRequests: BorrowRequestRepository;
  events: HandoverEvents;
  authorizationTtlHours: number;
}

const notFound = () => AppError.notFound('Borrow request not found', 'BORROW_REQUEST_NOT_FOUND');

// Pickup and handover. The rules live in the database functions, which run
// them atomically; this layer creates and hashes codes, and announces changes.
export function createHandoverService({ repository, borrowRequests, events, authorizationTtlHours }: HandoverServiceDeps) {
  async function state(caller: Caller, requestId: string): Promise<HandoverState> {
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
      return { authorization, code, displayCode: formatPickupCode(code), qrPayload: pickupQrPayload(code) };
    },

    async revoke(caller: Caller, requestId: string, authorizationId: string): Promise<PickupAuthorization> {
      const authorization = await repository.revokeAuthorization(caller, requestId, authorizationId);
      await announce(caller, requestId);
      return authorization;
    },

    // Lender: what the code authorizes. Changes nothing.
    verify: (caller: Caller, requestId: string, code: string) => repository.verifyCode(caller, requestId, hashPickupCode(code)),

    async confirm(caller: Caller, requestId: string, body: HandoverConfirmBody): Promise<Handover> {
      await repository.confirm(caller, requestId, {
        method: body.method,
        tokenHash: body.method === 'authorized' ? hashPickupCode(body.code) : null,
        conditionNotes: body.conditionNotes ?? null,
      });
      await announce(caller, requestId);
      const { handover } = await state(caller, requestId);
      if (!handover) throw AppError.unavailable('Data service is temporarily unavailable', 'DATABASE_UNAVAILABLE');
      return handover;
    },

    async addPhoto(caller: Caller, requestId: string, file: { data: Buffer; contentType: ImageContentType }): Promise<HandoverPhoto> {
      const { handover } = await state(caller, requestId);
      if (!handover) throw AppError.conflict('HANDOVER_NOT_CONFIRMED', 'Confirm the handover before adding condition photos');
      if (handover.confirmedBy.id !== caller.userId) throw AppError.forbidden('Only the lender who confirmed the handover can add photos');
      if (handover.photos.length >= MAX_HANDOVER_PHOTOS) {
        throw AppError.conflict('EVIDENCE_LIMIT_REACHED', `At most ${MAX_HANDOVER_PHOTOS} condition photos can be added`);
      }
      const photo = await repository.addPhoto(caller, requestId, handover.id, file);
      await announce(caller, requestId);
      return photo;
    },
  };
}

export type HandoverService = ReturnType<typeof createHandoverService>;
