import { describe, expect, it } from '@jest/globals';
import { activeQuickRange, quickRange } from './quick-ranges';

// Thursday 20 November 2026, as the business day.
const TODAY = new Date(2026, 10, 20);

describe('quickRange', () => {
  it('builds the same filters the date picker does', () => {
    expect(quickRange('today', TODAY)).toEqual({ mode: 'day', from: '2026-11-20', to: '2026-11-20' });
    expect(quickRange('yesterday', TODAY)).toEqual({ mode: 'day', from: '2026-11-19', to: '2026-11-19' });
    // Sunday-based, like the picker's week rows.
    expect(quickRange('week', TODAY)).toEqual({ mode: 'week', from: '2026-11-15', to: '2026-11-21' });
    expect(quickRange('month', TODAY)).toEqual({ mode: 'month', from: '2026-11-01', to: '2026-11-30' });
  });

  it('crosses month and year ends cleanly', () => {
    expect(quickRange('yesterday', new Date(2026, 0, 1))).toEqual({ mode: 'day', from: '2025-12-31', to: '2025-12-31' });
    expect(quickRange('month', new Date(2028, 1, 10)).to).toBe('2028-02-29');
  });

  it('knows which chip a filter is, and none for anything else', () => {
    expect(activeQuickRange(quickRange('week', TODAY), TODAY)).toBe('week');
    expect(activeQuickRange({ mode: 'all', from: '', to: '' }, TODAY)).toBeNull();
    expect(activeQuickRange({ mode: 'custom', from: '2026-11-01', to: '2026-11-09' }, TODAY)).toBeNull();
  });
});
