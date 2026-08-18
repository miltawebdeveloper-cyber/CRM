'use client';

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query';
import { leadsApi, type Lead, type LeadListQuery } from '@/lib/leads';

/**
 * Rows fetched per trip. Small enough that the first screenful arrives fast,
 * large enough that a scroll doesn't fire a request every few rows.
 */
export const LEAD_CHUNK = 50;

/**
 * One continuous list of leads, filled in as it is scrolled.
 *
 * The list reads as a single panel — no page numbers, no next button, scroll and
 * the rest arrives — while the wire underneath still carries one chunk at a
 * time. That is the point: the module used to fetch the whole book before it
 * could show anything, and going back to that to remove the paging controls
 * would trade the controls for the wait.
 *
 * The `filters` object must be memoised by the caller; it is the query key, and
 * a fresh object every render would refetch from the first chunk forever.
 */
export function useInfiniteLeads(filters: LeadListQuery, opts?: { enabled?: boolean }) {
  const query = useInfiniteQuery({
    queryKey: ['leads', 'infinite', filters],
    queryFn: ({ pageParam, signal }) =>
      // The signal is what lets a superseded request be ABANDONED rather than
      // merely ignored. Typing in the search box or clicking through three sort
      // orders used to leave every intermediate request running to completion,
      // each one holding a connection and a server-side query nobody would read.
      leadsApi.page({ ...filters, page: pageParam, pageSize: LEAD_CHUNK }, signal),
    initialPageParam: 1,
    // `undefined` is what tells React Query there is nothing further, which is
    // what stops the sentinel below asking again at the end of the list.
    getNextPageParam: (last, all) => (all.length * LEAD_CHUNK < last.total ? all.length + 1 : undefined),
    /**
     * Hold the rows already on screen while a new query loads.
     *
     * Every filter, every sort, every keystroke that survives the search
     * debounce is a new query KEY, and a new key has no data — so the grid was
     * handed an empty array and a `true` loading flag, blanked, and refilled a
     * second later. Nothing was wrong with the data; the list simply had none
     * to show for as long as the request took.
     *
     * With this, the previous answer stays mounted until the new one arrives and
     * then swaps in one go. `isPlaceholderData` (surfaced as `isRefreshing`
     * below) is what tells the table those rows are the OLD ones, so it can say
     * so without removing them.
     */
    placeholderData: keepPreviousData,
    enabled: opts?.enabled ?? true,
  });

  const rows = useMemo<Lead[]>(() => query.data?.pages.flatMap((p) => p.rows) ?? [], [query.data]);
  const total = query.data?.pages[0]?.total ?? 0;

  return {
    ...query,
    rows,
    total,
    /**
     * The list is being brought up to date — a new filter, a re-sort, or a
     * refetch after a save — but there are still rows worth looking at.
     *
     * Deliberately not `isLoading`: that one now means "there is nothing to
     * show", which is the only case that may legitimately empty the grid.
     * Fetching the NEXT chunk is excluded too — the list is growing, not
     * changing, and the footer already reports that.
     */
    isRefreshing: (query.isFetching && !query.isFetchingNextPage) || query.isPlaceholderData,
  };
}

/**
 * Calls `onReach` when the returned ref scrolls into view.
 *
 * An observer rather than a scroll handler: it fires only when the marker is
 * actually visible, costs nothing while it isn't, and doesn't run code on every
 * pixel of every scroll of a long list.
 */
export function useReachedEnd(onReach: () => void, active: boolean) {
  const ref = useRef<HTMLDivElement | null>(null);
  // Held in a ref so re-creating the callback each render doesn't tear down and
  // rebuild the observer, which would drop an in-flight intersection.
  const latest = useRef(onReach);
  latest.current = onReach;

  useEffect(() => {
    const el = ref.current;
    if (!el || !active) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) latest.current();
      },
      // Start fetching a little before the marker is on screen, so the next rows
      // are usually there by the time the reader gets to them.
      { rootMargin: '400px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [active]);

  return ref;
}

/** Convenience: the sentinel ref wired to a query's "fetch the next chunk". */
export function useLeadScrollSentinel(q: {
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  isPlaceholderData: boolean;
  fetchNextPage: () => void;
}) {
  const fetchMore = useCallback(() => {
    // Never page off rows that belong to the PREVIOUS query. While a new filter
    // is loading the grid still shows the old list, and asking for "the next
    // chunk" then appends chunk 2 of the outgoing query to a list that is about
    // to be replaced — the one way this list could show two filters at once.
    if (q.hasNextPage && !q.isFetchingNextPage && !q.isPlaceholderData) q.fetchNextPage();
  }, [q.hasNextPage, q.isFetchingNextPage, q.isPlaceholderData, q.fetchNextPage]);
  return useReachedEnd(fetchMore, q.hasNextPage && !q.isPlaceholderData);
}
