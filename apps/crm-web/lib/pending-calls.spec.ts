import { describe, expect, it } from '@jest/globals';
import type { PendingCall } from '@/lib/crm';
import { ageTone, dayLabel, daysBetween, groupPending, matchesKind, matchesSearch, nextWeekday, quickDays, summarizeByOwner, waitingLabel } from './pending-calls';

const call = (id: string, owner: [string, string], assignedOn: string | null, scheduledFor = assignedOn ?? '2026-11-20'): PendingCall => ({
  id, leadId: `L-${id}`, businessName: `Co ${id}`, contactName: null, phone: null, state: null, timezone: 'EST',
  owner: { id: owner[0], name: owner[1] }, assignedOn, scheduledFor, attempts: 0, lastOutcome: null, lastAttemptAt: null,
});

describe('groupPending', () => {
  it('groups employee-wise, then by the day each call was assigned for, oldest first', () => {
    const groups = groupPending([
      call('a', ['u-lisa', 'Lisa'], '2026-11-21'),
      call('b', ['u-chris', 'Chris'], '2026-11-20'),
      call('c', ['u-lisa', 'Lisa'], '2026-11-18'),
      call('d', ['u-lisa', 'Lisa'], '2026-11-21'),
    ]);
    expect(groups.map((g) => [g.owner.name, g.total])).toEqual([['Chris', 1], ['Lisa', 3]]);
    expect(groups[1].days.map((d) => [d.day, d.items.map((i) => i.id)])).toEqual([
      ['2026-11-18', ['c']],
      ['2026-11-21', ['a', 'd']],
    ]);
  });

  it('files a call from before assignments were recorded under its scheduled day', () => {
    expect(groupPending([call('x', ['u', 'Ann'], null, '2026-11-19')])[0].days[0].day).toBe('2026-11-19');
  });
});

describe('dates', () => {
  it('defaults a new date to the next weekday', () => {
    expect(nextWeekday('2026-11-23')).toBe('2026-11-24'); // Mon → Tue
    expect(nextWeekday('2026-11-27')).toBe('2026-11-30'); // Fri → Mon
    expect(nextWeekday('2026-11-28')).toBe('2026-11-30'); // Sat → Mon
  });

  it('labels and measures days', () => {
    expect(dayLabel('2026-11-21')).toBe('Sat, Nov 21');
    expect(daysBetween('2026-11-18', '2026-11-23')).toBe(5);
  });
});

describe('the managers’ view', () => {
  const today = '2026-11-23'; // a Monday
  const it2 = (id: string, day: string, attempts: number, extra: Partial<PendingCall> = {}): PendingCall => ({
    ...call(id, ['u-ann', 'Ann'], day),
    attempts,
    ...extra,
  });

  it('tones how long a call has waited', () => {
    expect([0, 1, 2, 3, 4, 9].map(ageTone)).toEqual(['fresh', 'fresh', 'aging', 'aging', 'old', 'old']);
    expect(waitingLabel(1)).toBe('1 day waiting');
  });

  it('filters by tried, untried and waiting three days or more', () => {
    const list = [it2('a', '2026-11-22', 0), it2('b', '2026-11-20', 2), it2('c', '2026-11-18', 1)];
    expect(list.filter((x) => matchesKind(x, 'untried', today)).map((x) => x.id)).toEqual(['a']);
    expect(list.filter((x) => matchesKind(x, 'tried', today)).map((x) => x.id)).toEqual(['b', 'c']);
    expect(list.filter((x) => matchesKind(x, 'old', today)).map((x) => x.id)).toEqual(['b', 'c']);
  });

  it('finds a call by company, contact, lead ID or phone digits in any format', () => {
    const x = it2('a', '2026-11-20', 0, { businessName: 'Harbor Financial', contactName: 'Maria Alvarez', leadId: 'SAMPLE-0042', phone: '(555) 010-2244' });
    expect(['harbor', 'maria', 'sample-0042', '5550102', '010-2244'].map((q) => matchesSearch(x, q))).toEqual([true, true, true, true, true]);
    expect(matchesSearch(x, 'brightline')).toBe(false);
  });

  it('summarises each employee’s backlog', () => {
    const s = summarizeByOwner([
      it2('a', '2026-11-20', 0),
      it2('b', '2026-11-18', 2),
      { ...it2('c', '2026-11-21', 0), owner: { id: 'u-bob', name: 'Bob' } },
    ]);
    expect(s.map((x) => [x.owner.name, x.count, x.untried, x.oldest])).toEqual([
      ['Ann', 2, 1, '2026-11-18'],
      ['Bob', 1, 1, '2026-11-21'],
    ]);
  });

  it('offers the next working day, the day after and next Monday', () => {
    expect(quickDays('2026-11-23')).toEqual([
      { label: 'Next working day', day: '2026-11-24' },
      { label: 'The day after', day: '2026-11-25' },
      { label: 'Next Monday', day: '2026-11-30' },
    ]);
    // On a Thursday, next Monday IS the day after the next working day.
    expect(quickDays('2026-11-26').map((q) => q.day)).toEqual(['2026-11-27', '2026-11-30']);
  });
});
