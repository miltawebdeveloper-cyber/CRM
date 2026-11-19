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
 *
 * Zone codes are admin-managed data (`TimezoneOption`, Admin → Timezones), not a
 * fixed set any more — an admin can add one without a deploy. Every lookup below
 * reads a synchronous in-memory snapshot rather than fetching, because this
 * module is called from render paths and table column definitions all over the
 * app that can't await a request. `timezone-options-sync.tsx` (mounted in
 * `app/(app)/layout.tsx`) is the one place that keeps the snapshot current —
 * mirrors the API's own `common/timezone.ts` + `TimezonesCacheService` split.
 */

import { useMemo, useSyncExternalStore } from 'react';
import {
  DATE_FORMAT,
  DATE_TIME_FORMAT,
  TIME_FORMAT,
  formatDate,
  formatDateTime,
  formatInZone,
  formatTime,
} from './display-settings';

interface TimezoneEntry {
  code: string;
  label: string;
  ianaZone: string;
  /** Omitted = active. An inactive zone still resolves (a lead may still be on
   *  it) but is no longer offered in pickers, filters or the import. */
  isActive?: boolean;
  /** Country.code the zone belongs to; null/omitted = offered with any country. */
  countryCode?: string | null;
}

/**
 * The exact 8 zones this CRM shipped with, verbatim — what this module falls
 * back to before the live list has been fetched even once, or if a fetch ever
 * comes back empty. A failed/slow request must never leave every zone filter
 * and picker in the app blank.
 */
const FALLBACK: TimezoneEntry[] = [
  { code: 'UK', label: 'UK (Europe/London)', ianaZone: 'Europe/London' },
  { code: 'IND', label: 'India (Asia/Kolkata)', ianaZone: 'Asia/Kolkata' },
  { code: 'EST', label: 'EST (Eastern Standard Time)', ianaZone: 'America/New_York' },
  { code: 'CST', label: 'CST (Central Standard Time)', ianaZone: 'America/Chicago' },
  { code: 'MST', label: 'MST (Mountain Standard Time)', ianaZone: 'America/Denver' },
  { code: 'PST', label: 'PST (Pacific Standard Time)', ianaZone: 'America/Los_Angeles' },
  { code: 'AKST', label: 'AKST (Alaska Standard Time)', ianaZone: 'America/Anchorage' },
  { code: 'HST', label: 'HST (Hawaii Standard Time)', ianaZone: 'Pacific/Honolulu' },
];

interface Snapshot {
  ianaByCode: Record<string, string>;
  labelByCode: Record<string, string>;
  countryByCode: Record<string, string | null>;
  /** Active codes only — what pickers, filters and the import offer. */
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
    if (r.isActive !== false) codes.push(r.code);
  }
  return { ianaByCode, labelByCode, countryByCode, codes };
}

let snapshot: Snapshot = buildSnapshot(FALLBACK);
const listeners = new Set<() => void>();

/** Replace the live snapshot. Called by `timezone-options-sync.tsx` after every
 *  fetch. Never adopts an empty list. */
export function setTimezoneSnapshot(rows: TimezoneEntry[]): void {
  if (!rows.length) return;
  snapshot = buildSnapshot(rows);
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => { listeners.delete(l); };
};
const getSnapshot = () => snapshot;

// Plain functions can't make a component repaint when the list changes, so a
// component that RENDERS the zone list (a picker or filter) reads it through
// one of these hooks instead. Formatters stay plain functions.
//
// Pass a country to get only that country's zones (plus any zone tied to no
// country) — this is what keeps India + EST from ever being offered.
export function useLeadTimezones(country?: string | null) {
  const s = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return useMemo(() => pickerOptions(s, country), [s, country]);
}
export function useTimezoneFilterOptions(country?: string | null) {
  const s = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return useMemo(() => filterOptions(s, country), [s, country]);
}

const codesFor = (s: Snapshot, country?: string | null) =>
  country ? s.codes.filter((c) => !s.countryByCode[c] || s.countryByCode[c] === country) : s.codes;
const pickerOptions = (s: Snapshot, country?: string | null) =>
  codesFor(s, country).map((value) => ({ value, label: s.labelByCode[value] }));
const filterOptions = (s: Snapshot, country?: string | null) => [
  { value: '', label: country ? `${country} Time Zones` : 'All Time Zones' },
  ...codesFor(s, country).map((value) => ({ value, label: value === 'IND' ? 'India' : value })),
];

/** The country a zone belongs to, or null when it isn't tied to one. */
export const countryOfZone = (code?: string | null): string | null =>
  (code && snapshot.countryByCode[code]) || null;

/** Mirrors the API rule: only a zone owned by a DIFFERENT country mismatches. */
export function zoneMatchesCountry(zone?: string | null, country?: string | null): boolean {
  if (!zone || !country) return true;
  const owner = countryOfZone(zone);
  return !owner || owner === country;
}

/** A lead zone code. Data now, not a fixed set of literals. */
export type LeadTimezone = string;

/**
 * Every zone code the CRM currently supports, in admin-configured order.
 * Read this rather than caching your own copy — a zone added to the admin
 * list and then missing from a call site is exactly how six screens once
 * ended up hardcoding just the four US zones.
 */
export const timezoneCodes = (): string[] => snapshot.codes;

/**
 * The zones a rep can pick from: the scheduler's inline zone prompt, the lead
 * form, the import mapper and every zone filter all read this one list.
 */
export const leadTimezones = (country?: string | null): { value: string; label: string }[] => pickerOptions(snapshot, country);

/**
 * Options for a zone <select> that can also mean "don't filter", by CODE. The
 * empty value is the no-filter sentinel every list endpoint already treats as
 * absent.
 *
 * A native `<select>` takes its width from its widest option, so
 * `EST (Eastern Standard Time)` makes the zone filter roughly twice the width of
 * its neighbours — enough on its own to push the last filter in a bar onto a
 * second line, and enough to leave nothing beside it in the Call Panel's queue
 * column. The codes are the CRM's own vocabulary and are what those screens
 * showed before the zone list grew, so nothing is lost by using them where space
 * is shared; `UK` and `India` are named rather than coded because neither has a
 * code anyone would recognise.
 *
 * The full-label variant that used to sit here had one caller, the Call Panel,
 * which now shares its row with Contact Search and takes the codes too. Use
 * `leadTimezones()` where a zone is being CHOSEN rather than filtered on — the
 * lead form and the scheduler, which have the room and want the full names.
 */
export const timezoneFilterOptions = (): { value: string; label: string }[] => filterOptions(snapshot);

/**
 * How a lead with no zone set is named in filters and groupings. Must match the
 * API's `UNSET_TIMEZONE_LABEL` — the leads list sends this value straight back
 * as a filter, where it selects the rows with no zone.
 */
export const UNSET_TIMEZONE_LABEL = 'Unassigned';

/** Human name for a zone, for dropdowns and reports. */
export const timezoneLabel = (code?: string | null): string =>
  code ? (snapshot.labelByCode[code] ?? code) : UNSET_TIMEZONE_LABEL;

/** Is this lead's zone actually configured? Nothing may be scheduled until it is. */
export const hasLeadZone = (tz?: string | null): tz is LeadTimezone =>
  !!tz && tz in snapshot.ianaByCode;

const DEFAULT_TZ = 'EST';

const zoneOf = (tz?: string | null): string =>
  snapshot.ianaByCode[tz ?? DEFAULT_TZ] ?? snapshot.ianaByCode[DEFAULT_TZ] ?? FALLBACK[2].ianaZone;

// ── A lead's own timestamps, on the lead's own clock ──
//
// Everything a lead owns — when it was created, the day it is queued for, when
// it changed hands, when it was called — is stated in the lead's time zone, not
// the reader's. A lead created at 6pm Eastern is an 18:00 record on the 14th to
// everyone who touches it, including a manager in Chennai for whom that instant
// is 03:30 on the 15th. Without this the same lead answered "when was this
// created" with two different DATES depending on who was looking, and the
// next-day sweep — which has always worked on the lead's calendar — looked like
// it was moving leads a day early.
//
// The FORMATS are imported rather than restated. These render exactly what the
// reader's-clock formatters render; the time zone is the only difference, which
// is the entire intent.

/**
 * The clock a lead's timestamps are read on.
 *
 * A lead with no zone falls back to Eastern, NOT to the reader's clock, and that
 * is the deliberate part. The API decides a zone-less lead's calendar day in
 * Eastern too — `ianaFor` defaults there, which is what the next-day sweep uses
 * to work out whether that lead's day has turned. Rendering the same lead on the
 * reader's clock would put the screen back in disagreement with the queue for
 * exactly the leads whose zone nobody has set, which is the failure this whole
 * change exists to remove. Display mirrors the computation.
 *
 * The fallback is a rendering default and nothing more. Scheduling refuses
 * outright on a lead with no zone rather than guessing one — a guessed zone is a
 * call placed at the wrong hour — and `zoneNote` says plainly when a displayed
 * time is resting on the default.
 */
const leadZone = (tz?: string | null): string => (hasLeadZone(tz) ? zoneOf(tz) : zoneOf(DEFAULT_TZ));

/** `Aug 5, 2026` on the lead's clock. Same format as `formatDate`. */
export const leadDate = (v: string | number | Date | null | undefined, tz?: string | null, fallback?: string) =>
  formatInZone(leadZone(tz), v, DATE_FORMAT, fallback);

/** `Aug 5, 2026, 10:00 AM` on the lead's clock. Same format as `formatDateTime`. */
export const leadDateTime = (v: string | number | Date | null | undefined, tz?: string | null, fallback?: string) =>
  formatInZone(leadZone(tz), v, DATE_TIME_FORMAT, fallback);

/** `10:00 AM` on the lead's clock. Same format as `formatTime`. */
export const leadTime = (v: string | number | Date | null | undefined, tz?: string | null, fallback?: string) =>
  formatInZone(leadZone(tz), v, TIME_FORMAT, fallback);

/** `Aug 5` on the lead's clock. Same format as `formatDateShort`. */
export const leadDateShort = (v: string | number | Date | null | undefined, tz?: string | null, fallback?: string) =>
  formatInZone(leadZone(tz), v, { month: 'short', day: 'numeric' }, fallback);

type Stamp = string | number | Date | null | undefined;

/**
 * A row's time on its LEAD's clock when it has a lead, otherwise the viewer's.
 *
 * For feeds that mix lead rows with rows that have none (a call or text from
 * an unknown number). A lead row goes through the lead formatters, including
 * their Eastern default for a lead with no zone. A row with no lead has no
 * customer clock to use, so the viewer's own clock is the honest answer.
 */
export function leadOrViewer(v: Stamp, lead: { timezone?: string | null } | null | undefined, kind: 'date' | 'datetime' | 'time' = 'datetime', fallback?: string): string {
  if (lead) {
    if (kind === 'date') return leadDate(v, lead.timezone, fallback);
    if (kind === 'time') return leadTime(v, lead.timezone, fallback);
    return leadDateTime(v, lead.timezone, fallback);
  }
  if (kind === 'date') return formatDate(v, fallback);
  if (kind === 'time') return formatTime(v, fallback);
  return formatDateTime(v, fallback);
}

/**
 * Which clock the value beside it is on, in words — for a `title` tooltip.
 *
 * The displayed FORMAT deliberately carries no zone suffix: these columns are
 * meant to read exactly as they always have. That leaves a real question
 * unanswered on screen — two leads in different zones show times on two
 * different clocks in the same column — so the answer hangs off the cell, where
 * it costs no space. The grid and the export also carry a Time Zone column, so
 * the row itself says which clock it is on.
 *
 * A lead with no zone is called out rather than passed off as Eastern. Somebody
 * reading a date that rests on a default needs to know it does, because the fix
 * is to set the lead's zone.
 */
export function zoneNote(tz?: string | null): string {
  if (!hasLeadZone(tz)) {
    return `This lead has no time zone set — shown in ${timezoneLabel(DEFAULT_TZ)}, the default. Set the lead's time zone to date it correctly.`;
  }
  return `Shown in the lead's time zone: ${timezoneLabel(tz)} (${zoneLabel(tz)}).`;
}

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
  return `${text} ${tz ?? DEFAULT_TZ}`;
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
  const zone = zoneOf(tz);
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
  return wallClockInLeadZone(new Date(), tz);
}

/** An instant as the lead's wall clock, `YYYY-MM-DDTHH:mm` — for pre-filling a
 *  field the API will read back in that same zone. */
export function wallClockInLeadZone(at: string | Date, tz?: string | null): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zoneOf(tz),
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(typeof at === 'string' ? new Date(at) : at);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '00';
  const hour = String(Number(get('hour')) % 24).padStart(2, '0');
  return `${get('year')}-${get('month')}-${get('day')}T${hour}:${get('minute')}`;
}
