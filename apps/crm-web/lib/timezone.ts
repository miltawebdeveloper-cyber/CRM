/**
 * Lead time zones on the web side.
 *
 * Deliberately display-only. The API owns the one conversion that matters —
 * turning a typed wall-clock time into an instant — because it is the side that
 * knows the lead's zone for certain and is the only side both the panel and every
 * other client go through. The forms here therefore send the wall clock exactly
 * as the rep typed it (`2026-08-01T16:00`, no zone) and let the API read it in the
 * lead's zone. Converting here first, as the Zoom form used to with
 * `new Date(v).toISOString()`, silently books the meeting in the BROWSER's zone,
 * which is wrong for any rep not sitting in the customer's time zone.
 */

/**
 * Region zones, not fixed offsets: `America/New_York` follows daylight time,
 * where a literal `EST` would sit an hour out for most of the year. Same reason
 * for `Europe/London` over `GMT`. Mirrors the API's `IANA_BY_TIMEZONE`, and the
 * key order mirrors the `Timezone` enum's declaration order — which is the order
 * every dropdown below offers them in.
 */
const IANA = {
  UK: 'Europe/London',
  IND: 'Asia/Kolkata',
  EST: 'America/New_York',
  CST: 'America/Chicago',
  MST: 'America/Denver',
  PST: 'America/Los_Angeles',
  AKST: 'America/Anchorage',
  HST: 'Pacific/Honolulu',
} as const;

/** The lead time zones the CRM supports. Mirrors the API's Timezone enum. */
export type LeadTimezone = keyof typeof IANA;

/** Full names, as the filters and pickers spell them out. */
export const TIMEZONE_LABELS: Record<LeadTimezone, string> = {
  UK: 'UK (Europe/London)',
  IND: 'India (Asia/Kolkata)',
  EST: 'EST (Eastern Standard Time)',
  CST: 'CST (Central Standard Time)',
  MST: 'MST (Mountain Standard Time)',
  PST: 'PST (Pacific Standard Time)',
  AKST: 'AKST (Alaska Standard Time)',
  HST: 'HST (Hawaii Standard Time)',
};

/**
 * Every zone code, in offer order. Derived from `IANA` rather than written out
 * again, so a zone can't be added to the CRM and then be missing from one filter
 * — which is exactly how six screens ended up hardcoding the four US zones.
 */
export const TIMEZONE_CODES = Object.keys(IANA) as LeadTimezone[];

/**
 * The zones a rep can pick from: the scheduler's inline zone prompt, the lead
 * form, the import mapper and every zone filter all read this one list.
 */
export const LEAD_TIMEZONES: { value: LeadTimezone; label: string }[] = TIMEZONE_CODES.map((value) => ({
  value,
  label: TIMEZONE_LABELS[value],
}));

/**
 * Options for a zone <select> that can also mean "don't filter". The empty value
 * is the no-filter sentinel every list endpoint already treats as absent.
 *
 * Spelled out in full, for a control with room for it — the Call Panel's own
 * dropdown, which owns a whole column.
 */
export const TIMEZONE_FILTER_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: 'All Time Zones' },
  ...LEAD_TIMEZONES,
];

/**
 * The same filter, by code, for the horizontal filter BARS.
 *
 * A native `<select>` takes its width from its widest option, so
 * `EST (Eastern Standard Time)` makes the zone filter roughly twice the width of
 * its neighbours — enough on its own to push the last filter in the row onto a
 * second line. The codes are the CRM's own vocabulary and are what these bars
 * showed before the zone list grew, so nothing is lost by using them where space
 * is shared; `UK` and `India` are named rather than coded because neither has a
 * code anyone would recognise.
 */
export const TIMEZONE_FILTER_OPTIONS_COMPACT: { value: string; label: string }[] = [
  { value: '', label: 'All Time Zones' },
  ...TIMEZONE_CODES.map((value) => ({ value, label: value === 'IND' ? 'India' : value })),
];

/**
 * How a lead with no zone set is named in filters and groupings. Must match the
 * API's `UNSET_TIMEZONE_LABEL` — the leads list sends this value straight back
 * as a filter, where it selects the rows with no zone.
 */
export const UNSET_TIMEZONE_LABEL = 'Unassigned';

/** Is this lead's zone actually configured? Nothing may be scheduled until it is. */
export const hasLeadZone = (tz?: string | null): tz is LeadTimezone =>
  !!tz && tz in IANA;

const DEFAULT_TZ: LeadTimezone = 'EST';

const zoneOf = (tz?: string | null): string => IANA[(tz as LeadTimezone) ?? DEFAULT_TZ] ?? IANA[DEFAULT_TZ];

/**
 * A scheduled time as the CUSTOMER sees it, with the zone named. The label is not
 * decoration: "4:00 PM" against a lead three zones away is how a rep rings at the
 * wrong hour, so every scheduled time in the UI carries its zone.
 */
export function formatInLeadZone(iso: string | null | undefined, tz?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: zoneOf(tz),
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(d);
}

/** Same, but says "Today" for an appointment falling on today in the lead's zone. */
export function formatScheduleInLeadZone(iso: string | null | undefined, tz?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const zone = zoneOf(tz);
  const day = (x: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(x);
  const time = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(d);
  return day(d) === day(new Date()) ? `Today, ${time}` : formatInLeadZone(iso, tz);
}

/**
 * Calendar day (`YYYY-MM-DD`) an instant falls on in the lead's zone. Comparing
 * these strings is how "is this callback due today?" is answered on the
 * customer's calendar rather than the rep's — the two are a different date for
 * several hours every day.
 */
export function dayInLeadZone(iso: string | Date | null | undefined, tz?: string | null): string {
  if (!iso) return '';
  const d = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: zoneOf(tz),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/**
 * Echo a typed wall clock (`2026-08-01T14:00`) back in readable form, labelled
 * with the lead's configured zone.
 *
 * Deliberately does NOT convert: the API stores exactly this wall clock read in
 * exactly this zone, so echoing it is both the truth and the only rendering that
 * can't drift from what the rep typed. Running it through `new Date()` first —
 * which resolves it in the browser's zone — is what this whole module exists to
 * stop. The configured code (EST/CST/…) is used rather than the seasonal
 * abbreviation, because picking EST vs EDT correctly needs the conversion the
 * API owns.
 */
export function describeWallClock(wallClock: string, tz?: string | null): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(wallClock ?? '');
  if (!m) return '';
  const [, y, mo, d, hh, mi] = m;
  // Built as a UTC instant and rendered as UTC, so the numbers come back out
  // exactly as typed — this is formatting, not a time-zone conversion.
  const shown = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(hh), Number(mi)));
  const text = new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(shown);
  return `${text} ${(tz as LeadTimezone) ?? DEFAULT_TZ}`;
}

/** Short zone label for the current date, e.g. `EDT` in summer — for form hints. */
export function zoneLabel(tz?: string | null): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zoneOf(tz), timeZoneName: 'short' }).formatToParts(new Date());
  return parts.find((p) => p.type === 'timeZoneName')?.value ?? (tz ?? DEFAULT_TZ);
}

// ── The one conversion this module does perform ──
//
// Everything above is display-only, and deliberately so: the API owns the
// wall-clock → instant conversion that gets STORED. What follows converts only
// to answer two questions the rep needs answered before they submit — "what time
// is that for me?" and "has that time already gone?" — and it is a mirror of the
// API's `parseInZone` so the two can't disagree about the same input.

const WALL_CLOCK = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/;

/** A zone's UTC offset in ms at an instant, read off Intl rather than tabulated. */
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
  const hour = get('hour') % 24; // some ICU builds render midnight as 24
  return Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second')) - instant.getTime();
}

/**
 * The instant a typed wall clock refers to, read in the LEAD's zone — the same
 * reading the API will make of the same string when it stores it.
 *
 * Returns null for an unparseable or empty value, and for a lead with no zone:
 * with no zone there is no instant to compute, and guessing one is what puts a
 * call an hour out.
 */
export function leadWallClockToInstant(wallClock: string, tz?: string | null): Date | null {
  const m = WALL_CLOCK.exec(wallClock ?? '');
  if (!m || !hasLeadZone(tz)) return null;
  const [, y, mo, d, hh, mi] = m;
  const zone = IANA[tz];
  const asIfUtc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(hh), Number(mi));
  // Two passes: the offset has to be sampled at the resulting instant, not the
  // guess, or a time within a few hours of a DST boundary lands an hour out.
  const firstPass = new Date(asIfUtc - offsetMsAt(new Date(asIfUtc), zone));
  return new Date(asIfUtc - offsetMsAt(firstPass, zone));
}

/**
 * The same instant on the REP's own clock, zone named.
 *
 * This is the half of the scheduler that stops the rep booking a time they can't
 * work: "10:00 AM EST" tells an agent in India nothing about whether they will be
 * at their desk, and "8:30 PM IST" beside it tells them immediately.
 */
export function formatInUserZone(date: Date | null): string {
  if (!date || Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(date);
}

/** The rep's own zone, e.g. `IST` — for labelling their side of the comparison. */
export function userZoneLabel(): string {
  const parts = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' }).formatToParts(new Date());
  return parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
}

/**
 * Has this typed time already gone by where the CUSTOMER is?
 *
 * Asked on the customer's clock, not the rep's — those disagree for several
 * hours of every day, and it is the customer's clock the callback fires on. The
 * same 60-second grace the API allows, so the form and the server can't reach
 * opposite answers about a time typed right on the boundary.
 */
export function isPastInLeadZone(wallClock: string, tz?: string | null, now: Date = new Date()): boolean {
  const at = leadWallClockToInstant(wallClock, tz);
  if (!at) return false; // nothing to judge — the zone prompt handles this case
  return at.getTime() < now.getTime() - 60_000;
}

/**
 * The lead's current wall clock as `YYYY-MM-DDTHH:mm`, for seeding a date/time
 * picker. A picker that opens on the REP's today can offer a date that is still
 * yesterday for the customer, so it opens on theirs.
 */
export function nowInLeadZone(tz?: string | null): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zoneOf(tz),
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date());
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '00';
  const hour = String(Number(get('hour')) % 24).padStart(2, '0');
  return `${get('year')}-${get('month')}-${get('day')}T${hour}:${get('minute')}`;
}
