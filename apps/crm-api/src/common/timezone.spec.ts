import { describe, expect, it } from '@jest/globals';
import {
  businessDay,
  businessDayEnd,
  businessDayStart,
  businessIana,
  businessTimezone,
  businessWeekdayHour,
  dayInZone,
  endOfBusinessDay,
  sameDayInZone,
  startOfBusinessDay,
  startOfDayInZone,
  zoneMatchesCountry,
  zonesOfCountry,
} from './timezone.js';

/**
 * The server runs on IST and the leads are American. Every date decision about a
 * lead has to be read on the LEAD's clock, or an agent assigning in the Indian
 * evening files the work under a date the customer has not reached yet.
 *
 * The instants below are real ones, chosen to sit inside the window where the
 * two calendars disagree — which is most of the Indian working evening.
 */
describe('lead-zone calendar boundaries', () => {
  // 2026-08-14 00:30 IST == 2026-08-13 19:00 UTC == 2026-08-13 15:00 EDT.
  // India has ticked over to the 14th; every US zone is still on the 13th.
  const indianMidnightPassed = new Date('2026-08-13T19:00:00Z');

  it('reads a US lead as the previous day while India is already on the next', () => {
    // The spec's own example: still the 13th for the lead, whatever India says.
    expect(dayInZone(indianMidnightPassed, 'EST')).toBe('2026-08-13');
    expect(dayInZone(indianMidnightPassed, 'CST')).toBe('2026-08-13');
    expect(dayInZone(indianMidnightPassed, 'MST')).toBe('2026-08-13');
    expect(dayInZone(indianMidnightPassed, 'PST')).toBe('2026-08-13');
    // And the server's own clock is what would have got this wrong.
    expect(dayInZone(indianMidnightPassed, null)).toBe('2026-08-13');
  });

  it('holds a lead on its date until that date ends in ITS zone, not India s', () => {
    // 23:30 EDT on the 13th — the 14th everywhere in India for hours already.
    const lateOn13thEast = new Date('2026-08-14T03:30:00Z');
    expect(dayInZone(lateOn13thEast, 'EST')).toBe('2026-08-13');
    // Half an hour later the east coast turns over, and only then does it move.
    const justInto14thEast = new Date('2026-08-14T04:30:00Z');
    expect(dayInZone(justInto14thEast, 'EST')).toBe('2026-08-14');
  });

  it('turns each US zone over at its own moment, not all at once', () => {
    // 2026-08-14 02:30 UTC: already the 14th on the east coast, still the 13th
    // on the west. A single nightly boundary cannot be right for both.
    const between = new Date('2026-08-14T04:30:00Z');
    expect(dayInZone(between, 'EST')).toBe('2026-08-14');
    expect(dayInZone(between, 'PST')).toBe('2026-08-13');
  });

  it('startOfDayInZone returns the instant that zone s day actually began', () => {
    const at = new Date('2026-08-13T19:00:00Z'); // 15:00 EDT on the 13th
    const start = startOfDayInZone('EST', at);
    // Midnight EDT on the 13th is 04:00 UTC the same date.
    expect(start.toISOString()).toBe('2026-08-13T04:00:00.000Z');
    // And the day it belongs to reads back as the 13th, not the 12th — the
    // off-by-one a naive offset subtraction produces.
    expect(dayInZone(start, 'EST')).toBe('2026-08-13');
  });

  it('sameDayInZone disagrees with the server exactly when it should', () => {
    const assignedAt = new Date('2026-08-13T19:00:00Z'); // 13th in the US, 14th in India
    const now = new Date('2026-08-13T23:00:00Z'); // still the 13th in the US
    expect(sameDayInZone(assignedAt, now, 'EST')).toBe(true);

    // Once the lead's own day turns, the two stop being the same day.
    const nextDayEast = new Date('2026-08-14T05:00:00Z');
    expect(sameDayInZone(assignedAt, nextDayEast, 'EST')).toBe(false);
    // The west coast has not turned over yet at that same instant.
    expect(sameDayInZone(assignedAt, nextDayEast, 'PST')).toBe(true);
  });

  it('handles a lead with no zone without falling back to the server s', () => {
    // Unset zones default to a US zone, never to IST — wrong by hours beats
    // wrong by half a day, and half a day is what flips the date.
    expect(dayInZone(indianMidnightPassed, null)).toBe('2026-08-13');
  });
});

describe('country / zone matching (built-in zones)', () => {
  it('accepts a zone in its own country and rejects one from another', () => {
    expect(zoneMatchesCountry('EST', 'USA')).toBe(true);
    expect(zoneMatchesCountry('EST', 'India')).toBe(false);
    expect(zoneMatchesCountry('IND', 'India')).toBe(true);
  });

  it('never blocks when either side is missing', () => {
    expect(zoneMatchesCountry(null, 'India')).toBe(true);
    expect(zoneMatchesCountry('EST', null)).toBe(true);
  });

  it("lists a country's zones in configured order", () => {
    expect(zonesOfCountry('USA')).toEqual(['EST', 'CST', 'MST', 'PST', 'AKST', 'HST']);
  });
});

/**
 * The business day decides "today" for the CRM's own figures. It must not move
 * with the server's clock, must follow BUSINESS_TIMEZONE, and must survive the
 * two days a year that are not 24 hours long.
 */
describe('business day (BUSINESS_TIMEZONE)', () => {
  const withZone = async (zone: string | undefined, fn: () => void | Promise<void>) => {
    const prev = process.env.BUSINESS_TIMEZONE;
    if (zone === undefined) delete process.env.BUSINESS_TIMEZONE;
    else process.env.BUSINESS_TIMEZONE = zone;
    try {
      await fn();
    } finally {
      if (prev === undefined) delete process.env.BUSINESS_TIMEZONE;
      else process.env.BUSINESS_TIMEZONE = prev;
    }
  };

  // 2026-08-14 00:30 IST — India is on the 14th, Eastern still on the 13th.
  const indianMidnightPassed = new Date('2026-08-13T19:00:00Z');

  it('defaults to Eastern, so an Indian evening shift stays on the US date', () =>
    withZone(undefined, () => {
      expect(businessTimezone()).toBe('EST');
      expect(businessDay(indianMidnightPassed)).toBe('2026-08-13');
      expect(startOfBusinessDay(indianMidnightPassed).toISOString()).toBe('2026-08-13T04:00:00.000Z');
      expect(endOfBusinessDay(indianMidnightPassed).toISOString()).toBe('2026-08-14T03:59:59.999Z');
    }));

  it('follows BUSINESS_TIMEZONE when it names a known zone', () =>
    withZone('IND', () => {
      expect(businessDay(indianMidnightPassed)).toBe('2026-08-14');
      expect(startOfBusinessDay(indianMidnightPassed).toISOString()).toBe('2026-08-13T18:30:00.000Z');
      expect(businessIana()).toBe('Asia/Kolkata');
    }));

  it('falls back to Eastern for an unknown code rather than to the server clock', () =>
    withZone('NOT-A-ZONE', () => {
      expect(businessTimezone()).toBe('EST');
    }));

  it('spans a 25-hour day at the end of daylight time', () =>
    withZone('EST', () => {
      // 2026-11-01: US clocks fall back, so the day is 25 hours long.
      const start = businessDayStart('2026-11-01');
      const end = businessDayEnd('2026-11-01');
      expect(start.toISOString()).toBe('2026-11-01T04:00:00.000Z');
      expect(end.toISOString()).toBe('2026-11-02T04:59:59.999Z');
      expect(end.getTime() + 1 - start.getTime()).toBe(25 * 3_600_000);
    }));

  it('reads weekday and hour on the business clock', () =>
    withZone('EST', () => {
      // Friday 2026-08-14 00:30 IST is Thursday 15:00 in New York.
      expect(businessWeekdayHour(indianMidnightPassed)).toEqual({ weekday: 4, hour: 15 });
    }));
});
