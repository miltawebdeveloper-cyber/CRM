/**
 * The business day — what "today" means for date presets and day filters.
 *
 * The API counts "today" (dashboard KPIs, productivity, Zoom due today, day
 * filters) on one explicit zone, BUSINESS_TIMEZONE, and tells the browser which
 * one through `/auth/me`. The browser's own clock is the wrong answer here: an
 * agent in India working US hours would otherwise click "Today" at 1 AM IST and
 * ask for a date the business — and the server's dashboards — have not reached.
 *
 * This is NOT the display zone (lib/display-settings.ts), which decides how a
 * timestamp is printed for the reader. It only decides which calendar day it is.
 */

/** Until `/auth/me` says otherwise — matches the API's own default. */
let businessZone = 'America/New_York';

function isValidZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Adopt the zone the API reports. Ignores anything the browser can't use. */
export function setBusinessTimezone(tz: unknown): void {
  if (typeof tz === 'string' && tz && isValidZone(tz)) businessZone = tz;
}

export const getBusinessTimezone = (): string => businessZone;

/** `yyyy-mm-dd` of an instant on the business calendar. */
export function businessDate(at: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: businessZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(at);
  const get = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/**
 * Today's business date as a LOCAL-midnight `Date`, for calendar widgets that
 * model a day as a local Date object (and turn it back into `yyyy-mm-dd` with
 * local getters). The instant itself is meaningless; only its y/m/d are read.
 */
export function businessTodayLocal(): Date {
  const [y, m, d] = businessDate().split('-').map(Number);
  return new Date(y, m - 1, d);
}
