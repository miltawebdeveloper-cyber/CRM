import { Timezone } from '@crm/database';

/**
 * Lead time zones, and the one place a wall-clock time is turned into an instant.
 *
 * Every lead carries a US time zone, and a callback or Zoom meeting is agreed in
 * the CUSTOMER's local time — "four o'clock" means four o'clock where they are.
 * Nothing used to carry that: the panel posted a bare `2026-08-01T16:00` and the
 * API ran it through `new Date()`, which reads it in whatever zone the server
 * happens to run in. A CRM hosted in Asia therefore booked every American
 * callback the better part of a day out, and the Zoom form disagreed with the
 * callback form because it converted using the BROWSER's zone instead. This
 * module is what makes both mean the same thing.
 */

/**
 * Region zones, not fixed offsets. `America/New_York` is deliberate: the fixed
 * `EST` zone would sit an hour out for the two thirds of the year the US is on
 * daylight time, so a summer callback would fire at the wrong hour.
 */
export const IANA_BY_TIMEZONE: Record<Timezone, string> = {
  [Timezone.EST]: 'America/New_York',
  [Timezone.CST]: 'America/Chicago',
  [Timezone.MST]: 'America/Denver',
  [Timezone.PST]: 'America/Los_Angeles',
};

/** Fallback for a record with no zone of its own. */
export const DEFAULT_TIMEZONE = Timezone.EST;

export const ianaFor = (tz?: Timezone | null): string => IANA_BY_TIMEZONE[tz ?? DEFAULT_TIMEZONE];

/** A bare wall clock — no zone, no offset — e.g. `2026-08-01T16:00`. */
const WALL_CLOCK = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/;

/**
 * The zone's UTC offset in ms at a given instant, worked out by asking Intl what
 * the local clock reads there and comparing. This is what makes daylight time
 * fall out for free rather than being a table we would have to maintain.
 */
function offsetMsAt(instant: Date, ianaZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: ianaZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  // `hour12: false` renders midnight as 24 in some ICU versions.
  const hour = get('hour') % 24;
  const asIfUtc = Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second'));
  return asIfUtc - instant.getTime();
}

/**
 * Read a scheduling input as an instant.
 *
 * A value carrying its own zone (`…Z`, `…+05:30`) is already unambiguous and is
 * honoured as-is — that keeps every existing API client working. A bare wall
 * clock is read in the LEAD's zone, which is what the Calling Panel sends and
 * what "use the lead's configured time zone" means in practice.
 *
 * Returns null for empty input, so callers can pass a cleared field straight
 * through, and for a value neither branch can parse — an unparseable date must
 * not silently become `Invalid Date` in the column.
 */
export function parseInZone(value: string | null | undefined, tz?: Timezone | null): Date | null {
  const raw = value?.trim();
  if (!raw) return null;

  const m = WALL_CLOCK.exec(raw);
  if (!m) {
    const explicit = new Date(raw);
    return Number.isNaN(explicit.getTime()) ? null : explicit;
  }

  const [, y, mo, d, hh, mi, ss] = m;
  const zone = ianaFor(tz);
  // Treat the wall clock as if it were UTC, then subtract the zone's offset. The
  // offset has to be sampled at the resulting instant rather than the guess,
  // because the two straddle a DST boundary twice a year — hence the second pass.
  const asIfUtc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(hh), Number(mi), Number(ss ?? 0));
  const firstPass = new Date(asIfUtc - offsetMsAt(new Date(asIfUtc), zone));
  const settled = new Date(asIfUtc - offsetMsAt(firstPass, zone));
  return settled;
}

/**
 * Render an instant as the customer's local time, always with the zone spelled
 * out. Reminders and notifications go through here: "3:00 PM" with no zone is
 * how a rep rings an hour early, so the label is not optional.
 */
export function formatInZone(date: Date, tz?: Timezone | null): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: ianaFor(tz),
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(date);
}

/** Calendar day (`yyyy-mm-dd`) an instant falls on in the given zone. */
export function dayInZone(date: Date, tz?: Timezone | null): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: ianaFor(tz),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}
