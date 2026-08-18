import { describe, expect, it } from '@jest/globals';
import { activeQueue, isLeadCompleted, serverSawWork } from './queue-view';
import type { Lead } from './leads';

/**
 * The reported bug, from the panel's side: after the agent finishes a call the
 * lead must leave Your Queue at once, and must not creep back in.
 *
 * Two authorities meet here — the API's verdict and the panel's memory of a save
 * it has just written — and the tests below are mostly about the hand-off
 * between them, because that is the part that is invisible for a few seconds and
 * then wrong for hours.
 */
describe('Your Queue visibility', () => {
  const lead = (over: Partial<Lead> = {}): Lead =>
    ({
      id: 'lead-1',
      leadId: 'L-2026-1',
      businessName: 'Acme Plumbing',
      queueStatus: 'new',
      lastWorkedAt: null,
      lastCallEndedAt: null,
      ...over,
    }) as Lead;

  const none: ReadonlySet<string> = new Set();

  it('keeps a lead nobody has worked', () => {
    expect(isLeadCompleted(lead(), none)).toBe(false);
  });

  it('keeps a lead whose call is still live', () => {
    expect(isLeadCompleted(lead({ queueStatus: 'in_progress', lastCallAt: '2026-08-18T14:00:00Z' }), none)).toBe(false);
  });

  it('drops a lead the server calls completed', () => {
    expect(isLeadCompleted(lead({ queueStatus: 'completed' }), none)).toBe(true);
  });

  it('drops a lead the instant it is saved, before the server is asked', () => {
    // The window this overlay exists for. The save has succeeded, the refetch
    // has not come back, and the lead still reports whatever the last poll said
    // — but it must already be gone from the list.
    const justSaved = lead({ queueStatus: 'new', lastWorkedAt: null, lastCallEndedAt: null });
    expect(isLeadCompleted(justSaved, new Set(['lead-1']))).toBe(true);
  });

  it('hands authority back once the server has seen the work', () => {
    // The refetch has landed. From here the API decides, and it says this lead
    // is finished — the overlay is simply agreeing.
    const confirmed = lead({ queueStatus: 'completed', lastWorkedAt: '2026-08-18T10:00:00Z' });
    expect(isLeadCompleted(confirmed, new Set(['lead-1']))).toBe(true);
  });

  it('lets the server re-open a lead the panel remembers saving', () => {
    // THE case the hand-off is for. Worked at 10am with a callback booked for
    // 2pm; at 2pm the server says the customer is owed a call. A Set from four
    // hours earlier must not outvote that — the lead comes back into the queue.
    const owedAgain = lead({ queueStatus: 'new', lastWorkedAt: '2026-08-18T10:00:00Z' });
    expect(isLeadCompleted(owedAgain, new Set(['lead-1']))).toBe(false);
  });

  it('treats a finished CALL as the server having seen the work too', () => {
    // The dialled path stamps `lastCallEndedAt` rather than `lastWorkedAt`;
    // either is proof the save landed.
    const rungAgain = lead({ queueStatus: 'new', lastCallEndedAt: '2026-08-18T10:05:00Z' });
    expect(isLeadCompleted(rungAgain, new Set(['lead-1']))).toBe(false);
  });

  describe('serverSawWork', () => {
    it('is false until a save has landed', () => {
      expect(serverSawWork(lead())).toBe(false);
    });
    it('is true off either stamp', () => {
      expect(serverSawWork(lead({ lastWorkedAt: '2026-08-18T10:00:00Z' }))).toBe(true);
      expect(serverSawWork(lead({ lastCallEndedAt: '2026-08-18T10:00:00Z' }))).toBe(true);
    });
  });

  describe('activeQueue', () => {
    const book = [
      lead({ id: 'a', queueStatus: 'new' }),
      lead({ id: 'b', queueStatus: 'completed' }),
      lead({ id: 'c', queueStatus: 'in_progress' }),
      lead({ id: 'd', queueStatus: 'new' }),
    ];

    it('removes finished leads instead of moving them', () => {
      // They used to sink to the bottom wearing a tick, which reads as work
      // still on the list.
      expect(activeQueue(book, none).map((l) => l.id)).toEqual(['a', 'c', 'd']);
    });

    it('preserves the server ORDER of what is left', () => {
      // A filter, never a sort: the API has already ranked these, and a second
      // ordering here is how the list stops matching the lead handed over next.
      const saved = new Set(['a']);
      expect(activeQueue(book, saved).map((l) => l.id)).toEqual(['c', 'd']);
    });

    it('leaves the agent an empty queue when everything is worked', () => {
      const allDone = book.map((l) => ({ ...l, queueStatus: 'completed' as const }));
      expect(activeQueue(allDone, none)).toEqual([]);
    });

    it('never removes a lead the book still has work on', () => {
      // A guard against the overlay leaking: an id in `processed` that belongs
      // to no lead here must not affect anything.
      expect(activeQueue(book, new Set(['not-a-lead'])).map((l) => l.id)).toEqual(['a', 'c', 'd']);
    });
  });
});
