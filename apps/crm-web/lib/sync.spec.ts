import { describe, expect, it, jest } from '@jest/globals';
import type { QueryClient } from '@tanstack/react-query';
import { invalidateLeadBook } from './sync';

/**
 * Anything that adds, removes, restores or re-owns leads refreshes every
 * screen built on the book through ONE list. The hand-kept lists it replaced
 * had drifted: an import's Undo and a Duplicate Leads purge left the removed
 * leads in reps' Calling Panel queues, and nothing that moved a lead refreshed
 * Pending Calls. These are the screens that went stale.
 */
describe('invalidateLeadBook', () => {
  const refreshed = () => {
    const invalidateQueries = jest.fn();
    invalidateLeadBook({ invalidateQueries } as unknown as QueryClient);
    return invalidateQueries.mock.calls.map((c) => (c[0] as { queryKey: string[] }).queryKey[0]);
  };

  it('refreshes the Calling Panel — the queue, its cards and its Analytics counts', () => {
    expect(refreshed()).toEqual(expect.arrayContaining(['caller-leads', 'caller-dash', 'lead-book']));
  });

  it('refreshes Pending Calls, the assignment counts and Duplicate Leads', () => {
    expect(refreshed()).toEqual(expect.arrayContaining(['pending-calls', 'assignments-summary', 'lead-duplicates']));
  });

  it('refreshes every lead list and the dashboard', () => {
    expect(refreshed()).toEqual(expect.arrayContaining(['leads', 'lead', 'metrics']));
  });
});
