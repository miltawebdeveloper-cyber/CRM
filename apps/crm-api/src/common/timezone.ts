import { BadRequestException } from '@nestjs/common';

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
 *
 * Zone codes are admin-managed data (`TimezoneOption`, Admin → Timezones), not a
 * fixed enum any more — an admin can add one without a deploy. Every function
 * below reads a synchronous in-memory snapshot rather than the DB directly,
 * because they are called from deep inside other synchronous code all over the
 * API and cannot become `async` without rippling into every caller. The one
 * place that keeps the snapshot current is `TimezonesCacheService`
 * (modules/timezones) — this file has no Prisma client of its own, deliberately,
 * so it stays importable (and correct, via the fallback below) from a bare unit
 * test with no Nest app bootstrapped.
 */

interface TimezoneEntry {
  code: string;
  label: string;
  ianaZone: string;
  /** Country.code the zone belongs to; null = not tied to a country. */
  countryCode?: string | null;
}

/**
 * The exact 8 zones this CRM shipped with, verbatim — what seeds the live
 * `timezone_options` table, and what this module falls back to before that
 * table has been read even once, or if a live read ever comes back empty. A
 * failed/truncated query must never wipe out every zone the CRM knows.
 *
 * Region zones, not fixed offsets. `America/New_York` is deliberate: the fixed
 * `EST` zone would sit an hour out for the two thirds of the year the US is on
 * daylight time, so a summer callback would fire at the wrong hour. The same
 * reasoning picks `Europe/London` over `GMT` (British Summer Time) and
 * `America/Anchorage` over `AKST`. `Asia/Kolkata` and `Pacific/Honolulu` observe
 * no daylight time, so for those two the region and the offset happen to
 * coincide all year — they are written as regions anyway, so every entry here
 * is read the same way.
 */
const FALLBACK: TimezoneEntry[] = [
  { code: 'UK', label: 'UK (Europe/London)', ianaZone: 'Europe/London', countryCode: 'UK' },
  { code: 'IND', label: 'India (Asia/Kolkata)', ianaZone: 'Asia/Kolkata', countryCode: 'India' },
  { code: 'EST', label: 'EST (Eastern Standard Time)', ianaZone: 'America/New_York', countryCode: 'USA' },
  { code: 'CST', label: 'CST (Central Standard Time)', ianaZone: 'America/Chicago', countryCode: 'USA' },
  { code: 'MST', label: 'MST (Mountain Standard Time)', ianaZone: 'America/Denver', countryCode: 'USA' },
  { code: 'PST', label: 'PST (Pacific Standard Time)', ianaZone: 'America/Los_Angeles', countryCode: 'USA' },
  { code: 'AKST', label: 'AKST (Alaska Standard Time)', ianaZone: 'America/Anchorage', countryCode: 'USA' },
  { code: 'HST', label: 'HST (Hawaii Standard Time)', ianaZone: 'Pacific/Honolulu', countryCode: 'USA' },
];

interface Snapshot {
  ianaByCode: Record<string, string>;
  labelByCode: Record<string, string>;
  countryByCode: Record<string, string | null>;
  codes: string[];
}

function buildSnapshot(rows: TimezoneEntry[]): Snapshot {
  const ianaByCode: Record<string, string> = {};
  const labelByCode: Record<string, string> = {};
  const countryByCode: Record<string, string | null> = {};
  const codes: string[] = [];
  for (const r of rows) {
    ianaByCode[r.code] = r.ianaZone;
    labelByCode[r.code] = r.label;
    countryByCode[r.code] = r.countryCode ?? null;
    codes.push(r.code);
  }
  return { ianaByCode, labelByCode, countryByCode, codes };
}

let snapshot: Snapshot = buildSnapshot(FALLBACK);

/**
 * Replace the live snapshot. Called by `TimezonesCacheService` after every DB
 * read — on boot, a 15s background refresh, and eagerly right after an admin
 * adds/edits a zone. Never adopts an empty list.
 */
export function setTimezoneSnapshot(rows: TimezoneEntry[]): void {
  if (rows.length) snapshot = buildSnapshot(rows);
}

/**
 * Every zone the CRM currently supports, in admin-configured order. Read this
 * rather than hardcoding a list — that is how the analytics breakdown once
 * came to enumerate four zones by hand and quietly total less than the lead
 * count.
 */
export const allTimezoneCodes = (): string[] => snapshot.codes;

/** The country a zone belongs to, or null when it isn't tied to one. */
export const countryOfZone = (code?: string | null): string | null =>
  (code && snapshot.countryByCode[code]) || null;

/** Zone codes belonging to a country (zones tied to no country are excluded). */
export const zonesOfCountry = (country: string): string[] =>
  snapshot.codes.filter((c) => snapshot.countryByCode[c] === country);

/**
 * Whether a zone may sit on a record with this country. Either side empty, or
 * a zone tied to no country, is always fine — only a zone that belongs to a
 * DIFFERENT country (India + EST) is a mismatch.
 */
export function zoneMatchesCountry(zone?: string | null, country?: string | null): boolean {
  if (!zone || !country) return true;
  const owner = countryOfZone(zone);
  return !owner || owner === country;
}

/**
 * Fallback used only when RENDERING a record with no zone — a label has to say
 * something. It is deliberately not used when scheduling: see `parseFutureInZone`,
 * which refuses rather than guessing, because a guessed zone is a call placed at
 * the wrong hour.
 */
export const DEFAULT_TIMEZONE = 'EST';

/**
 * How a lead with no configured zone appears in groupings, filters and reports.
 * One constant so the Analytics breakdown, the Territory tree and the assignment
 * buckets all name the same pile the same way.
 */
export const UNSET_TIMEZONE_LABEL = 'Unassigned';

/** Human name for a zone, for dropdowns and reports. */
export const timezoneLabel = (code?: string | null): string =>
  code ? (snapshot.labelByCode[code] ?? code) : UNSET_TIMEZONE_LABEL;

/** Zone code for display/grouping, with unconfigured leads given their own bucket. */
export const tzLabel = (tz?: string | null): string => tz ?? UNSET_TIMEZONE_LABEL;

/**
 * Turn a zone filter value back into a Prisma `where` fragment. The inverse of
 * `tzLabel`: `Unassigned` selects the rows with no zone rather than looking for
 * a zone by that name, which would match nothing.
 */
export const timezoneWhere = (value?: string | null): { timezone?: string | null } => {
  if (!value) return {};
  if (value === UNSET_TIMEZONE_LABEL) return { timezone: null };
  return { timezone: value };
};

export const ianaFor = (tz?: string | null): string =>
  snapshot.ianaByCode[tz ?? DEFAULT_TIMEZONE] ?? snapshot.ianaByCode[DEFAULT_TIMEZONE] ?? FALLBACK[2].ianaZone;

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
export function parseInZone(value: string | null | undefined, tz?: string | null): Date | null {
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
export function formatInZone(date: Date, tz?: string | null): string {
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
  tz: string | null | undefined,
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
export function dayInZone(date: Date, tz?: string | null): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: ianaFor(tz),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/**
 * The instant at which the given zone's CURRENT calendar day began.
 *
 * The boundary every "is this today?" question about a lead has to be measured
 * from. The server runs on IST, so `new Date().setHours(0,0,0,0)` answers "when
 * did the day start in India" — which is between 9.5 and 13.5 hours ahead of the
 * US, and on the wrong side of midnight for the whole Indian evening. An agent
 * assigning at 6pm IST is working on a US date that is still yesterday, and a
 * server-local boundary files that lead under tomorrow.
 *
 * A lead with no zone falls back to DEFAULT_TIMEZONE rather than to server time:
 * a US default is wrong by at most a few hours, IST is wrong by half a day.
 */
export function startOfDayInZone(tz?: string | null, at: Date = new Date()): Date {
  const day = dayInZone(at, tz);
  // Re-read midnight of that day back in the same zone, so DST is handled by the
  // same two-pass offset logic every other conversion here uses.
  return parseInZone(`${day}T00:00:00`, tz) ?? at;
}

/**
 * Whether two instants fall on the same calendar day in the given zone — the
 * zone-aware replacement for comparing against a server-local midnight.
 */
export function sameDayInZone(a: Date, b: Date, tz?: string | null): boolean {
  return dayInZone(a, tz) === dayInZone(b, tz);
}

/** Wall-clock time (`HH:mm`) an instant reads as in the given zone. */
export function timeInZone(date: Date, tz?: string | null): string {
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
