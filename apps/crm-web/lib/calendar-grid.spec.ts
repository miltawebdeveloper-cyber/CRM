import { describe, expect, it } from '@jest/globals';
import {
  atOnClock, clockLabel, dayHeading, fromWallClock, hourRange, isOverdue, layoutDay, loadLevel, nextHalfHour, nextUp, outsideCustomerHours, repColours, snap, step,
  teamLoad, timeIn, titleFor, untilLabel, wallClockIn, windowFor, zonedInstant, zoneParts,
} from './calendar-grid';

describe('windowFor', () => {
  it('draws a month as whole weeks, Sunday to Saturday, with the neighbouring days at its edges', () => {
    const w = windowFor('month', '2026-11-21');
    expect(w.from).toBe('2026-11-01'); // 1 Nov 2026 is a Sunday
    expect(w.to).toBe('2026-12-05');
    expect(w.days).toHaveLength(35);
  });

  it('takes the week the day is in, and a single day for Day', () => {
    expect(windowFor('week', '2026-11-21')).toMatchObject({ from: '2026-11-15', to: '2026-11-21' });
    expect(windowFor('week', '2026-12-01')).toMatchObject({ from: '2026-11-29', to: '2026-12-05' });
    expect(windowFor('day', '2026-11-21').days).toEqual(['2026-11-21']);
  });

  it('lists two weeks in the agenda', () => {
    expect(windowFor('agenda', '2026-11-21')).toMatchObject({ from: '2026-11-21', to: '2026-12-04' });
  });
});

describe('step and titles', () => {
  it('steps by the view’s own length', () => {
    expect(step('month', '2026-11-21', 1)).toBe('2026-12-01');
    expect(step('month', '2026-01-31', -1)).toBe('2025-12-01');
    expect(step('week', '2026-11-21', 1)).toBe('2026-11-28');
    expect(step('day', '2026-11-30', 1)).toBe('2026-12-01');
    expect(step('agenda', '2026-11-21', -1)).toBe('2026-11-07');
  });

  it('names the period on screen', () => {
    expect(titleFor('month', '2026-11-21')).toBe('November 2026');
    expect(titleFor('week', '2026-11-21')).toBe('Nov 15 – 21, 2026');
    expect(titleFor('week', '2026-12-01')).toBe('Nov 29 – Dec 5, 2026');
    expect(titleFor('week', '2026-12-31')).toBe('Dec 27, 2026 – Jan 2, 2027');
    expect(titleFor('day', '2026-11-21')).toBe('Saturday, Nov 21, 2026');
  });

  it('heads agenda days in words near today', () => {
    expect(dayHeading('2026-11-21', '2026-11-21')).toBe('Today');
    expect(dayHeading('2026-11-22', '2026-11-21')).toBe('Tomorrow');
    expect(dayHeading('2026-11-24', '2026-11-21')).toBe('Tue, Nov 24');
  });
});

describe('placing an event on one clock', () => {
  it('reads the day and hour in the display zone', () => {
    // 15:00 UTC = 10:00 New York = 07:00 Los Angeles.
    expect(zoneParts('2026-11-24T15:00:00Z', 'America/New_York')).toEqual({ ymd: '2026-11-24', hour: 10, minute: 0 });
    expect(zoneParts('2026-11-24T15:00:00Z', 'America/Los_Angeles')).toEqual({ ymd: '2026-11-24', hour: 7, minute: 0 });
    // Past midnight UTC is still the evening before in New York.
    expect(zoneParts('2026-11-25T02:30:00Z', 'America/New_York')).toEqual({ ymd: '2026-11-24', hour: 21, minute: 30 });
    expect(timeIn('2026-11-24T15:30:00Z', 'America/New_York')).toBe('10:30 AM');
  });

  it('draws 8 AM to 7 PM, widened to take in early and late events', () => {
    expect(hourRange([])).toEqual([8, 19]);
    expect(hourRange([10, 14])).toEqual([8, 19]);
    expect(hourRange([6, 21])).toEqual([6, 22]);
    expect(hourRange([23])).toEqual([8, 24]);
  });

  it('puts overlapping events side by side, and lone ones full width', () => {
    const placed = layoutDay([
      { item: 'a', start: 60, length: 30 },
      { item: 'b', start: 75, length: 30 },
      { item: 'c', start: 200, length: 30 },
    ]);
    const by = Object.fromEntries(placed.map((p) => [p.item, p]));
    expect([by.a.lane, by.b.lane]).toEqual([0, 1]);
    expect([by.a.lanes, by.b.lanes]).toEqual([2, 2]);
    expect(by.c).toMatchObject({ lane: 0, lanes: 1 });
  });
});

describe('isOverdue', () => {
  const now = Date.parse('2026-11-24T18:00:00Z');
  it('marks a scheduled call more than an hour late, not one just due', () => {
    expect(isOverdue({ type: 'call', date: '2026-11-24T16:30:00Z', status: 'contacted', callbackStatus: null }, now)).toBe(true);
    expect(isOverdue({ type: 'call', date: '2026-11-24T17:30:00Z', status: 'contacted', callbackStatus: null }, now)).toBe(false);
  });

  it('takes a callback’s own status', () => {
    expect(isOverdue({ type: 'callback', date: '2026-11-20T10:00:00Z', status: 'contacted', callbackStatus: 'overdue' }, now)).toBe(true);
    expect(isOverdue({ type: 'callback', date: '2026-11-24T17:50:00Z', status: 'contacted', callbackStatus: 'due' }, now)).toBe(false);
  });

  it('marks a meeting never started, never a completed or cancelled one', () => {
    const late = '2026-11-24T15:00:00Z';
    expect(isOverdue({ type: 'zoom', date: late, status: 'scheduled', callbackStatus: null }, now)).toBe(true);
    expect(isOverdue({ type: 'zoom', date: late, status: 'completed', callbackStatus: null }, now)).toBe(false);
    expect(isOverdue({ type: 'zoom', date: late, status: 'cancelled', callbackStatus: null }, now)).toBe(false);
  });
});

describe('turning a spot on the grid back into an instant', () => {
  it('reads a day and minute on the display clock, across DST', () => {
    // 10:00 New York is 15:00 UTC in November (EST) and 14:00 UTC in August (EDT).
    expect(zonedInstant('2026-11-24', 600, 'America/New_York').toISOString()).toBe('2026-11-24T15:00:00.000Z');
    expect(zonedInstant('2026-08-04', 600, 'America/New_York').toISOString()).toBe('2026-08-04T14:00:00.000Z');
    // The morning DST ends (Nov 1 2026, 2 AM): 9 AM is already EST.
    expect(zonedInstant('2026-11-01', 540, 'America/New_York').toISOString()).toBe('2026-11-01T14:00:00.000Z');
    expect(zonedInstant('2026-11-24', 600, 'Asia/Kolkata').toISOString()).toBe('2026-11-24T04:30:00.000Z');
    // Past midnight rolls into the next day.
    expect(zonedInstant('2026-11-24', 24 * 60 + 30, 'America/New_York').toISOString()).toBe('2026-11-25T05:30:00.000Z');
  });

  it('round-trips a datetime-local value', () => {
    expect(wallClockIn('2026-11-24T15:30:00Z', 'America/New_York')).toBe('2026-11-24T10:30');
    expect(fromWallClock('2026-11-24T10:30', 'America/New_York')?.toISOString()).toBe('2026-11-24T15:30:00.000Z');
    expect(fromWallClock('', 'America/New_York')).toBeNull();
  });

  it('snaps and labels times', () => {
    expect(snap(607, 15)).toBe(600);
    expect(snap(608, 15)).toBe(615);
    expect(clockLabel(0)).toBe('12:00 AM');
    expect(clockLabel(870)).toBe('2:30 PM');
    expect(clockLabel(720)).toBe('12:00 PM');
  });

  it('starts a new booking on the next half hour', () => {
    // 10:10 New York → 10:30; 10:30 exactly → 11:00.
    expect(nextHalfHour(Date.parse('2026-11-24T15:10:00Z'), 'America/New_York').toISOString()).toBe('2026-11-24T15:30:00.000Z');
    expect(nextHalfHour(Date.parse('2026-11-24T15:30:00Z'), 'America/New_York').toISOString()).toBe('2026-11-24T16:00:00.000Z');
  });

  it('names the day and zone of an instant', () => {
    expect(atOnClock('2026-11-24T20:00:00Z', 'America/New_York')).toBe('Tue, Nov 24, 3:00 PM EST');
  });
});

describe('outsideCustomerHours', () => {
  it('is quiet inside 9 AM – 6 PM, Monday to Friday', () => {
    expect(outsideCustomerHours('2026-11-24T09:00')).toBeNull(); // Tuesday
    expect(outsideCustomerHours('2026-11-24T17:45')).toBeNull();
  });

  it('warns before 9, from 6, and at weekends', () => {
    expect(outsideCustomerHours('2026-11-24T08:30')).toBe('That’s 8:30 AM for the customer — before their 9 AM start.');
    expect(outsideCustomerHours('2026-11-24T18:00')).toBe('That’s 6:00 PM for the customer — after their 6 PM finish.');
    expect(outsideCustomerHours('2026-11-21T11:00')).toBe('That’s 11:00 AM on a Saturday for the customer — outside their working week.');
  });
});

describe('isOverdue for a task', () => {
  it('is overdue the moment it’s due', () => {
    const now = Date.parse('2026-11-24T18:00:00Z');
    expect(isOverdue({ type: 'task', date: '2026-11-24T17:59:00Z', status: 'todo', callbackStatus: null }, now)).toBe(true);
    expect(isOverdue({ type: 'task', date: '2026-11-24T18:30:00Z', status: 'todo', callbackStatus: null }, now)).toBe(false);
  });
});

describe('the team view', () => {
  it('is a week, stepped by a week', () => {
    expect(windowFor('team', '2026-11-25')).toMatchObject({ from: '2026-11-22', to: '2026-11-28' });
    expect(step('team', '2026-11-25', 1)).toBe('2026-12-02');
    expect(titleFor('team', '2026-11-25')).toBe('Nov 22 – 28, 2026');
  });

  it('shades by a fixed scale', () => {
    expect([0, 1, 2, 3, 5, 6, 9, 10, 40].map(loadLevel)).toEqual([0, 1, 1, 2, 2, 3, 3, 4, 4]);
  });

  it('counts each person’s day, the busiest hour, overdue — and leaves tasks out', () => {
    const it = (ownerId: string | null, ymd: string, hour: number, type: 'call' | 'callback' | 'zoom' | 'task', overdue = false) => ({ ownerId, ymd, hour, type, overdue });
    const load = teamLoad([
      it('lisa', '2026-11-24', 10, 'callback'),
      it('lisa', '2026-11-24', 10, 'callback'),
      it('lisa', '2026-11-24', 10, 'call', true),
      it('lisa', '2026-11-24', 14, 'zoom'),
      it('lisa', '2026-11-24', 9, 'task'),
      it('john', '2026-11-24', 11, 'call'),
      it(null, '2026-11-25', 12, 'callback'),
    ]);
    expect(load.get('lisa')?.get('2026-11-24')).toEqual({ total: 4, call: 1, callback: 2, zoom: 1, overdue: 1, busiest: { hour: 10, count: 3 } });
    expect(load.get('john')?.get('2026-11-24')?.busiest).toEqual({ hour: 11, count: 1 });
    expect(load.get('')?.get('2026-11-25')?.total).toBe(1);
  });

  it('gives each person the same colour whatever the order they arrive in', () => {
    const a = repColours([{ id: 'c', name: 'Chris' }, { id: 'l', name: 'Lisa' }, { id: 'j', name: 'John' }]);
    const b = repColours([{ id: 'l', name: 'Lisa' }, { id: 'j', name: 'John' }, { id: 'c', name: 'Chris' }]);
    expect([...a.entries()].sort()).toEqual([...b.entries()].sort());
    expect(a.get('c')).toBe('var(--rep-1)');
    const many = repColours(['A', 'B', 'C', 'D', 'E'].map((n) => ({ id: n, name: n })));
    expect(many.get('E')).toBe('var(--viz-working)');
  });
});

describe('next up', () => {
  const now = Date.parse('2026-11-24T15:00:00Z');
  const end = Date.parse('2026-11-25T05:00:00Z');
  const e = (date: string, type: 'call' | 'callback' | 'zoom' | 'task' = 'call', status = 'contacted') => ({ date, type, status, callbackStatus: null });

  it('takes the next three today, keeping one that has only just started', () => {
    const list = [
      e('2026-11-24T14:55:00Z'), // started 5 min ago — still "now"
      e('2026-11-24T14:30:00Z'), // half an hour ago — gone
      e('2026-11-24T18:00:00Z'),
      e('2026-11-24T16:00:00Z'),
      e('2026-11-24T20:00:00Z'),
      e('2026-11-25T14:00:00Z'), // tomorrow
    ];
    expect(nextUp(list, now, end).map((x) => x.date)).toEqual(['2026-11-24T14:55:00Z', '2026-11-24T16:00:00Z', '2026-11-24T18:00:00Z']);
  });

  it('skips a meeting that’s finished or cancelled', () => {
    expect(nextUp([e('2026-11-24T16:00:00Z', 'zoom', 'cancelled'), e('2026-11-24T17:00:00Z', 'zoom', 'scheduled')], now, end)).toHaveLength(1);
  });

  it('counts down in plain words', () => {
    expect(untilLabel(now - 120_000, now)).toBe('now');
    expect(untilLabel(now + 25 * 60_000, now)).toBe('in 25 min');
    expect(untilLabel(now + 120 * 60_000, now)).toBe('in 2 h');
    expect(untilLabel(now + 65 * 60_000, now)).toBe('in 1 h 5 min');
  });
});
