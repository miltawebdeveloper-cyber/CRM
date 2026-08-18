/** @jest-environment jsdom */
import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import React from 'react';

/**
 * The flicker, as a test.
 *
 * Changing a filter, a sort, or typing past the search debounce makes a new
 * query KEY, and a new key has no data of its own. The grid was handed an empty
 * array and a `true` loading flag, blanked, and refilled a second later —
 * nothing wrong with the data, the list simply had none to show for as long as
 * the request took.
 *
 * What is asserted below is that the rows stay put across that change, and that
 * the hook says WHICH rows they are: `isLoading` means "nothing to show",
 * `isRefreshing` means "these are the previous ones and newer are coming". The
 * grid keys its whole behaviour off that pair, so the pair is the contract.
 */

/** One page of leads, shaped like the API's answer. */
const page = (ids: string[], total: number, pageNo = 1) => ({
  rows: ids.map((id) => ({ id, leadId: `L-${id}`, businessName: `Co ${id}` })),
  total,
  page: pageNo,
  pageSize: 50,
});

const fetchPage = jest.fn(async (_opts?: unknown, _signal?: AbortSignal) => page(['1'], 1));

jest.mock('@/lib/leads', () => ({
  leadsApi: {
    page: (opts?: unknown, signal?: AbortSignal) =>
      (fetchPage as unknown as (o?: unknown, s?: AbortSignal) => Promise<unknown>)(opts, signal),
  },
}));

import { useInfiniteLeads, LEAD_CHUNK } from './use-infinite-leads';

/**
 * A provider holding ONE client for the life of a test.
 *
 * Built by a factory rather than declared inline, because an inline wrapper
 * component constructs whatever is in its body on every render — and a fresh
 * QueryClient per render means a cache that is thrown away between them. Every
 * assertion here is about data surviving a re-render, so that would quietly test
 * the opposite of what it claims to.
 */
const makeWrapper = () => {
  // Retries off: a test should fail on the first error rather than time out
  // three retries later.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return React.createElement(QueryClientProvider, { client }, children);
  }
  return Wrapper;
};

describe('useInfiniteLeads', () => {
  beforeEach(() => {
    fetchPage.mockReset();
    fetchPage.mockResolvedValue(page(['1'], 1));
  });

  it('reports loading, not an empty list, on the very first fetch', async () => {
    // The one case where showing no rows is honest — there have never been any.
    const { result } = renderHook(() => useInfiniteLeads({ closed: false }), { wrapper: makeWrapper() });

    expect(result.current.isLoading).toBe(true);
    expect(result.current.rows).toEqual([]);

    await waitFor(() => expect(result.current.isLoading).toBe(false));
  });

  it('exposes the rows and the total the API reported', async () => {
    fetchPage.mockResolvedValue(page(['a', 'b', 'c'], 3));
    const { result } = renderHook(() => useInfiniteLeads({ closed: false }), { wrapper: makeWrapper() });

    await waitFor(() => expect(result.current.rows).toHaveLength(3));
    expect(result.current.rows.map((l) => l.id)).toEqual(['a', 'b', 'c']);
    expect(result.current.total).toBe(3);
  });

  describe('when the filter changes', () => {
    it('keeps the previous rows on screen while the new ones load', async () => {
      // THE regression. Without `keepPreviousData` this is an empty array and a
      // blank grid for the length of a request.
      fetchPage.mockResolvedValue(page(['a', 'b'], 2));
      const { result, rerender } = renderHook(({ q }: { q: string }) => useInfiniteLeads({ closed: false, q }), {
        wrapper: makeWrapper(),
        initialProps: { q: '' },
      });
      await waitFor(() => expect(result.current.rows).toHaveLength(2));

      // A filter that will answer slowly, so the in-between state is observable.
      let release!: (v: ReturnType<typeof page>) => void;
      fetchPage.mockReturnValue(new Promise((res) => { release = res as typeof release; }));
      rerender({ q: 'miami' });

      // Mid-flight: the old rows are still there, and the hook says so.
      expect(result.current.rows.map((l) => l.id)).toEqual(['a', 'b']);
      expect(result.current.isLoading).toBe(false);
      expect(result.current.isRefreshing).toBe(true);

      await act(async () => {
        release(page(['z'], 1));
      });
      await waitFor(() => expect(result.current.rows.map((l) => l.id)).toEqual(['z']));
      expect(result.current.isRefreshing).toBe(false);
    });

    it('swaps to the new rows in one step, never through an empty list', async () => {
      // Recorded across every render, because the blank was a single frame
      // between two good ones — exactly the thing a final-state assertion
      // cannot see.
      fetchPage.mockResolvedValue(page(['a', 'b'], 2));
      const seen: string[][] = [];
      const { result, rerender } = renderHook(
        ({ q }: { q: string }) => {
          const r = useInfiniteLeads({ closed: false, q });
          seen.push(r.rows.map((l) => l.id));
          return r;
        },
        { wrapper: makeWrapper(), initialProps: { q: '' } },
      );
      await waitFor(() => expect(result.current.rows).toHaveLength(2));

      fetchPage.mockResolvedValue(page(['z'], 1));
      rerender({ q: 'miami' });
      await waitFor(() => expect(result.current.rows.map((l) => l.id)).toEqual(['z']));

      // Once the list has rows it never goes back to none.
      const firstFilled = seen.findIndex((r) => r.length > 0);
      expect(firstFilled).toBeGreaterThanOrEqual(0);
      expect(seen.slice(firstFilled).some((r) => r.length === 0)).toBe(false);
    });

    it('asks the API for the new filter, not the old one', async () => {
      fetchPage.mockResolvedValue(page(['a'], 1));
      const { result, rerender } = renderHook(({ q }: { q: string }) => useInfiniteLeads({ closed: false, q }), {
        wrapper: makeWrapper(),
        initialProps: { q: '' },
      });
      await waitFor(() => expect(result.current.rows).toHaveLength(1));

      rerender({ q: 'miami' });
      await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(2));

      expect(fetchPage.mock.calls[1][0]).toMatchObject({ q: 'miami', page: 1, pageSize: LEAD_CHUNK });
    });
  });

  it('gives the request an abort signal, so a superseded one can be cancelled', async () => {
    // React Query only cancels a request whose query function CONSUMED the
    // signal. Drop it and every abandoned filter change runs to completion.
    const { result } = renderHook(() => useInfiniteLeads({ closed: false }), { wrapper: makeWrapper() });
    await waitFor(() => expect(fetchPage).toHaveBeenCalled());

    expect(fetchPage.mock.calls[0][1]).toBeInstanceOf(AbortSignal);
    expect(result.current.rows).toBeDefined();
  });

  describe('paging', () => {
    it('offers another page while the total exceeds what is loaded', async () => {
      fetchPage.mockResolvedValue(page(['a'], LEAD_CHUNK * 3));
      const { result } = renderHook(() => useInfiniteLeads({ closed: false }), { wrapper: makeWrapper() });

      await waitFor(() => expect(result.current.hasNextPage).toBe(true));
    });

    it('stops offering one at the end of the list', async () => {
      fetchPage.mockResolvedValue(page(['a'], 1));
      const { result } = renderHook(() => useInfiniteLeads({ closed: false }), { wrapper: makeWrapper() });

      await waitFor(() => expect(result.current.isLoading).toBe(false));
      expect(result.current.hasNextPage).toBe(false);
    });

    it('appends the next chunk rather than replacing the list', async () => {
      fetchPage.mockResolvedValue(page(['a'], LEAD_CHUNK * 2));
      const { result } = renderHook(() => useInfiniteLeads({ closed: false }), { wrapper: makeWrapper() });
      await waitFor(() => expect(result.current.rows).toHaveLength(1));

      fetchPage.mockResolvedValue(page(['b'], LEAD_CHUNK * 2, 2));
      // `waitFor`, not an awaited `act`: the request settles before React has
      // committed the new page to the observer, so awaiting the call alone reads
      // the list one render too early.
      void result.current.fetchNextPage();
      await waitFor(() => expect(result.current.rows).toHaveLength(2));

      expect(result.current.rows.map((l) => l.id)).toEqual(['a', 'b']);
      // Growing the list is not "refreshing" — the rows on screen are correct
      // and the footer already reports the fetch.
      expect(result.current.isRefreshing).toBe(false);
    });

    it('asks for the second page by number', async () => {
      fetchPage.mockResolvedValue(page(['a'], LEAD_CHUNK * 2));
      const { result } = renderHook(() => useInfiniteLeads({ closed: false }), { wrapper: makeWrapper() });
      await waitFor(() => expect(result.current.rows).toHaveLength(1));

      fetchPage.mockResolvedValue(page(['b'], LEAD_CHUNK * 2, 2));
      void result.current.fetchNextPage();
      await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(2));

      expect(fetchPage.mock.calls[1][0]).toMatchObject({ page: 2, pageSize: LEAD_CHUNK });
    });
  });

  it('does not fetch at all while disabled', async () => {
    // The panel gates the list on things like a role check resolving first.
    renderHook(() => useInfiniteLeads({ closed: false }, { enabled: false }), { wrapper: makeWrapper() });
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchPage).not.toHaveBeenCalled();
  });
});
