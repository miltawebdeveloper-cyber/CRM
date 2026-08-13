import { describe, expect, it } from '@jest/globals';
import { Timezone } from '@crm/database';
import { dayInZone, sameDayInZone, startOfDayInZone } from './timezone';

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
    expect(dayInZone(indianMidnightPassed, Timezone.EST)).toBe('2026-08-13');
    expect(dayInZone(indianMidnightPassed, Timezone.CST)).toBe('2026-08-13');
    expect(dayInZone(indianMidnightPassed, Timezone.MST)).toBe('2026-08-13');
    expect(dayInZone(indianMidnightPassed, Timezone.PST)).toBe('2026-08-13');
    // And the server's own clock is what would have got this wrong.
    expect(dayInZone(indianMidnightPassed, null)).toBe('2026-08-13');
  });

  it('holds a lead on its date until that date ends in ITS zone, not India s', () => {
    // 23:30 EDT on the 13th — the 14th everywhere in India for hours already.
    const lateOn13thEast = new Date('2026-08-14T03:30:00Z');
    expect(dayInZone(lateOn13thEast, Timezone.EST)).toBe('2026-08-13');
    // Half an hour later the east coast turns over, and only then does it move.
    const justInto14thEast = new Date('2026-08-14T04:30:00Z');
    expect(dayInZone(justInto14thEast, Timezone.EST)).toBe('2026-08-14');
  });

  it('turns each US zone over at its own moment, not all at once', () => {
    // 2026-08-14 02:30 UTC: already the 14th on the east coast, still the 13th
    // on the west. A single nightly boundary cannot be right for both.
    const between = new Date('2026-08-14T04:30:00Z');
    expect(dayInZone(between, Timezone.EST)).toBe('2026-08-14');
    expect(dayInZone(between, Timezone.PST)).toBe('2026-08-13');
  });

  it('startOfDayInZone returns the instant that zone s day actually began', () => {
    const at = new Date('2026-08-13T19:00:00Z'); // 15:00 EDT on the 13th
    const start = startOfDayInZone(Timezone.EST, at);
    // Midnight EDT on the 13th is 04:00 UTC the same date.
    expect(start.toISOString()).toBe('2026-08-13T04:00:00.000Z');
    // And the day it belongs to reads back as the 13th, not the 12th — the
    // off-by-one a naive offset subtraction produces.
    expect(dayInZone(start, Timezone.EST)).toBe('2026-08-13');
  });

  it('sameDayInZone disagrees with the server exactly when it should', () => {
    const assignedAt = new Date('2026-08-13T19:00:00Z'); // 13th in the US, 14th in India
    const now = new Date('2026-08-13T23:00:00Z'); // still the 13th in the US
    expect(sameDayInZone(assignedAt, now, Timezone.EST)).toBe(true);

    // Once the lead's own day turns, the two stop being the same day.
    const nextDayEast = new Date('2026-08-14T05:00:00Z');
    expect(sameDayInZone(assignedAt, nextDayEast, Timezone.EST)).toBe(false);
    // The west coast has not turned over yet at that same instant.
    expect(sameDayInZone(assignedAt, nextDayEast, Timezone.PST)).toBe(true);
  });

  it('handles a lead with no zone without falling back to the server s', () => {
    // Unset zones default to a US zone, never to IST — wrong by hours beats
    // wrong by half a day, and half a day is what flips the date.
    expect(dayInZone(indianMidnightPassed, null)).toBe('2026-08-13');
  });
});
