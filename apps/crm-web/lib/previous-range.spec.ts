import { describe, expect, it } from '@jest/globals';
import { daysIn, previousRange } from './previous-range';

describe('previousRange', () => {
  it('is the same number of days, just before', () => {
    expect(previousRange('2026-11-01', '2026-11-07')).toEqual({ from: '2026-10-25', to: '2026-10-31', days: 7 });
    expect(previousRange('2026-11-20', '2026-11-20')).toEqual({ from: '2026-11-19', to: '2026-11-19', days: 1 });
  });

  it('crosses month, year and leap-day ends on the calendar, not the clock', () => {
    expect(previousRange('2026-03-01', '2026-03-31')).toEqual({ from: '2026-01-29', to: '2026-02-28', days: 31 });
    expect(previousRange('2028-03-01', '2028-03-01')).toEqual({ from: '2028-02-29', to: '2028-02-29', days: 1 });
    expect(previousRange('2027-01-01', '2027-01-02')).toEqual({ from: '2026-12-30', to: '2026-12-31', days: 2 });
  });

  it('has nothing to compare with an open range', () => {
    expect(previousRange(undefined, '2026-11-20')).toBeNull();
    expect(previousRange('', '')).toBeNull();
  });

  it('counts days inclusively', () => {
    expect(daysIn('2026-11-15', '2026-11-21')).toBe(7);
  });
});
