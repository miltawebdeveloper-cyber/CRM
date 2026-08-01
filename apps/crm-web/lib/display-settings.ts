/**
 * The signed-in user's own display preferences: which clock they read times on,
 * and which language the interface speaks.
 *
 * ── This is NOT the lead time zone ──
 *
 * `lib/timezone.ts` handles a different question and the two must never be
 * confused. A callback agreed with a customer is stated on the CUSTOMER's clock,
 * because that is the hour the customer expects the phone to ring — that stays
 * true no matter where the rep sits, and a user preference must never override
 * it. What this module governs is everything else: when a call was logged, when
 * a lead was created, when someone last signed in, and the "your local time"
 * line shown beside a customer's time so the rep can see both.
 *
 * The rule, applied throughout:
 *   an appointment WITH someone  → their zone   (lib/timezone.ts)
 *   a record OF something        → the reader's zone (here)
 *
 * Preferences are stored per user via `/me/preferences`, so they follow the
 * person across devices and survive logout — the browser's own zone is only
 * ever a first guess for someone who has not chosen yet.
 */

/**
 * Zones offered in Settings.
 *
 * Labelled EST/CST/MST/PST because that is the vocabulary this business already
 * uses — the same four codes every lead carries — so one word means one thing
 * whether it is describing a customer or the person reading the screen.
 *
 * The VALUE behind each label is a region id, not the fixed offset the code
 * literally names: `America/New_York`, not `EST` (which is UTC-5 all year). The
 * US is on daylight time for about two thirds of the year, so a literal EST
 * would show every summer timestamp an hour early. Same decision, for the same
 * reason, as the lead zones in `lib/timezone.ts`.
 */
export const DISPLAY_TIMEZONES = [
  { value: 'America/New_York', label: 'EST — Eastern', flag: '🇺🇸', hint: 'New York, Miami' },
  { value: 'America/Chicago', label: 'CST — Central', flag: '🇺🇸', hint: 'Chicago, Dallas' },
  { value: 'America/Denver', label: 'MST — Mountain', flag: '🇺🇸', hint: 'Denver, Phoenix' },
  { value: 'America/Los_Angeles', label: 'PST — Pacific', flag: '🇺🇸', hint: 'Los Angeles, Seattle' },
  { value: 'America/Anchorage', label: 'AKST — Alaska', flag: '🇺🇸', hint: 'Anchorage, Fairbanks' },
  { value: 'Pacific/Honolulu', label: 'HST — Hawaii', flag: '🇺🇸', hint: 'Honolulu, Hilo' },
  { value: 'Europe/London', label: 'UK — GMT/BST', flag: '🇬🇧', hint: 'London' },
  { value: 'Asia/Kolkata', label: 'IST — India', flag: '🇮🇳', hint: 'Chennai, Bengaluru' },
] as const;

export type DisplayTimezone = (typeof DISPLAY_TIMEZONES)[number]['value'];

/**
 * Languages the interface offers.
 *
 * `ready` marks a locale with a complete set of translations. The others are
 * declared so the plumbing and the selector can be finished and reviewed now,
 * and are deliberately NOT selectable until their strings exist — a dropdown
 * that switches to a half-translated language looks broken in a way that is
 * worse than not offering it at all.
 */
export const LANGUAGES = [
  { value: 'en', label: 'English', native: 'English', ready: true },
  { value: 'ta', label: 'Tamil', native: 'தமிழ்', ready: false },
  { value: 'hi', label: 'Hindi', native: 'हिन्दी', ready: false },
  { value: 'es', label: 'Spanish', native: 'Español', ready: false },
] as const;

export type Language = (typeof LANGUAGES)[number]['value'];

/** Preference keys under `/me/preferences`. Namespaced to leave room for more. */
export const TIMEZONE_KEY = 'display:timezone';
export const LANGUAGE_KEY = 'display:language';

export const DEFAULT_LANGUAGE: Language = 'en';

const isKnownZone = (v: unknown): v is DisplayTimezone =>
  typeof v === 'string' && DISPLAY_TIMEZONES.some((z) => z.value === v);

export const isKnownLanguage = (v: unknown): v is Language =>
  typeof v === 'string' && LANGUAGES.some((l) => l.value === v);

/**
 * The zone to use for someone who has never chosen one.
 *
 * Their browser's zone if we support it, otherwise Eastern. Guessing from the
 * browser is right for a first visit and wrong to keep doing afterwards, which
 * is why an explicit choice always wins — a rep travelling, or on a laptop with
 * the wrong clock, should not have every timestamp in the CRM move with it.
 */
export function guessTimezone(): DisplayTimezone {
  try {
    const browser = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (isKnownZone(browser)) return browser;
    // Map the nearby zones a browser commonly reports onto the ones we offer,
    // so an Indian or British user is not silently handed Eastern.
    if (browser?.startsWith('Asia/Calcutta') || browser === 'Asia/Kolkata') return 'Asia/Kolkata';
    if (browser?.startsWith('Europe/')) return 'Europe/London';
  } catch {
    /* Intl unavailable — fall through to the default */
  }
  return 'America/New_York';
}

// ── Current values ──
//
// Held at module scope, not only in React state, so a plain function can format
// a date without being a hook. Formatting happens in table cells, column
// definitions, export builders and toast strings — much of which is not a
// component — and threading a hook through all of it would mean rewriting far
// more than the formatting. The provider keeps these in step and re-renders the
// tree when either changes.

let currentZone: DisplayTimezone = 'America/New_York';
let currentLanguage: Language = DEFAULT_LANGUAGE;

export const getUserTimezone = (): DisplayTimezone => currentZone;
export const getUserLanguage = (): Language => currentLanguage;

/** Set by the provider only. Returns whether the value actually changed. */
export function setUserTimezone(tz: unknown): boolean {
  const next = isKnownZone(tz) ? tz : guessTimezone();
  if (next === currentZone) return false;
  currentZone = next;
  return true;
}

export function setUserLanguage(lang: unknown): boolean {
  const next = isKnownLanguage(lang) ? lang : DEFAULT_LANGUAGE;
  if (next === currentLanguage) return false;
  currentLanguage = next;
  return true;
}

/** The label shown in Settings, e.g. `US — Eastern`. */
export const timezoneLabel = (tz: string = currentZone): string =>
  DISPLAY_TIMEZONES.find((z) => z.value === tz)?.label ?? tz;

/** Short zone abbreviation for the current date, e.g. `EDT`, `GMT`, `IST`. */
export function userZoneAbbrev(tz: string = currentZone): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(new Date());
    return parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
  } catch {
    return '';
  }
}

// ── Formatters ──
//
// Every timestamp the CRM shows should go through one of these. They replaced
// bare `toLocaleDateString()` / `toLocaleTimeString()` calls, which render in
// whatever zone the BROWSER happens to be in — so the same call appeared at
// different times to a manager in Chennai and a rep in Texas, with nothing on
// screen to say which clock either was reading.

const toDate = (v: string | number | Date | null | undefined): Date | null => {
  if (v === null || v === undefined || v === '') return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

const fmt = (v: string | number | Date | null | undefined, opts: Intl.DateTimeFormatOptions, fallback = '—') => {
  const d = toDate(v);
  if (!d) return fallback;
  try {
    return new Intl.DateTimeFormat(currentLanguage === 'en' ? 'en-US' : currentLanguage, {
      timeZone: currentZone,
      ...opts,
    }).format(d);
  } catch {
    return d.toISOString().slice(0, 16).replace('T', ' ');
  }
};

/** `Aug 5, 2026` */
export const formatDate = (v: string | number | Date | null | undefined, fallback?: string) =>
  fmt(v, { year: 'numeric', month: 'short', day: 'numeric' }, fallback);

/** `10:00 AM` */
export const formatTime = (v: string | number | Date | null | undefined, fallback?: string) =>
  fmt(v, { hour: '2-digit', minute: '2-digit' }, fallback);

/** `Aug 5, 2026, 10:00 AM` */
export const formatDateTime = (v: string | number | Date | null | undefined, fallback?: string) =>
  fmt(v, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }, fallback);

/** `Aug 5, 10:00 AM EDT` — for anywhere the zone itself is worth stating. */
export const formatDateTimeWithZone = (v: string | number | Date | null | undefined, fallback?: string) =>
  fmt(v, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }, fallback);

/** `Wed, 5 Aug` — compact, for chart axes and dense tables. */
export const formatDayShort = (v: string | number | Date | null | undefined, fallback?: string) =>
  fmt(v, { weekday: 'short', month: 'short', day: 'numeric' }, fallback);

/** `Aug 5` — no year, for dense lists where the year is obvious from context. */
export const formatDateShort = (v: string | number | Date | null | undefined, fallback?: string) =>
  fmt(v, { month: 'short', day: 'numeric' }, fallback);

/** `Wednesday, July 30` — for page headings that name today. */
export const formatDateLong = (v: string | number | Date | null | undefined, fallback?: string) =>
  fmt(v, { weekday: 'long', month: 'long', day: 'numeric' }, fallback);

/** `2026-08-05` in the USER's zone — for grouping rows by day. */
export function dayKey(v: string | number | Date | null | undefined): string {
  const d = toDate(v);
  if (!d) return '';
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: currentZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

/** Is this instant today, on the user's calendar? */
export const isToday = (v: string | number | Date | null | undefined): boolean => {
  const k = dayKey(v);
  return !!k && k === dayKey(new Date());
};
