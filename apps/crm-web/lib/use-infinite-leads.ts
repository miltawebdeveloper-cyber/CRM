'use client';

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
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
    queryFn: ({ pageParam }) => leadsApi.page({ ...filters, page: pageParam, pageSize: LEAD_CHUNK }),
    initialPageParam: 1,
    // `undefined` is what tells React Query there is nothing further, which is
    // what stops the sentinel below asking again at the end of the list.
    getNextPageParam: (last, all) => (all.length * LEAD_CHUNK < last.total ? all.length + 1 : undefined),
    enabled: opts?.enabled ?? true,
  });

  const rows = useMemo<Lead[]>(() => query.data?.pages.flatMap((p) => p.rows) ?? [], [query.data]);
  const total = query.data?.pages[0]?.total ?? 0;

  return { ...query, rows, total };
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
export function useLeadScrollSentinel(q: { hasNextPage: boolean; isFetchingNextPage: boolean; fetchNextPage: () => void }) {
  const fetchMore = useCallback(() => {
    if (q.hasNextPage && !q.isFetchingNextPage) q.fetchNextPage();
  }, [q.hasNextPage, q.isFetchingNextPage, q.fetchNextPage]);
  return useReachedEnd(fetchMore, q.hasNextPage);
}
