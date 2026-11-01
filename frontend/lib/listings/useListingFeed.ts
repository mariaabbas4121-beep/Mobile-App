import { useCallback, useEffect, useRef, useState } from 'react';
import { useListings } from '../../context/ListingsContext';
import type { Listing, ListingCategory } from '../api/types';

export const FEED_PAGE_SIZE = 20;
export const SEARCH_DEBOUNCE_MS = 350;

export type FeedStatus = 'loading' | 'ready' | 'error';

type LoadMode = 'initial' | 'quiet' | 'refresh';

// Browse feed: search and category go to the server, which pages the
// results. A newer request always wins over an older one still in flight.
//
// Freshness: every successful page-1 load records the listings `revision` it
// reflects. A change anywhere in the app (create, edit, archive) bumps the
// revision; the feed then reloads in the background once, and again when the
// screen regains focus if that reload has not succeeded yet.
export function useListingFeed({ query, category }: { query: string; category: ListingCategory | null }) {
  const { list, revision } = useListings();
  const [items, setItems] = useState<Listing[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<FeedStatus>('loading');
  const [error, setError] = useState<unknown>(null);
  // A background or pull-to-refresh failure while older results stay shown.
  const [refreshError, setRefreshError] = useState<unknown>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [debounced, setDebounced] = useState(query.trim());
  // The revision the shown items reflect; null before the first success.
  const [itemsRevision, setItemsRevision] = useState<number | null>(null);

  const latest = useRef(0);
  // Revision of the page-1 request in flight, if any.
  const inFlight = useRef<number | null>(null);
  // Mirrors for callbacks that must stay stable across renders.
  const revisionRef = useRef(revision);
  revisionRef.current = revision;
  const statusRef = useRef(status);
  statusRef.current = status;
  const itemsRevisionRef = useRef(itemsRevision);
  itemsRevisionRef.current = itemsRevision;
  const refreshErrorRef = useRef(refreshError);
  refreshErrorRef.current = refreshError;

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const load = useCallback(
    async (mode: LoadMode) => {
      const ticket = ++latest.current;
      const forRevision = revisionRef.current;
      inFlight.current = forRevision;
      if (mode === 'initial') setStatus('loading');
      if (mode === 'refresh') setRefreshing(true);
      try {
        const result = await list({
          ...(debounced ? { q: debounced } : {}),
          ...(category ? { category } : {}),
          page: 1,
          pageSize: FEED_PAGE_SIZE,
        });
        if (ticket !== latest.current) return;
        setItems(result.items);
        setTotal(result.pagination.total);
        setPage(1);
        setError(null);
        setRefreshError(null);
        setItemsRevision(forRevision);
        setStatus('ready');
        // Something changed while this request was in flight: catch up.
        if (forRevision !== revisionRef.current) void loadRef.current('quiet');
      } catch (err) {
        if (ticket !== latest.current) return;
        if (mode === 'initial' || statusRef.current !== 'ready') {
          setError(err);
          setStatus('error');
        } else {
          // Keep what is on screen, but say it may be out of date.
          setRefreshError(err);
        }
      } finally {
        if (ticket === latest.current) {
          inFlight.current = null;
          setRefreshing(false);
        }
      }
    },
    [list, debounced, category],
  );
  const loadRef = useRef(load);
  loadRef.current = load;

  // New filters show the loading state.
  useEffect(() => {
    void load('initial');
  }, [load]);

  // A change made elsewhere reloads in the background, once per revision.
  // Deliberately keyed on `revision` only: a filter change is handled above.
  // A load already in flight catches up when it finishes (see `load`).
  useEffect(() => {
    if (itemsRevisionRef.current === revision || inFlight.current !== null) return;
    void loadRef.current(statusRef.current === 'ready' ? 'quiet' : 'initial');
  }, [revision]);

  // For the screen's focus handler: reload only if the list is behind the
  // latest change or the last background reload failed. Stable identity.
  const refreshIfStale = useCallback(() => {
    if (inFlight.current !== null) return;
    const behind = itemsRevisionRef.current !== revisionRef.current;
    if (statusRef.current === 'error') {
      void loadRef.current('initial');
    } else if (statusRef.current === 'ready' && (behind || refreshErrorRef.current)) {
      void loadRef.current('quiet');
    }
  }, []);

  const hasMore = items.length < total;

  const loadMore = useCallback(async () => {
    if (!hasMore || loadingMore || status !== 'ready') return;
    const ticket = latest.current;
    setLoadingMore(true);
    try {
      const result = await list({
        ...(debounced ? { q: debounced } : {}),
        ...(category ? { category } : {}),
        page: page + 1,
        pageSize: FEED_PAGE_SIZE,
      });
      if (ticket !== latest.current) return;
      // A listing may shift pages if others were added meanwhile.
      setItems((prev) => {
        const seen = new Set(prev.map((i) => i.id));
        return [...prev, ...result.items.filter((i) => !seen.has(i.id))];
      });
      setTotal(result.pagination.total);
      setPage((p) => p + 1);
    } catch (err) {
      if (ticket === latest.current) setRefreshError(err);
    } finally {
      setLoadingMore(false);
    }
  }, [hasMore, loadingMore, status, list, debounced, category, page]);

  return {
    items,
    total,
    status,
    error,
    refreshError,
    refreshing,
    loadingMore,
    hasMore,
    // True once the shown items reflect every change made in the app.
    upToDate: status === 'ready' && itemsRevision === revision,
    // Whether the shown results are filtered (after the search debounce).
    filtered: Boolean(debounced) || category !== null,
    refresh: () => load('refresh'),
    retry: () => load('initial'),
    refreshIfStale,
    loadMore,
  };
}
