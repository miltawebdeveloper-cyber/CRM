import { describe, expect, it } from '@jest/globals';
import { kpiDelta } from './kpi-delta';

describe('kpiDelta', () => {
  it('judges by which way is better, not by direction', () => {
    expect(kpiDelta(84, 75, { days: 7 })).toMatchObject({ direction: 'up', tone: 'better', text: '12%' });
    // More missed calls is worse.
    expect(kpiDelta(12, 8, { days: 7, upIsGood: false })).toMatchObject({ direction: 'up', tone: 'worse', text: '50%' });
    expect(kpiDelta(4, 8, { days: 7, upIsGood: false })).toMatchObject({ direction: 'down', tone: 'better' });
  });

  it('moves a rate in percentage points', () => {
    expect(kpiDelta(3.5, 2, { days: 30, kind: 'pts' })).toMatchObject({ direction: 'up', text: '1.5 pts' });
  });

  it('says "new" rather than inventing a percentage from zero', () => {
    expect(kpiDelta(5, 0, { days: 1 })).toMatchObject({ direction: 'up', text: 'new' });
    expect(kpiDelta(0, 0, { days: 1 })).toMatchObject({ direction: 'flat', tone: 'same', text: '0%' });
  });

  it('spells the comparison out for the tooltip and screen readers', () => {
    expect(kpiDelta(84, 75, { days: 7 }).title).toBe('up 12% — 84 vs 75 in the previous 7 days');
    expect(kpiDelta(9, 9, { days: 1 }).title).toBe('unchanged — 9 vs 9 in the previous 1 day');
  });
});
