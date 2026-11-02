import React, { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import type { ApiClient } from '../lib/api/client';
import type { BorrowRequest, BorrowRequestInput, BorrowRequestPage, DateRange } from '../lib/api/types';
import type { SessionManager } from '../lib/auth/sessionManager';

export interface BorrowRequestsServices {
  api: ApiClient;
  sessionManager: SessionManager;
}

export type BorrowAction = 'accept' | 'decline' | 'cancel';

export interface BorrowRequestsContextValue {
  // Bumped after every successful change, so request lists reload.
  revision: number;
  create: (input: BorrowRequestInput) => Promise<BorrowRequest>;
  listOutgoing: () => Promise<BorrowRequestPage>;
  listIncoming: () => Promise<BorrowRequestPage>;
  act: (id: string, action: BorrowAction) => Promise<BorrowRequest>;
  bookedDates: (listingId: string) => Promise<DateRange[]>;
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
  const [{ api, sessionManager }] = useState<BorrowRequestsServices>(() => services ?? defaultServices());
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

  const value = useMemo<BorrowRequestsContextValue>(
    () => ({ revision, create, listOutgoing, listIncoming, act, bookedDates }),
    [revision, create, listOutgoing, listIncoming, act, bookedDates],
  );

  return <BorrowRequestsContext.Provider value={value}>{children}</BorrowRequestsContext.Provider>;
}

export function useBorrowRequests(): BorrowRequestsContextValue {
  const ctx = useContext(BorrowRequestsContext);
  if (!ctx) throw new Error('useBorrowRequests must be used within BorrowRequestsProvider');
  return ctx;
}
