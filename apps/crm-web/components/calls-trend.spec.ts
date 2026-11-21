import { describe, expect, it } from '@jest/globals';
import type { CallPivot } from '@/lib/crm';
import { TREND_MAX_DAYS, trendDays } from './calls-trend';

/** A date pivot: two reps (rows), days as columns. */
const PIVOT = {
  rows: [{ key: 'ann', label: 'Ann' }, { key: 'bob', label: 'Bob' }],
  cols: [{ key: '2026-11-16', label: '2026-11-16' }, { key: '2026-11-18', label: '2026-11-18' }, { key: '—', label: 'No date' }],
  cells: [
    { r: 0, c: 0, calls: 3, connected: 2, secs: 0 },
    { r: 1, c: 0, calls: 1, connected: 0, secs: 0 },
    { r: 0, c: 1, calls: 5, connected: 4, secs: 0 },
    { r: 0, c: 2, calls: 9, connected: 9, secs: 0 },
  ],
  scanned: 18,
  truncated: false,
} as unknown as CallPivot;

describe('trendDays', () => {
  it('adds the reps up per day, and fills every day in the range with zeroes where there were no calls', () => {
    const { days, clipped } = trendDays(PIVOT, '2026-11-15', '2026-11-18');
    expect(days).toEqual([
      { day: '2026-11-15', calls: 0, connected: 0, contacted: 0 },
      { day: '2026-11-16', calls: 4, connected: 2, contacted: 0 },
      { day: '2026-11-17', calls: 0, connected: 0, contacted: 0 },
      { day: '2026-11-18', calls: 5, connected: 4, contacted: 0 },
    ]);
    expect(clipped).toBe(false);
  });

  it('spans the first to the last day with calls when the range is open', () => {
    expect(trendDays(PIVOT).days.map((d) => d.day)).toEqual(['2026-11-16', '2026-11-17', '2026-11-18']);
  });

  it('draws at most the last stretch of a very long range, and says so', () => {
    const { days, clipped } = trendDays(PIVOT, '2026-01-01', '2026-11-18');
    expect(days).toHaveLength(TREND_MAX_DAYS);
    expect(days[days.length - 1].day).toBe('2026-11-18');
    expect(clipped).toBe(true);
  });

  it('has nothing to draw without calls or a range', () => {
    expect(trendDays(undefined).days).toEqual([]);
  });
});
