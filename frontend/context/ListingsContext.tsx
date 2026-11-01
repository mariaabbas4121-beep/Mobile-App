import React, { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import type { ApiClient } from '../lib/api/client';
import type { Listing, ListingAvailability, ListingInput, ListingPage, ListingQuery } from '../lib/api/types';
import type { SessionManager } from '../lib/auth/sessionManager';
import type { LocalPhoto } from '../lib/listings/photos';

export interface ListingsServices {
  api: ApiClient;
  sessionManager: SessionManager;
}

// A save succeeded; some photos may not have uploaded.
export interface SaveResult {
  listing: Listing;
  failedPhotos: number;
  // First upload error, for the message shown to the user.
  photoError: unknown;
}

export interface ListingsContextValue {
  // Bumped after every successful change, so screens showing listings
  // reload from the server instead of patching local copies.
  revision: number;
  // The listing created most recently in this session, so the feed can say
  // when the user's own filters hide it. Cleared when it is archived.
  lastCreatedId: string | null;
  list: (query: ListingQuery) => Promise<ListingPage>;
  get: (id: string) => Promise<Listing>;
  create: (input: ListingInput, photos: LocalPhoto[]) => Promise<SaveResult>;
  update: (
    id: string,
    changes: Partial<ListingInput>,
    photos?: { add: LocalPhoto[]; removeIds: string[] },
  ) => Promise<SaveResult>;
  setAvailability: (id: string, availability: ListingAvailability) => Promise<Listing>;
  archive: (id: string) => Promise<Listing>;
}

const ListingsContext = createContext<ListingsContextValue | null>(null);

function defaultServices(): ListingsServices {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { api, sessionManager } = require('../lib/auth') as typeof import('../lib/auth');
  return { api, sessionManager };
}

// Listing data always comes from the API; nothing here is authoritative.
export function ListingsProvider({ children, services }: { children: ReactNode; services?: ListingsServices }) {
  const [{ api, sessionManager }] = useState<ListingsServices>(() => services ?? defaultServices());
  const [revision, setRevision] = useState(0);
  const [lastCreatedId, setLastCreatedId] = useState<string | null>(null);
  const changed = useCallback(() => setRevision((r) => r + 1), []);

  // Reads are public but carry the session when there is one, so owners
  // also see their own archived listings.
  const read = useCallback(
    <T,>(call: (token?: string) => Promise<T>): Promise<T> =>
      sessionManager.current ? sessionManager.authorized((t) => call(t)) : call(),
    [sessionManager],
  );

  // Uploads one at a time, so a slow connection is not flooded and a
  // failure leaves the rest of the listing intact.
  const uploadPhotos = useCallback(
    async (id: string, photos: LocalPhoto[]) => {
      let failed = 0;
      let firstError: unknown = null;
      for (const photo of photos) {
        try {
          await sessionManager.authorized((t) => api.uploadItemImage(t, id, photo.uri, photo.type));
        } catch (err) {
          failed += 1;
          firstError ??= err;
        }
      }
      return { failed, firstError };
    },
    [api, sessionManager],
  );

  const list = useCallback((query: ListingQuery) => read((t) => api.listItems(query, t)), [api, read]);
  const get = useCallback(async (id: string) => (await read((t) => api.getItem(id, t))).listing, [api, read]);

  const create = useCallback(
    async (input: ListingInput, photos: LocalPhoto[]): Promise<SaveResult> => {
      const { listing } = await sessionManager.authorized((t) => api.createItem(t, input));
      // The listing exists from here on, whatever happens to the photos.
      setLastCreatedId(listing.id);
      changed();
      if (photos.length === 0) return { listing, failedPhotos: 0, photoError: null };
      const { failed, firstError } = await uploadPhotos(listing.id, photos);
      const latest = await get(listing.id).catch(() => listing);
      changed();
      return { listing: latest, failedPhotos: failed, photoError: firstError };
    },
    [api, sessionManager, uploadPhotos, get, changed],
  );

  const update = useCallback(
    async (id: string, changes: Partial<ListingInput>, photos = { add: [] as LocalPhoto[], removeIds: [] as string[] }) => {
      let listing: Listing | null = null;
      if (Object.keys(changes).length > 0) {
        listing = (await sessionManager.authorized((t) => api.updateItem(t, id, changes))).listing;
        changed();
      }
      for (const imageId of photos.removeIds) {
        await sessionManager.authorized((t) => api.deleteItemImage(t, id, imageId));
        changed();
      }
      const { failed, firstError } = await uploadPhotos(id, photos.add);
      if (photos.add.length > 0 || photos.removeIds.length > 0 || !listing) {
        listing = await get(id);
        changed();
      }
      return { listing, failedPhotos: failed, photoError: firstError };
    },
    [api, sessionManager, uploadPhotos, get, changed],
  );

  const setAvailability = useCallback(
    async (id: string, availability: ListingAvailability) => {
      const { listing } = await sessionManager.authorized((t) => api.updateItem(t, id, { availability }));
      changed();
      return listing;
    },
    [api, sessionManager, changed],
  );

  const archive = useCallback(
    async (id: string) => {
      const { listing } = await sessionManager.authorized((t) => api.archiveItem(t, id));
      setLastCreatedId((current) => (current === id ? null : current));
      changed();
      return listing;
    },
    [api, sessionManager, changed],
  );

  const value = useMemo<ListingsContextValue>(
    () => ({ revision, lastCreatedId, list, get, create, update, setAvailability, archive }),
    [revision, lastCreatedId, list, get, create, update, setAvailability, archive],
  );

  return <ListingsContext.Provider value={value}>{children}</ListingsContext.Provider>;
}

export function useListings(): ListingsContextValue {
  const ctx = useContext(ListingsContext);
  if (!ctx) throw new Error('useListings must be used within ListingsProvider');
  return ctx;
}
