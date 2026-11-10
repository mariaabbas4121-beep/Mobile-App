import React, { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import type { ApiClient } from '../lib/api/client';
import type {
  ActivityFeed,
  BorrowRequest,
  BorrowRequestInput,
  BorrowRequestPage,
  CreatedPickupAuthorization,
  DateRange,
  Handover,
  HandoverConfirmation,
  HandoverPhoto,
  HandoverState,
  PickupAuthorization,
  PickupAuthorizationInput,
  DueDateExtension,
  ImageUploadType,
  ItemReturn,
  ReturnConfirmation,
  ReturnInitiation,
  ReturnState,
} from '../lib/api/types';
import type { SessionManager } from '../lib/auth/sessionManager';
import { secureStorePickupCodes, type PickupCodeStore } from '../lib/handover/codeStore';
import type { LocalPhoto } from '../lib/listings/photos';

export interface BorrowRequestsServices {
  api: ApiClient;
  sessionManager: SessionManager;
  // Where the borrower's copy of a pickup code is kept. Defaults to the
  // device's secure storage.
  pickupCodes?: PickupCodeStore;
}

export type BorrowAction = 'accept' | 'decline' | 'cancel';

// Photos that reached the server, and how many did not.
export interface EvidenceResult {
  saved: HandoverPhoto[];
  failed: LocalPhoto[];
  firstError: unknown;
}

export interface BorrowRequestsContextValue {
  // Bumped after every successful change, so request lists reload.
  revision: number;
  create: (input: BorrowRequestInput) => Promise<BorrowRequest>;
  listOutgoing: () => Promise<BorrowRequestPage>;
  listIncoming: () => Promise<BorrowRequestPage>;
  get: (id: string) => Promise<BorrowRequest>;
  act: (id: string, action: BorrowAction) => Promise<BorrowRequest>;
  bookedDates: (listingId: string) => Promise<DateRange[]>;
  // The signed-in user's recent activity (requests, chats, own listings, pickup).
  activity: () => Promise<ActivityFeed>;

  // Pickup and handover (Phase 3B.1). The server decides every rule.
  handover: (requestId: string) => Promise<HandoverState>;
  // Borrower. The code is kept on this device so the QR can be shown again.
  authorizePickup: (requestId: string, input: PickupAuthorizationInput) => Promise<CreatedPickupAuthorization>;
  revokePickup: (requestId: string, authorizationId: string) => Promise<PickupAuthorization>;
  // This device's copy of an authorization's code, if it has one.
  storedPickupCode: (authorizationId: string) => Promise<string | null>;
  // Lender.
  verifyPickupCode: (requestId: string, code: string) => Promise<PickupAuthorization>;
  confirmHandover: (requestId: string, confirmation: HandoverConfirmation) => Promise<Handover>;
  // One at a time; never reports a photo as saved unless the server stored it.
  uploadEvidence: (requestId: string, photos: LocalPhoto[]) => Promise<EvidenceResult>;

  // Returns and due dates (Phase 3B.2). The server decides every rule.
  returnState: (requestId: string) => Promise<ReturnState>;
  // Borrower: in person or by delivery.
  initiateReturn: (requestId: string, input: ReturnInitiation) => Promise<ReturnState>;
  // Borrower: someone else returns it. Replaces an earlier unused return code.
  authorizeReturn: (requestId: string, input: PickupAuthorizationInput) => Promise<CreatedPickupAuthorization>;
  revokeReturn: (requestId: string, authorizationId: string) => Promise<PickupAuthorization>;
  // Lender.
  verifyReturnCode: (requestId: string, code: string) => Promise<PickupAuthorization>;
  confirmReturn: (requestId: string, confirmation: ReturnConfirmation) => Promise<ItemReturn>;
  uploadReturnEvidence: (requestId: string, photos: LocalPhoto[]) => Promise<EvidenceResult>;
  // Borrower asks; lender decides. Only an approval moves the due date.
  requestExtension: (requestId: string, input: { requestedEndDate: string; reason?: string | null }) => Promise<DueDateExtension>;
  decideExtension: (requestId: string, extensionId: string, decision: 'approve' | 'reject') => Promise<DueDateExtension>;
}

const BorrowRequestsContext = createContext<BorrowRequestsContextValue | null>(null);

function defaultServices(): BorrowRequestsServices {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { api, sessionManager } = require('../lib/auth') as typeof import('../lib/auth');
  return { api, sessionManager };
}

// Request state always comes from the server; the database decides every
// transition (including whether dates are still free when accepting).
export function BorrowRequestsProvider({ children, services }: { children: ReactNode; services?: BorrowRequestsServices }) {
  const [{ api, sessionManager, pickupCodes: codes }] = useState<BorrowRequestsServices>(() => services ?? defaultServices());
  const [pickupCodes] = useState<PickupCodeStore>(() => codes ?? secureStorePickupCodes());
  const [revision, setRevision] = useState(0);
  const changed = useCallback(() => setRevision((r) => r + 1), []);

  const create = useCallback(
    async (input: BorrowRequestInput) => {
      const { request } = await sessionManager.authorized((t) => api.createBorrowRequest(t, input));
      changed();
      return request;
    },
    [api, sessionManager, changed],
  );

  const listOutgoing = useCallback(
    () => sessionManager.authorized((t) => api.listOutgoingRequests(t, { pageSize: 50 })),
    [api, sessionManager],
  );
  const listIncoming = useCallback(
    () => sessionManager.authorized((t) => api.listIncomingRequests(t, { pageSize: 50 })),
    [api, sessionManager],
  );
  const get = useCallback(
    async (id: string) => (await sessionManager.authorized((t) => api.getBorrowRequest(t, id))).request,
    [api, sessionManager],
  );

  const act = useCallback(
    async (id: string, action: BorrowAction) => {
      try {
        const { request } = await sessionManager.authorized((t) => api.decideBorrowRequest(t, id, action));
        return request;
      } finally {
        // Reload either way: a failed accept (dates taken, already answered)
        // also means the list on screen is out of date.
        changed();
      }
    },
    [api, sessionManager, changed],
  );

  const bookedDates = useCallback(
    async (listingId: string) =>
      (
        await (sessionManager.current
          ? sessionManager.authorized((t) => api.getBookedDates(listingId, t))
          : api.getBookedDates(listingId))
      ).bookedDates,
    [api, sessionManager],
  );

  const activity = useCallback(() => sessionManager.authorized((t) => api.getActivity(t, { limit: 50 })), [api, sessionManager]);

  const handover = useCallback(
    async (requestId: string) => (await sessionManager.authorized((t) => api.getHandover(t, requestId))).handover,
    [api, sessionManager],
  );

  const authorizePickup = useCallback(
    async (requestId: string, input: PickupAuthorizationInput) => {
      const created = await sessionManager.authorized((t) => api.createPickupAuthorization(t, requestId, input));
      // Losing the local copy only means the QR cannot be shown again here.
      await pickupCodes.save(created.authorization.id, created.code).catch(() => undefined);
      changed();
      return created;
    },
    [api, sessionManager, pickupCodes, changed],
  );

  const revokePickup = useCallback(
    async (requestId: string, authorizationId: string) => {
      const { authorization } = await sessionManager.authorized((t) => api.revokePickupAuthorization(t, requestId, authorizationId));
      await pickupCodes.remove(authorizationId);
      changed();
      return authorization;
    },
    [api, sessionManager, pickupCodes, changed],
  );

  const storedPickupCode = useCallback((authorizationId: string) => pickupCodes.load(authorizationId), [pickupCodes]);

  const verifyPickupCode = useCallback(
    async (requestId: string, code: string) =>
      (await sessionManager.authorized((t) => api.verifyPickupCode(t, requestId, code))).authorization,
    [api, sessionManager],
  );

  const confirmHandover = useCallback(
    async (requestId: string, confirmation: HandoverConfirmation) => {
      const result = await sessionManager.authorized((t) => api.confirmHandover(t, requestId, confirmation));
      changed();
      return result.handover;
    },
    [api, sessionManager, changed],
  );

  // One at a time, so a failure leaves the rest intact and is reported.
  const uploadAll = useCallback(
    async (
      photos: LocalPhoto[],
      send: (token: string, photo: { uri: string; type: ImageUploadType }) => Promise<{ photo: HandoverPhoto }>,
    ): Promise<EvidenceResult> => {
      const saved: HandoverPhoto[] = [];
      const failed: LocalPhoto[] = [];
      let firstError: unknown = null;
      for (const photo of photos) {
        try {
          saved.push((await sessionManager.authorized((t) => send(t, photo))).photo);
        } catch (err) {
          failed.push(photo);
          firstError ??= err;
        }
      }
      if (saved.length > 0) changed();
      return { saved, failed, firstError };
    },
    [sessionManager, changed],
  );

  const uploadEvidence = useCallback(
    (requestId: string, photos: LocalPhoto[]) => uploadAll(photos, (t, p) => api.uploadHandoverPhoto(t, requestId, p.uri, p.type)),
    [api, uploadAll],
  );

  const returnState = useCallback(
    async (requestId: string) => (await sessionManager.authorized((t) => api.getReturn(t, requestId))).return,
    [api, sessionManager],
  );

  const initiateReturn = useCallback(
    async (requestId: string, input: ReturnInitiation) => {
      const result = await sessionManager.authorized((t) => api.initiateReturn(t, requestId, input));
      changed();
      return result.return;
    },
    [api, sessionManager, changed],
  );

  const authorizeReturn = useCallback(
    async (requestId: string, input: PickupAuthorizationInput) => {
      const created = await sessionManager.authorized((t) => api.createReturnAuthorization(t, requestId, input));
      await pickupCodes.save(created.authorization.id, created.code).catch(() => undefined);
      changed();
      return created;
    },
    [api, sessionManager, pickupCodes, changed],
  );

  const revokeReturn = useCallback(
    async (requestId: string, authorizationId: string) => {
      const { authorization } = await sessionManager.authorized((t) => api.revokeReturnAuthorization(t, requestId, authorizationId));
      await pickupCodes.remove(authorizationId);
      changed();
      return authorization;
    },
    [api, sessionManager, pickupCodes, changed],
  );

  const verifyReturnCode = useCallback(
    async (requestId: string, code: string) => (await sessionManager.authorized((t) => api.verifyReturnCode(t, requestId, code))).authorization,
    [api, sessionManager],
  );

  const confirmReturn = useCallback(
    async (requestId: string, confirmation: ReturnConfirmation) => {
      const result = await sessionManager.authorized((t) => api.confirmReturn(t, requestId, confirmation));
      changed();
      return result.return;
    },
    [api, sessionManager, changed],
  );

  const uploadReturnEvidence = useCallback(
    (requestId: string, photos: LocalPhoto[]) => uploadAll(photos, (t, p) => api.uploadReturnPhoto(t, requestId, p.uri, p.type)),
    [api, uploadAll],
  );

  const requestExtension = useCallback(
    async (requestId: string, input: { requestedEndDate: string; reason?: string | null }) => {
      const { extension } = await sessionManager.authorized((t) => api.requestExtension(t, requestId, input));
      changed();
      return extension;
    },
    [api, sessionManager, changed],
  );

  const decideExtension = useCallback(
    async (requestId: string, extensionId: string, decision: 'approve' | 'reject') => {
      const { extension } = await sessionManager.authorized((t) => api.decideExtension(t, requestId, extensionId, decision));
      changed();
      return extension;
    },
    [api, sessionManager, changed],
  );

  const value = useMemo<BorrowRequestsContextValue>(
    () => ({
      revision,
      create,
      listOutgoing,
      listIncoming,
      get,
      act,
      bookedDates,
      activity,
      handover,
      authorizePickup,
      revokePickup,
      storedPickupCode,
      verifyPickupCode,
      confirmHandover,
      uploadEvidence,
      returnState,
      initiateReturn,
      authorizeReturn,
      revokeReturn,
      verifyReturnCode,
      confirmReturn,
      uploadReturnEvidence,
      requestExtension,
      decideExtension,
    }),
    [
      revision,
      create,
      listOutgoing,
      listIncoming,
      get,
      act,
      bookedDates,
      activity,
      handover,
      authorizePickup,
      revokePickup,
      storedPickupCode,
      verifyPickupCode,
      confirmHandover,
      uploadEvidence,
      returnState,
      initiateReturn,
      authorizeReturn,
      revokeReturn,
      verifyReturnCode,
      confirmReturn,
      uploadReturnEvidence,
      requestExtension,
      decideExtension,
    ],
  );

  return <BorrowRequestsContext.Provider value={value}>{children}</BorrowRequestsContext.Provider>;
}

export function useBorrowRequests(): BorrowRequestsContextValue {
  const ctx = useContext(BorrowRequestsContext);
  if (!ctx) throw new Error('useBorrowRequests must be used within BorrowRequestsProvider');
  return ctx;
}
