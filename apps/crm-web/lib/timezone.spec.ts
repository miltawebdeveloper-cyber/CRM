import { describe, expect, it } from '@jest/globals';
import { leadDate, leadDateTime, leadTime, zoneNote } from './timezone';
import { formatDate, formatDateTime } from './display-settings';

/**
 * A lead's timestamps are read on the LEAD's clock, never the reader's.
 *
 * The instant these tests keep using is the one that made the difference worth
 * making: 2026-08-14T22:30:00Z is 6:30pm on the 14th in New York and 4:00am on
 * the 15th in Chennai. Every lead-owned date in the module used to be rendered
 * on whichever of those the person looking happened to be on, so a lead created
 * on the 14th was filed under the 15th by its own manager — while the next-day
 * sweep, which has always worked on the lead's calendar, correctly treated it as
 * the 14th. The screen and the queue disagreed about what day it was.
 */
describe('lead-zone formatters', () => {
  // 6:30pm Eastern on 14 Aug 2026. Already the 15th in India.
  const EVENING_IN_NY = '2026-08-14T22:30:00Z';

  it('dates an Eastern lead by the Eastern calendar', () => {
    expect(leadDate(EVENING_IN_NY, 'EST')).toBe('Aug 14, 2026');
  });

  it('gives the same instant a different date for a lead whose own day has turned', () => {
    // An India-zone lead genuinely IS on the 15th at that moment. Same instant,
    // different lead, different answer — which is the point of reading each
    // lead on its own clock rather than one clock for all of them.
    expect(leadDate(EVENING_IN_NY, 'IND')).toBe('Aug 15, 2026');
  });

  it('walks the US zones across the same instant', () => {
    // Still the 14th everywhere in the US at this moment, at four different
    // hours — the hour is what differs, not the day.
    expect(leadDateTime(EVENING_IN_NY, 'EST')).toBe('Aug 14, 2026, 06:30 PM');
    expect(leadDateTime(EVENING_IN_NY, 'CST')).toBe('Aug 14, 2026, 05:30 PM');
    expect(leadDateTime(EVENING_IN_NY, 'MST')).toBe('Aug 14, 2026, 04:30 PM');
    expect(leadDateTime(EVENING_IN_NY, 'PST')).toBe('Aug 14, 2026, 03:30 PM');
    expect(leadDateTime(EVENING_IN_NY, 'HST')).toBe('Aug 14, 2026, 12:30 PM');
  });

  it('follows daylight time rather than a fixed offset', () => {
    // The zone is stored as "EST" but the lead is in New York, which is on EDT
    // for two thirds of the year. A literal UTC-5 would state every summer
    // timestamp an hour early.
    expect(leadDateTime('2026-01-14T22:30:00Z', 'EST')).toBe('Jan 14, 2026, 05:30 PM'); // EST, UTC-5
    expect(leadDateTime('2026-08-14T22:30:00Z', 'EST')).toBe('Aug 14, 2026, 06:30 PM'); // EDT, UTC-4
  });

  it('renders exactly the format the rest of the CRM renders', () => {
    // The requirement is that ONLY the zone changes. Both formatters are fed the
    // same shapes from one place, so this compares the output of each against
    // the reader's-clock version of the same call — the text differs only where
    // the two clocks differ.
    const noon = '2026-08-14T16:00:00Z'; // midday Eastern, same date in most zones
    expect(leadDate(noon, 'EST')).toMatch(/^[A-Z][a-z]{2} \d{1,2}, \d{4}$/);
    expect(leadDateTime(noon, 'EST')).toMatch(/^[A-Z][a-z]{2} \d{1,2}, \d{4}, \d{2}:\d{2} [AP]M$/);
    expect(leadTime(noon, 'EST')).toMatch(/^\d{2}:\d{2} [AP]M$/);
    // Same shape as the reader's-clock formatters, character class for character
    // class — a format change in one would have to be a change in both.
    expect(formatDate(noon).replace(/\d/g, '#')).toBe(leadDate(noon, 'EST').replace(/\d/g, '#'));
    expect(formatDateTime(noon).replace(/\d/g, '#')).toBe(leadDateTime(noon, 'EST').replace(/\d/g, '#'));
  });

  it('honours the caller\'s fallback for a missing value', () => {
    // The export wants an empty cell; the grid wants an em dash.
    expect(leadDate(null, 'EST', '')).toBe('');
    expect(leadDateTime(undefined, 'EST', '')).toBe('');
    expect(leadDate(null, 'EST')).toBe('—');
  });

  it('falls back to Eastern for a lead with no zone — the same clock the sweep uses', () => {
    // NOT the reader's clock. The API decides a zone-less lead's calendar day in
    // Eastern (`ianaFor` defaults there), and the next-day sweep moves the lead
    // on that basis, so the screen has to agree with it.
    expect(leadDate(EVENING_IN_NY, null)).toBe('Aug 14, 2026');
    expect(leadDate(EVENING_IN_NY, undefined)).toBe('Aug 14, 2026');
    // An unrecognised code is treated the same way rather than throwing.
    expect(leadDate(EVENING_IN_NY, 'NOT_A_ZONE')).toBe('Aug 14, 2026');
  });
});

/**
 * The zone is not in the rendered format — the formats were to stay exactly as
 * they were — so it has to be recoverable somewhere. It hangs off the cell.
 */
describe('zoneNote', () => {
  it('names the clock a configured lead is shown on', () => {
    const note = zoneNote('CST');
    expect(note).toContain('Central');
    expect(note).toMatch(/lead's time zone/);
  });

  it('says plainly when a lead has no zone and the date rests on the default', () => {
    // A person reading a defaulted date needs to know it is defaulted, because
    // the fix is to set the lead's zone — not to reinterpret the number.
    const note = zoneNote(null);
    expect(note).toContain('no time zone set');
    expect(note).toContain('Eastern');
    // And it must not claim to be the lead's own zone.
    expect(note).not.toMatch(/lead's time zone: /);
  });
});
