/**
 * Date maths for the Calendar: which days a view covers, how the arrows step,
 * where an event sits in the hour grid, and whether it's overdue.
 *
 * Days are `yyyy-mm-dd` strings, worked with UTC date arithmetic so no clock or
 * zone can shift them. Placement on the grid uses ONE clock for every event —
 * the CRM's display clock (Settings → Display) — so a 10:00 Eastern call and a
 * 10:00 Pacific one sit three hours apart, as they really are. Each event still
 * shows the customer's own time on it.
 */

/** `team` is a manager's week: one row per rep instead of an hour grid. */
export type CalView = 'month' | 'week' | 'day' | 'agenda' | 'team';

/** Days the agenda lists from the day it starts on. */
export const AGENDA_DAYS = 14;
/** Past this long after its time, a scheduled call or meeting counts as overdue — the callbacks' own window. */
export const OVERDUE_AFTER_MS = 60 * 60 * 1000;

const DAY = 86_400_000;
const toUtc = (ymd: string) => {
  const [y, m, d] = ymd.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
};
const fromUtc = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export const addDays = (ymd: string, n: number) => fromUtc(toUtc(ymd) + n * DAY);
/** 0 = Sunday … 6 = Saturday. */
export const weekday = (ymd: string) => new Date(toUtc(ymd)).getUTCDay();

function addMonths(ymd: string, n: number): string {
  const [y, m] = ymd.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1 + n, 1));
  return first.toISOString().slice(0, 10);
}

/** Every day from `from` to `to`, inclusive. */
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = toUtc(from); t <= toUtc(to); t += DAY) out.push(fromUtc(t));
  return out;
}

/**
 * The days a view shows around `cursor`. A month is whole weeks, Sunday to
 * Saturday, so the grid shows (and fetches) the neighbouring months' days at
 * its edges instead of blank cells.
 */
export function windowFor(view: CalView, cursor: string): { from: string; to: string; days: string[] } {
  let from: string;
  let to: string;
  if (view === 'month') {
    const first = `${cursor.slice(0, 7)}-01`;
    const last = addDays(addMonths(first, 1), -1);
    from = addDays(first, -weekday(first));
    to = addDays(last, 6 - weekday(last));
  } else if (view === 'week' || view === 'team') {
    from = addDays(cursor, -weekday(cursor));
    to = addDays(from, 6);
  } else if (view === 'day') {
    from = to = cursor;
  } else {
    from = cursor;
    to = addDays(cursor, AGENDA_DAYS - 1);
  }
  return { from, to, days: daysBetween(from, to) };
}

/** Where the arrows go: a month, a week, a day, or the agenda's length. */
export function step(view: CalView, cursor: string, dir: 1 | -1): string {
  if (view === 'month') return addMonths(cursor, dir);
  if (view === 'week' || view === 'team') return addDays(cursor, 7 * dir);
  if (view === 'day') return addDays(cursor, dir);
  return addDays(cursor, AGENDA_DAYS * dir);
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const SHORT = MONTHS.map((m) => m.slice(0, 3));
const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const parts = (ymd: string) => ymd.split('-').map(Number) as [number, number, number];

/** "November 2026" · "Nov 15 – 21, 2026" · "Saturday, Nov 21, 2026" · "Nov 21 – Dec 4, 2026". */
export function titleFor(view: CalView, cursor: string): string {
  const [y, m, d] = parts(cursor);
  if (view === 'month') return `${MONTHS[m - 1]} ${y}`;
  if (view === 'day') return `${DOW[weekday(cursor)]}, ${SHORT[m - 1]} ${d}, ${y}`;
  const { from, to } = windowFor(view, cursor);
  const [fy, fm, fd] = parts(from);
  const [ty, tm, td] = parts(to);
  if (fy !== ty) return `${SHORT[fm - 1]} ${fd}, ${fy} – ${SHORT[tm - 1]} ${td}, ${ty}`;
  if (fm !== tm) return `${SHORT[fm - 1]} ${fd} – ${SHORT[tm - 1]} ${td}, ${ty}`;
  return `${SHORT[fm - 1]} ${fd} – ${td}, ${ty}`;
}

/** "Today", "Tomorrow", "Yesterday", or "Mon, Nov 24" — the agenda's day headings. */
export function dayHeading(ymd: string, today: string): string {
  if (ymd === today) return 'Today';
  if (ymd === addDays(today, 1)) return 'Tomorrow';
  if (ymd === addDays(today, -1)) return 'Yesterday';
  const [, m, d] = parts(ymd);
  return `${DOW[weekday(ymd)].slice(0, 3)}, ${SHORT[m - 1]} ${d}`;
}

/** The day, hour and minute an instant falls on in a zone. */
export function zoneParts(iso: string, tz: string): { ymd: string; hour: number; minute: number } {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(iso));
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? '00';
  return { ymd: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) % 24, minute: Number(get('minute')) };
}

/** "10:30 AM" for an instant in a zone. */
export function timeIn(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
}

/** The hours the time grid draws: 8 AM to 7 PM, widened to take in anything earlier or later. */
export function hourRange(hours: number[]): [number, number] {
  let lo = 8;
  let hi = 19;
  for (const h of hours) {
    lo = Math.min(lo, h);
    hi = Math.max(hi, h + 1);
  }
  return [lo, Math.min(hi, 24)];
}

export interface Placed<T> {
  item: T;
  /** Minutes from the top of the grid. */
  top: number;
  /** Length in minutes. */
  length: number;
  lane: number;
  lanes: number;
}

/**
 * Side-by-side lanes for one day's events, so two at the same time don't sit on
 * top of each other. Greedy: each event takes the first lane free at its start,
 * and a cluster of overlapping events shares out the column's width.
 */
export function layoutDay<T>(items: { item: T; start: number; length: number }[]): Placed<T>[] {
  const sorted = [...items].sort((a, b) => a.start - b.start || b.length - a.length);
  const placed: Placed<T>[] = [];
  let cluster: Placed<T>[] = [];
  let clusterEnd = -Infinity;
  const laneEnds: number[] = [];
  const close = () => {
    const lanes = Math.max(1, ...cluster.map((p) => p.lane + 1));
    for (const p of cluster) p.lanes = lanes;
    cluster = [];
    laneEnds.length = 0;
  };
  for (const it of sorted) {
    if (it.start >= clusterEnd) close();
    let lane = laneEnds.findIndex((end) => end <= it.start);
    if (lane < 0) lane = laneEnds.length;
    laneEnds[lane] = it.start + it.length;
    const p: Placed<T> = { item: it.item, top: it.start, length: it.length, lane, lanes: 1 };
    placed.push(p);
    cluster.push(p);
    clusterEnd = Math.max(clusterEnd, it.start + it.length);
  }
  close();
  return placed;
}

/** What an event needs for the overdue rule. */
export interface DueInfo {
  type: 'call' | 'callback' | 'zoom' | 'task';
  date: string;
  status: string;
  callbackStatus: string | null;
}

/**
 * Overdue for every kind of event, not just callbacks: a callback by its own
 * status; a scheduled call more than an hour past its time (it's still booked,
 * so nobody has done it); a meeting still scheduled more than an hour after it
 * should have started. A completed or cancelled meeting is never overdue. A
 * task is a deadline, so it's overdue the moment it's due (the calendar only
 * lists open ones).
 */
export function isOverdue(e: DueInfo, now: number): boolean {
  if (e.type === 'callback') return e.callbackStatus === 'overdue';
  if (e.type === 'task') return now > new Date(e.date).getTime();
  const late = now - new Date(e.date).getTime() > OVERDUE_AFTER_MS;
  if (e.type === 'call') return late;
  return late && (e.status === 'scheduled' || e.status === 'rescheduled');
}

// ── Moving and booking ──
//
// The grid is drawn on the display clock, so a drop or a click lands on a day
// and a minute on THAT clock. These turn it back into an instant — the one
// thing every save needs — and read it on the customer's clock for the warning.

const pad2 = (n: number) => String(n).padStart(2, '0');

/** A zone's UTC offset in ms at an instant, read off Intl rather than tabulated. */
function offsetMs(at: number, tz: string): number {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(at));
  const get = (t: string) => Number(p.find((x) => x.type === t)?.value ?? 0);
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second')) - Math.floor(at / 1000) * 1000;
}

/**
 * The instant at `minutes` past midnight of `ymd` on a zone's clock. Minutes
 * past 24 h roll into the next day. Two passes, so a time near a DST change
 * isn't an hour out (the offset is sampled at the answer, not the guess).
 */
export function zonedInstant(ymd: string, minutes: number, tz: string): Date {
  const asIfUtc = toUtc(ymd) + minutes * 60_000;
  const first = asIfUtc - offsetMs(asIfUtc, tz);
  return new Date(asIfUtc - offsetMs(first, tz));
}

/** An instant as `YYYY-MM-DDTHH:mm` on a zone's clock — for a datetime-local box. */
export function wallClockIn(at: Date | string, tz: string): string {
  const p = zoneParts(typeof at === 'string' ? at : at.toISOString(), tz);
  return `${p.ymd}T${pad2(p.hour)}:${pad2(p.minute)}`;
}

/** The reverse: a datetime-local value on a zone's clock, or null if it isn't one. */
export function fromWallClock(wall: string, tz: string): Date | null {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(wall ?? '');
  return m ? zonedInstant(m[1], Number(m[2]) * 60 + Number(m[3]), tz) : null;
}

/** "Nov 24, 3:00 PM EST" — an instant on a zone's clock, zone named. */
export function atOnClock(at: Date | string, tz: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })
    .format(typeof at === 'string' ? new Date(at) : at);
}

/** Rounds to the nearest `stepMins`. */
export const snap = (minutes: number, stepMins: number) => Math.round(minutes / stepMins) * stepMins;

/** "2:30 PM" for minutes past midnight. */
export function clockLabel(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${h % 12 || 12}:${pad2(m)} ${h < 12 ? 'AM' : 'PM'}`;
}

/** The next half hour after `now` on a zone's clock — where a new booking starts. */
export function nextHalfHour(now: number, tz: string): Date {
  const p = zoneParts(new Date(now).toISOString(), tz);
  return zonedInstant(p.ymd, Math.floor((p.hour * 60 + p.minute) / 30) * 30 + 30, tz);
}

/** The customer's working day, on their own clock: 9 AM to 6 PM, Monday to Friday. */
export const CUSTOMER_HOURS = { start: 9, end: 18 } as const;

/**
 * Whether a time on the CUSTOMER's clock (`YYYY-MM-DDTHH:mm`) is outside their
 * working day, said plainly — or null when it's inside. It warns, never blocks:
 * some customers do ask for a Saturday or an early call.
 */
export function outsideCustomerHours(wall: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(wall ?? '');
  if (!m) return null;
  const day = weekday(m[1]);
  const mins = Number(m[2]) * 60 + Number(m[3]);
  const time = clockLabel(mins);
  if (day === 0 || day === 6) return `That’s ${time} on a ${DOW[day]} for the customer — outside their working week.`;
  if (mins < CUSTOMER_HOURS.start * 60) return `That’s ${time} for the customer — before their 9 AM start.`;
  if (mins >= CUSTOMER_HOURS.end * 60) return `That’s ${time} for the customer — after their 6 PM finish.`;
  return null;
}

// ── How busy, and who ──

/**
 * How busy a day is, as a step on one fixed scale: 0 nothing, 1 one or two,
 * 2 three to five, 3 six to nine, 4 ten or more. Fixed rather than relative to
 * the busiest day on screen, so the same shade means the same load in any month.
 */
export function loadLevel(count: number): 0 | 1 | 2 | 3 | 4 {
  if (count <= 0) return 0;
  if (count < 3) return 1;
  if (count < 6) return 2;
  if (count < 10) return 3;
  return 4;
}
/** The shade for each level: one hue (the brand's), light to dark. */
export const LOAD_ALPHA = [0, 0.07, 0.14, 0.22, 0.32] as const;
/** This many items starting in the same hour is more than one person can keep. */
export const HOUR_LIMIT = 3;

export interface DayLoad {
  total: number;
  call: number;
  callback: number;
  zoom: number;
  overdue: number;
  /** The hour with the most items starting in it, on the display clock. */
  busiest: { hour: number; count: number } | null;
}

/**
 * Each person's load, day by day: the team view's table. Keyed by owner id
 * (`''` for nobody), then by day. Tasks are personal and aren't counted.
 */
export function teamLoad(
  items: { ownerId: string | null; ymd: string; hour: number; type: DueInfo['type']; overdue: boolean }[],
): Map<string, Map<string, DayLoad>> {
  const out = new Map<string, Map<string, DayLoad>>();
  const perHour = new Map<string, number>();
  for (const it of items) {
    if (it.type === 'task') continue;
    const owner = it.ownerId ?? '';
    const days = out.get(owner) ?? new Map<string, DayLoad>();
    out.set(owner, days);
    const day = days.get(it.ymd) ?? { total: 0, call: 0, callback: 0, zoom: 0, overdue: 0, busiest: null };
    days.set(it.ymd, day);
    day.total += 1;
    day[it.type] += 1;
    if (it.overdue) day.overdue += 1;
    const key = `${owner}|${it.ymd}|${it.hour}`;
    const n = (perHour.get(key) ?? 0) + 1;
    perHour.set(key, n);
    if (!day.busiest || n > day.busiest.count || (n === day.busiest.count && it.hour < day.busiest.hour)) day.busiest = { hour: it.hour, count: n };
  }
  return out;
}

/** "now", "in 25 min", "in 2 h", "in 1 h 5 min" — how long until an item. */
export function untilLabel(at: number, now: number): string {
  const mins = Math.round((at - now) / 60_000);
  if (mins <= 0) return 'now';
  if (mins < 60) return `in ${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `in ${h} h ${m} min` : `in ${h} h`;
}

/** Started this long ago and still "now" rather than gone. */
export const NOW_GRACE_MS = 10 * 60_000;

/**
 * The next few things on today's schedule: from a few minutes ago (one just
 * started is still "now") to the end of the day, finished or cancelled
 * meetings left out.
 */
export function nextUp<T extends DueInfo>(events: T[], now: number, endOfDay: number, take = 3): T[] {
  return events
    .filter((e) => {
      const t = new Date(e.date).getTime();
      if (t < now - NOW_GRACE_MS || t >= endOfDay) return false;
      return !(e.type === 'zoom' && (e.status === 'completed' || e.status === 'cancelled'));
    })
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, take);
}

/** How many rep colours there are (`--rep-1` …); everyone after shares "other". */
export const REP_COLOURS = 4;

/**
 * A colour per person, by a fixed order — the team list sorted by name — so a
 * filter never repaints anyone. Past the fourth, people share a neutral grey
 * rather than a fifth hue that would be too close to one of the four.
 */
export function repColours(people: { id: string; name: string }[]): Map<string, string> {
  const sorted = [...people].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return new Map(sorted.map((p, i) => [p.id, i < REP_COLOURS ? `var(--rep-${i + 1})` : 'var(--viz-working)']));
}
