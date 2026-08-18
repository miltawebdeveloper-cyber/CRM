import { describe, expect, it } from '@jest/globals';
import { gridState, isGridBusy } from './table-state';

/**
 * The invariant these tests exist for, stated once: a grid that HAS rows shows
 * them, whatever else is happening. Everything below is that sentence checked
 * against each way the CRM manages to be loading something.
 */
describe('gridState', () => {
  it('shows the rows it has while a new filter loads', () => {
    // The reported bug: change a filter, and the previous page's leads vanished
    // for a second. They are still in hand — `keepPreviousData` holds them — so
    // there is nothing to justify an empty grid.
    expect(gridState({ refreshing: true, rowCount: 50 })).toBe('rows');
  });

  it('shows the rows it has while a save-triggered refetch runs', () => {
    // Editing an outcome or a comment invalidates the list, which refetches
    // every loaded chunk. The grid stays readable throughout.
    expect(gridState({ loading: false, refreshing: true, rowCount: 1200 })).toBe('rows');
  });

  it('shows the placeholder only on a genuinely empty first load', () => {
    expect(gridState({ loading: true, rowCount: 0 })).toBe('placeholder');
  });

  it('shows the placeholder rather than "no leads" while an answer is still coming', () => {
    // Second half of the original flicker: the grid blanked, then claimed the
    // filter matched nothing, then showed the matches. It may not make that
    // claim while a request is out.
    expect(gridState({ refreshing: true, rowCount: 0 })).toBe('placeholder');
  });

  it('claims emptiness only when nothing is on its way', () => {
    expect(gridState({ rowCount: 0 })).toBe('empty');
    expect(gridState({ loading: false, refreshing: false, rowCount: 0 })).toBe('empty');
  });

  it('never reports empty while rows exist, however the flags are set', () => {
    for (const loading of [true, false]) {
      for (const refreshing of [true, false]) {
        expect(gridState({ loading, refreshing, rowCount: 1 })).toBe('rows');
      }
    }
  });
});

describe('isGridBusy', () => {
  it('is true for either kind of in-flight work', () => {
    expect(isGridBusy({ loading: true })).toBe(true);
    expect(isGridBusy({ refreshing: true })).toBe(true);
    expect(isGridBusy({ loading: false, refreshing: true })).toBe(true);
  });

  it('is false when nothing is in flight', () => {
    expect(isGridBusy({})).toBe(false);
    expect(isGridBusy({ loading: false, refreshing: false })).toBe(false);
  });
});
