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

/** The lead time zones the CRM supports. Mirrors the API's Timezone enum. */
export type LeadTimezone = 'EST' | 'CST' | 'MST' | 'PST';

/**
 * Region zones, not fixed offsets: `America/New_York` follows daylight time,
 * where a literal `EST` would sit an hour out for most of the year.
 */
const IANA: Record<LeadTimezone, string> = {
  EST: 'America/New_York',
  CST: 'America/Chicago',
  MST: 'America/Denver',
  PST: 'America/Los_Angeles',
};

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
