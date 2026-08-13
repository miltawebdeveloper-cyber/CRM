import { BadRequestException } from '@nestjs/common';
import { Timezone } from '@crm/database';

/**
 * Lead time zones, and the one place a wall-clock time is turned into an instant.
 *
 * Every lead carries a calling region, and a callback or Zoom meeting is agreed in
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
 * daylight time, so a summer callback would fire at the wrong hour. The same
 * reasoning picks `Europe/London` over `GMT` (British Summer Time) and
 * `America/Anchorage` over `AKST`.
 *
 * `Asia/Kolkata` and `Pacific/Honolulu` observe no daylight time, so for those
 * two the region and the offset happen to coincide all year — they are written
 * as regions anyway, so every entry here is read the same way.
 */
export const IANA_BY_TIMEZONE: Record<Timezone, string> = {
  [Timezone.UK]: 'Europe/London',
  [Timezone.IND]: 'Asia/Kolkata',
  [Timezone.EST]: 'America/New_York',
  [Timezone.CST]: 'America/Chicago',
  [Timezone.MST]: 'America/Denver',
  [Timezone.PST]: 'America/Los_Angeles',
  [Timezone.AKST]: 'America/Anchorage',
  [Timezone.HST]: 'Pacific/Honolulu',
};

/**
 * Every zone the CRM supports, in the order the UI offers them. Derived from the
 * map above so a zone added to the enum cannot be left out of a filter, a chart
 * or a dropdown — which is how the analytics breakdown came to enumerate four
 * zones by hand and quietly total less than the lead count.
 */
export const ALL_TIMEZONES = Object.keys(IANA_BY_TIMEZONE) as Timezone[];

/** Human name for a zone, for dropdowns and reports. */
export const TIMEZONE_LABELS: Record<Timezone, string> = {
  [Timezone.UK]: 'UK (Europe/London)',
  [Timezone.IND]: 'India (Asia/Kolkata)',
  [Timezone.EST]: 'EST (Eastern Standard Time)',
  [Timezone.CST]: 'CST (Central Standard Time)',
  [Timezone.MST]: 'MST (Mountain Standard Time)',
  [Timezone.PST]: 'PST (Pacific Standard Time)',
  [Timezone.AKST]: 'AKST (Alaska Standard Time)',
  [Timezone.HST]: 'HST (Hawaii Standard Time)',
};

/**
 * Fallback used only when RENDERING a record with no zone — a label has to say
 * something. It is deliberately not used when scheduling: see `parseFutureInZone`,
 * which refuses rather than guessing, because a guessed zone is a call placed at
 * the wrong hour.
 */
export const DEFAULT_TIMEZONE = Timezone.EST;

/**
 * How a lead with no configured zone appears in groupings, filters and reports.
 * One constant so the Analytics breakdown, the Territory tree and the assignment
 * buckets all name the same pile the same way.
 */
export const UNSET_TIMEZONE_LABEL = 'Unassigned';

/** Zone code for display/grouping, with unconfigured leads given their own bucket. */
export const tzLabel = (tz?: Timezone | null): string => tz ?? UNSET_TIMEZONE_LABEL;

/**
 * Turn a zone filter value back into a Prisma `where` fragment. The inverse of
 * `tzLabel`: `Unassigned` selects the rows with no zone rather than looking for
 * a zone by that name, which would match nothing.
 */
export const timezoneWhere = (value?: string | null): { timezone?: Timezone | null } => {
  if (!value) return {};
  if (value === UNSET_TIMEZONE_LABEL) return { timezone: null };
  return { timezone: value as Timezone };
};

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

/**
 * A booking submitted at 09:59:59 for "today 10:00" must not be rejected because
 * the request landed a second late, and a rep's clock is rarely exactly the
 * server's. Anything inside this window of now counts as "not in the past".
 */
const PAST_GRACE_MS = 60 * 1000;

/**
 * Read a scheduling input as an instant, insisting the record has a zone and
 * that the time has not already gone by there.
 *
 * Both checks exist because the alternative is silent and wrong rather than
 * loud. A lead with no zone would fall back to Eastern under `ianaFor`, so a
 * Pacific customer would be booked three hours out and nothing would say so —
 * hence the zone is demanded rather than assumed. And a callback typed for a
 * time already past in the customer's zone can never fire as an upcoming
 * reminder; it lands straight in the missed pile, which reads to the rep as a
 * callback they failed rather than one they mistyped.
 *
 * `null`/empty passes through as null — clearing a callback is not scheduling
 * one. Returns the instant otherwise, and throws `BadRequestException` with a
 * message written for the rep, not the log.
 */
export function parseFutureInZone(
  value: string | null | undefined,
  tz: Timezone | null | undefined,
  what = 'callback',
  now = new Date(),
): Date | null {
  if (!value?.trim()) return null;

  if (!tz) {
    throw new BadRequestException(
      `This lead has no time zone set, so a ${what} time can't be pinned to the customer's clock. Set the lead's time zone first.`,
    );
  }

  const at = parseInZone(value, tz);
  if (!at) throw new BadRequestException(`That ${what} date and time could not be read.`);

  if (at.getTime() < now.getTime() - PAST_GRACE_MS) {
    throw new BadRequestException(
      `That ${what} time has already passed in the lead's time zone (${formatInZone(at, tz)}). Pick a later time.`,
    );
  }
  return at;
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

/** Wall-clock time (`HH:mm`) an instant reads as in the given zone. */
export function timeInZone(date: Date, tz?: Timezone | null): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: ianaFor(tz),
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '00';
  // `hour12: false` renders midnight as 24 in some ICU versions.
  return `${String(Number(get('hour')) % 24).padStart(2, '0')}:${get('minute')}`;
}

/**
 * Days the team works. Saturday and Sunday are off by default; set
 * `WORKING_DAYS` to a comma-separated list of day numbers (0 = Sunday) for a
 * team that works another week — a Sunday-to-Thursday week is a configuration,
 * not a code change.
 */
export function workingDays(): Set<number> {
  const raw = (process.env.WORKING_DAYS ?? '').trim();
  if (!raw) return new Set([1, 2, 3, 4, 5]);
  const days = raw
    .split(/[,\s]+/)
    .map((d) => Number(d))
    .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
  // An unreadable setting falls back to Mon–Fri rather than to "no working days
  // at all", which would leave a rescheduler with nowhere to move anything to.
  return days.length ? new Set(days) : new Set([1, 2, 3, 4, 5]);
}

/**
 * The next working day strictly after `day` (both `yyyy-mm-dd`).
 *
 * Pure calendar arithmetic on the date string — no zone is involved, because a
 * date has no offset: "the day after 2026-08-14" is 2026-08-15 wherever you
 * stand. The instant is only re-derived once the day is known, by reading the
 * new day and the original wall-clock time back in the customer's zone, which is
 * what keeps a 10:00 callback at 10:00 rather than drifting by the DST hour.
 */
export function nextWorkingDay(day: string, working = workingDays()): string {
  const [y, m, d] = day.split('-').map(Number);
  const cursor = new Date(Date.UTC(y, m - 1, d));
  // Bounded: a caller that somehow passes an empty working week gets one step
  // rather than an infinite loop.
  for (let i = 0; i < 7; i++) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    if (working.has(cursor.getUTCDay())) break;
  }
  return cursor.toISOString().slice(0, 10);
}
