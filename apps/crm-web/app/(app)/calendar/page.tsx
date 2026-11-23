'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ChevronLeft, ChevronRight, ListTodo, Phone, PhoneCall, Plus, User as UserIcon, Video } from 'lucide-react';
import { calendarApi, assignmentsApi, type CalendarEvent, type ActivityType } from '@/lib/crm';
import { api } from '@/lib/api';
import { PageHead } from '@/components/page-head';
import { Segmented } from '@/components/segmented';
import { KpiCard, KpiGrid } from '@/components/dashboard/kpi-card';
import { FilterSelect } from '@/components/filter-controls';
import { CalendarEventPanel } from '@/components/calendar-event-panel';
import { CalendarNewPanel } from '@/components/calendar-new-panel';
import { CalendarMoveDialog } from '@/components/calendar-move-dialog';
import { CalendarNextUp } from '@/components/calendar-next-up';
import { CalendarTeamGrid, LoadLegend } from '@/components/calendar-team-grid';
import { getUserTimezone, userZoneAbbrev } from '@/lib/display-settings';
import { usePersistedState } from '@/lib/use-persisted-state';
import { useMediaQuery } from '@/lib/use-media-query';
import { moveBlocker } from '@/lib/calendar-actions';
import {
  addDays, clockLabel, dayHeading, hourRange, isOverdue, layoutDay, nextHalfHour, repColours, snap, step, timeIn, titleFor, weekday, windowFor, zonedInstant, zoneParts,
  type CalView,
} from '@/lib/calendar-grid';
import { itemCount, loadShade, look, OVERDUE_CHIP, placeEvent, TYPE_META, type Look, type Placed } from '@/lib/calendar-look';

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const VIEWS = [
  { label: 'Month', value: 'month' as CalView },
  { label: 'Week', value: 'week' as CalView },
  { label: 'Day', value: 'day' as CalView },
  { label: 'Agenda', value: 'agenda' as CalView },
];
const TEAM_VIEW = { label: 'Team', value: 'team' as CalView };
type ColourBy = 'type' | 'rep';
const COLOUR_BY = [
  { label: 'Type', value: 'type' as ColourBy },
  { label: 'Rep', value: 'rep' as ColourBy },
];

/** A drag waiting for its confirm. */
type Moving = { event: Placed; at: Date };

const HOUR_PX = 56;
/** Width of the hour labels down the left of the time grid. */
const LABEL_W = 56;
/** A drag moves in quarter hours; a click books on the half hour. */
const DRAG_STEP = 15;
const SLOT_STEP = 30;

/**
 * Calendar — every scheduled call, callback, Zoom meeting and task of your
 * own, as a month, a week or a day on an hour grid, or an agenda.
 *
 * What changed, and why:
 *  • Week and Day were cut-outs of the month grid: no hours, the arrows moved by
 *    month, and a week that crossed into the next month showed blank days. They
 *    are now real views with their own navigation and a "now" line.
 *  • A callback showed twice (also as a "Scheduled Call", since booking one
 *    writes the same time into Next Follow-up); the API now lists it once.
 *  • Nothing could be clicked. Every event now opens a panel with the lead and
 *    what can be done: open it to call, join or finish a meeting, reschedule.
 *  • Only callbacks could be overdue; a missed follow-up or meeting now shows too.
 *  • Phones open on the agenda — a month of seven columns doesn't fit one.
 *  • In Week and Day, drag an item to move it (confirmed, with the customer's
 *    time and a warning outside their 9–6 working day), and click a free time
 *    to book a callback, a meeting or a task there. "New" does the same from
 *    any view, and from the keyboard.
 *  • Tasks with a due date show too — your own only, as the task board is personal.
 *  • "Next up" at the top: the next three things today, with a countdown.
 *  • Month days are shaded by how busy they are; every day heading has its count.
 *  • Managers get a Team view — a row per rep across the week, who's overloaded
 *    and who's free, warning where too many start in one hour — and can colour
 *    the whole team's calendar by rep instead of by type.
 *
 * Everything is placed on the CRM's display clock (Settings → Display), so a
 * 10:00 Eastern and a 10:00 Pacific call sit three hours apart, as they really
 * are; each event shows the customer's own time as well. The API still scopes
 * by role: an employee only ever sees their own schedule.
 */
export default function CalendarPage() {
  const tz = getUserTimezone();
  const phone = useMediaQuery('(max-width: 639px)', false);
  const [chosenView, setChosenView] = usePersistedState<CalView | null>('calendar:view', null);
  const [colourBy, setColourBy] = usePersistedState<ColourBy>('calendar:colour', 'type');
  const [now, setNow] = useState(() => Date.now());
  const today = zoneParts(new Date(now).toISOString(), tz).ymd;
  const [cursor, setCursor] = useState(today);
  const [userId, setUserId] = useState('');
  const [hidden, setHidden] = useState<ActivityType[]>([]);
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [selected, setSelected] = useState<CalendarEvent | null>(null);
  const [booking, setBooking] = useState<Date | null>(null);
  const [moving, setMoving] = useState<Moving | null>(null);

  // The "now" line and the overdue colouring move with the clock.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const { data: me } = useQuery({ queryKey: ['me'], queryFn: async () => (await api.get('/auth/me')).data, retry: false });
  const isManager = me?.role === 'admin' || me?.role === 'team_leader';
  // The team view is a manager's; anyone else who had it saved sees the week.
  const view: CalView = chosenView === 'team' && !isManager ? 'week' : chosenView ?? (phone ? 'agenda' : 'month');
  const { data: summary } = useQuery({ queryKey: ['assignments-summary'], queryFn: assignmentsApi.summary, enabled: !!isManager });
  const userOpts = useMemo(
    () => [{ label: 'All Employees', value: '' }, ...(summary?.callers ?? []).map((c) => ({ label: c.name, value: c.id }))],
    [summary],
  );
  // Tasks are personal: they're on the calendar (and can be added) only while it shows your own schedule.
  const ownSchedule = !userId || userId === me?.id;
  // One colour per person, by the team list's fixed order — the same in every view and period.
  const people = useMemo(() => (summary?.callers ?? []).map((c) => ({ id: c.id, name: c.name })), [summary]);
  const colours = useMemo(() => repColours(people), [people]);
  const byRep = isManager && !userId && colourBy === 'rep';
  const paint = (e: Placed): Look => look(e, now, byRep ? colours.get(e.ownerId ?? '') ?? 'var(--viz-working)' : undefined);

  const win = windowFor(view, cursor);
  const { data, isLoading } = useQuery({
    queryKey: ['calendar', win.from, win.to, userId],
    queryFn: () => calendarApi.events({ from: win.from, to: win.to, userId: userId || undefined }),
  });

  const all = useMemo<Placed[]>(() => (data?.events ?? []).map((e) => placeEvent(e, tz)), [data, tz]);

  // "Next up" reads today whatever period the grid shows (often the same request, from cache).
  const { data: todayData } = useQuery({
    queryKey: ['calendar', today, today, userId],
    queryFn: () => calendarApi.events({ from: today, to: today, userId: userId || undefined }),
  });
  const todayEvents = useMemo(() => (todayData?.events ?? []).map((e) => placeEvent(e, tz)), [todayData, tz]);
  const endOfToday = zonedInstant(today, 24 * 60, tz).getTime();
  const counts = {
    call: all.filter((e) => e.type === 'call').length,
    callback: all.filter((e) => e.type === 'callback').length,
    zoom: all.filter((e) => e.type === 'zoom').length,
    task: all.filter((e) => e.type === 'task').length,
    overdue: all.filter((e) => isOverdue(e, now)).length,
  };
  const visible = all.filter((e) => !hidden.includes(e.type) && (!overdueOnly || isOverdue(e, now)));
  const byDay = useMemo(() => {
    const m = new Map<string, Placed[]>();
    for (const e of visible) m.set(e.ymd2, [...(m.get(e.ymd2) ?? []), e]);
    return m;
  }, [visible]);

  const go = (dir: 1 | -1) => setCursor(step(view, cursor, dir));
  const openDay = (ymd: string) => {
    setChosenView('day');
    setCursor(ymd);
  };
  const toggleType = (t: ActivityType) => setHidden((h) => (h.includes(t) ? h.filter((x) => x !== t) : [...h, t]));
  // "New" starts on the next half hour — or, looking at a future day or week, at
  // 10 AM on that day (a week's Monday).
  const newBooking = () => {
    const day = view === 'day' ? cursor : view === 'week' || view === 'team' ? addDays(win.from, 1) : null;
    setBooking(day && day > today ? zonedInstant(day, 10 * 60, tz) : nextHalfHour(now, tz));
  };
  const types = (Object.keys(TYPE_META) as ActivityType[]).filter((t) => t !== 'task' || ownSchedule);
  const timeGrid = view === 'week' || view === 'day';
  const views = isManager ? [...VIEWS, TEAM_VIEW] : VIEWS;
  const stepName = view === 'agenda' ? 'two weeks' : view === 'team' ? 'week' : view;
  const openPerson = (personId: string, ymd: string) => {
    setUserId(personId);
    setChosenView('day');
    setCursor(ymd);
  };
  // The rep legend lists who's in this period, in colour order.
  const repCounts = new Map<string, number>();
  for (const e of all) if (e.type !== 'task') repCounts.set(e.ownerId ?? '', (repCounts.get(e.ownerId ?? '') ?? 0) + 1);
  const others = [...repCounts.entries()].filter(([id]) => !colours.has(id)).reduce((n, [, c]) => n + c, 0);

  return (
    <div className="space-y-4">
      {isManager && (
        <PageHead>
          <FilterSelect icon={UserIcon} value={userId} onChange={setUserId} options={userOpts} />
        </PageHead>
      )}

      {todayData && (
        <CalendarNextUp events={todayEvents} now={now} endOfDay={endOfToday} showOwner={isManager && !userId} paint={paint} onPick={setSelected} />
      )}

      <KpiGrid min={180} bottom={false}>
        <KpiCard icon={Phone} iconBg="var(--brand-surface)" iconColor="var(--brand-on-surface)" value={counts.call} label="Scheduled Calls" />
        <KpiCard icon={PhoneCall} iconBg="var(--tone-amber-bg)" iconColor="var(--tone-amber-fg)" value={counts.callback} label="Callbacks" />
        <KpiCard icon={Video} iconBg="var(--tone-blue-bg)" iconColor="var(--tone-blue-fg)" value={counts.zoom} label="Zoom Meetings" />
        {ownSchedule && <KpiCard icon={ListTodo} iconBg="var(--tone-teal-bg)" iconColor="var(--tone-teal-fg)" value={counts.task} label="Tasks Due" />}
        <KpiCard icon={AlertTriangle} iconBg="var(--tone-red-bg)" iconColor="var(--tone-red-fg-2)" value={counts.overdue} label="Overdue" />
      </KpiGrid>

      <section aria-label="Calendar" className="min-w-0 rounded-2xl border bg-card shadow-sm">
        {/* Navigation and views. */}
        <div className="flex flex-wrap items-center gap-2.5 border-b px-4 py-3 sm:px-5">
          <button type="button" onClick={() => setCursor(today)} className="rounded-md border bg-card px-3 py-1.5 text-[12px] font-semibold hover:bg-muted">Today</button>
          <div className="flex items-center rounded-md border bg-card">
            <button type="button" onClick={() => go(-1)} aria-label={`Previous ${stepName}`} className="grid h-8 w-8 place-items-center rounded-l-md text-muted-foreground hover:bg-muted">
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button type="button" onClick={() => go(1)} aria-label={`Next ${stepName}`} className="grid h-8 w-8 place-items-center rounded-r-md text-muted-foreground hover:bg-muted">
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
          <h3 className="min-w-0 font-display text-[15px] font-semibold" aria-live="polite">{titleFor(view, cursor)}</h3>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <button type="button" onClick={newBooking} className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[12px] font-semibold text-primary-foreground hover:opacity-90">
              <Plus className="h-3.5 w-3.5" aria-hidden /> New
            </button>
            <Segmented options={views} value={view} onChange={(v) => setChosenView(v)} />
          </div>
        </div>

        {/* Filters — the legend is the filter, each with its count in this period. */}
        <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5 sm:px-5" role="group" aria-label="Show">
          {types.map((t) => {
            const on = !hidden.includes(t);
            return (
              <button
                key={t}
                type="button"
                aria-pressed={on}
                onClick={() => toggleType(t)}
                className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11.5px] font-semibold transition-colors ${on ? 'bg-card' : 'bg-muted/50 text-muted-foreground line-through'}`}
              >
                {byRep ? (
                  // Coloured by rep, a type dot would be a colour that's on nothing; the icon says the type.
                  (() => { const Icon = TYPE_META[t].icon; return <Icon className="h-3.5 w-3.5" aria-hidden />; })()
                ) : (
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: TYPE_META[t].dot, opacity: on ? 1 : 0.4 }} aria-hidden />
                )}
                {TYPE_META[t].plural}
                <span className="tabular-nums text-muted-foreground">{counts[t]}</span>
              </button>
            );
          })}
          <button
            type="button"
            aria-pressed={overdueOnly}
            onClick={() => setOverdueOnly((v) => !v)}
            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11.5px] font-semibold transition-colors ${overdueOnly ? OVERDUE_CHIP : 'bg-card'}`}
          >
            <AlertTriangle className="h-3.5 w-3.5" aria-hidden /> Overdue only <span className="tabular-nums opacity-70">{counts.overdue}</span>
          </button>
          {isManager && !userId && view !== 'team' && (
            <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground">
              Colour by <Segmented options={COLOUR_BY} value={colourBy} onChange={setColourBy} />
            </span>
          )}
          <span className="ml-auto text-[11px] text-muted-foreground">
            Times in {userZoneAbbrev(tz)} · customer’s time on each item{timeGrid && !phone ? ' · drag to move, click a free time to book' : ''}
          </span>
        </div>

        {/* Who each colour is, when the team's calendar is coloured by rep. */}
        {byRep && view !== 'team' && (
          <ul className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b px-4 py-2 text-[11.5px] sm:px-5" aria-label="Colours">
            {[...people].sort((a, b) => a.name.localeCompare(b.name)).map((p) => (
              <li key={p.id} className="inline-flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: colours.get(p.id) }} aria-hidden />
                <span className="font-semibold">{p.name}</span>
                <span className="tabular-nums text-muted-foreground">{repCounts.get(p.id) ?? 0}</span>
              </li>
            ))}
            {others > 0 && (
              <li className="inline-flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: 'var(--viz-working)' }} aria-hidden />
                <span className="font-semibold">Others</span>
                <span className="tabular-nums text-muted-foreground">{others}</span>
              </li>
            )}
          </ul>
        )}

        <div className="p-3 sm:p-4">
          {view === 'month' && <MonthGrid days={win.days} cursor={cursor} today={today} byDay={byDay} paint={paint} onPick={setSelected} onDay={openDay} />}
          {timeGrid && (
            <TimeGrid
              days={win.days}
              today={today}
              byDay={byDay}
              now={now}
              tz={tz}
              paint={paint}
              onPick={setSelected}
              onDay={view === 'week' ? openDay : undefined}
              onSlot={setBooking}
              onMove={(event, at) => setMoving({ event, at })}
              moving={moving}
            />
          )}
          {view === 'agenda' && <Agenda days={win.days} today={today} byDay={byDay} now={now} paint={paint} onPick={setSelected} loading={isLoading} />}
          {view === 'team' && (
            <CalendarTeamGrid
              days={win.days}
              today={today}
              events={visible}
              now={now}
              people={userId ? people.filter((p) => p.id === userId) : people}
              colours={colours}
              onOpen={openPerson}
            />
          )}
        </div>
      </section>

      {selected && (
        <CalendarEventPanel event={selected} displayTime={`${timeIn(selected.date, tz)} ${userZoneAbbrev(tz)}`} tz={tz} now={now} onClose={() => setSelected(null)} />
      )}
      {booking && <CalendarNewPanel initialAt={booking} tz={tz} now={now} allowTask={ownSchedule} onClose={() => setBooking(null)} />}
      {moving && <CalendarMoveDialog event={moving.event} at={moving.at} tz={tz} now={now} onClose={() => setMoving(null)} />}
    </div>
  );
}

/** One event as a small chip — month cells and the agenda's compact rows. */
function Chip({ e, paint, onPick }: { e: Placed; paint: (e: Placed) => Look; onPick: (e: CalendarEvent) => void }) {
  const p = paint(e);
  return (
    <button
      type="button"
      onClick={() => onPick(e)}
      title={`${TYPE_META[e.type].label} · ${e.companyName} · ${e.atLabel}`}
      className={`block w-full truncate rounded-[5px] px-1.5 py-0.5 text-left text-[10.5px] font-semibold transition-opacity hover:opacity-80 ${p.cls}`}
      style={p.style}
    >
      <span className="tabular-nums">{e.time}</span> {e.companyName}
    </button>
  );
}

function MonthGrid({ days, cursor, today, byDay, paint, onPick, onDay }: {
  days: string[]; cursor: string; today: string; byDay: Map<string, Placed[]>; paint: (e: Placed) => Look; onPick: (e: CalendarEvent) => void; onDay: (ymd: string) => void;
}) {
  const month = cursor.slice(0, 7);
  return (
    // Seven columns whatever the screen; narrow screens scroll it sideways (phones open on the agenda instead).
    <div className="overflow-x-auto">
      <div className="grid min-w-[640px] grid-cols-7 gap-1.5">
        {DOW.map((d) => <div key={d} className="py-1 text-center text-[10.5px] font-semibold uppercase tracking-[.08em] text-muted-foreground">{d}</div>)}
        {days.map((ymd) => {
          const evs = (byDay.get(ymd) ?? []).sort((a, b) => a.date.localeCompare(b.date));
          const other = ymd.slice(0, 7) !== month;
          const isToday = ymd === today;
          const past = ymd < today;
          return (
            <div
              key={ymd}
              className={`min-h-[104px] rounded-[10px] border p-1.5 ${other ? 'bg-muted/30' : 'bg-card'} ${isToday ? 'border-primary shadow-[inset_0_0_0_1px_hsl(var(--primary))]' : ''}`}
              // Busier days are deeper; the neighbouring month's, softer.
              style={{ backgroundColor: loadShade(evs.length, other ? 0.6 : 1) }}
            >
              <div className="mb-1 flex items-center justify-between gap-1">
                <button
                  type="button"
                  onClick={() => onDay(ymd)}
                  aria-label={`Open ${ymd} as a day${evs.length ? `, ${itemCount(evs.length)}` : ''}`}
                  className={`grid h-6 min-w-6 place-items-center rounded-full px-1 text-[11.5px] font-semibold hover:bg-muted ${isToday ? 'bg-primary text-primary-foreground hover:bg-primary' : other || past ? 'text-muted-foreground' : ''}`}
                >
                  {Number(ymd.slice(8))}
                </button>
                {evs.length > 0 && <span className="pr-1 text-[10.5px] font-semibold tabular-nums text-muted-foreground" aria-hidden>{evs.length}</span>}
              </div>
              <div className={`space-y-[3px] ${past && !isToday ? 'opacity-75' : ''}`}>
                {evs.slice(0, 3).map((e) => <Chip key={e.id} e={e} paint={paint} onPick={onPick} />)}
                {evs.length > 3 && (
                  <button type="button" onClick={() => onDay(ymd)} className="px-1.5 text-[10.5px] font-semibold text-primary hover:underline">
                    +{evs.length - 3} more
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <p className="mt-3 flex justify-end px-1 text-[11px] text-muted-foreground"><LoadLegend /></p>
    </div>
  );
}

/** Where a dragged item would land: a day column and minutes past midnight, on the display clock. */
type Drop = { e: Placed; ymd: string; minutes: number };

const lengthOf = (e: Placed) => Math.max(e.durationMins ?? 30, 30);

function TimeGrid({ days, today, byDay, now, tz, paint, onPick, onDay, onSlot, onMove, moving }: {
  days: string[]; today: string; byDay: Map<string, Placed[]>; now: number; tz: string; paint: (e: Placed) => Look;
  onPick: (e: CalendarEvent) => void; onDay?: (ymd: string) => void;
  onSlot: (at: Date) => void; onMove: (e: Placed, at: Date) => void; moving: Moving | null;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  // The press that may become a drag. Moves under 5px are still a click.
  const press = useRef<{ e: Placed; x: number; y: number; moved: boolean } | null>(null);
  // A drag ends with a click on the same block; that click must not open the panel.
  const swallowClick = useRef(false);
  const [preview, setPreview] = useState<Drop | null>(null);
  const [hover, setHover] = useState<{ ymd: string; minutes: number } | null>(null);

  const inView = days.flatMap((d) => byDay.get(d) ?? []);
  // The hours each item covers, start to finish, so an hour-long 7:30 PM meeting gets the 8 PM row it runs into.
  const [lo, hi] = hourRange(inView.flatMap((e) => [e.hour, Math.ceil((e.hour * 60 + e.minute + lengthOf(e)) / 60) - 1]));
  const hours = Array.from({ length: hi - lo }, (_, i) => lo + i);
  const nowAt = zoneParts(new Date(now).toISOString(), tz);
  const nowTop = ((nowAt.hour * 60 + nowAt.minute - lo * 60) / 60) * HOUR_PX;
  const cols = `${LABEL_W}px repeat(${days.length}, minmax(0, 1fr))`;
  const fmtHour = (h: number) => (h === 0 || h === 24 ? '12 AM' : h === 12 ? '12 PM' : h < 12 ? `${h} AM` : `${h - 12} PM`);
  const px = (minutesFromTop: number) => (minutesFromTop / 60) * HOUR_PX;

  // The block drawn where an item is going: while it's dragged, then while its confirm is open.
  const movingAt = moving ? zoneParts(moving.at.toISOString(), tz) : null;
  const ghost: Drop | null = preview ?? (moving && movingAt ? { e: moving.event, ymd: movingAt.ymd, minutes: movingAt.hour * 60 + movingAt.minute } : null);

  const dropFor = (ev: React.PointerEvent, p: { e: Placed; y: number }): Drop => {
    const rect = bodyRef.current!.getBoundingClientRect();
    const colW = (rect.width - LABEL_W) / days.length;
    const col = Math.min(days.length - 1, Math.max(0, Math.floor((ev.clientX - rect.left - LABEL_W) / colW)));
    const start = p.e.hour * 60 + p.e.minute + ((ev.clientY - p.y) / HOUR_PX) * 60;
    const minutes = Math.min(hi * 60 - DRAG_STEP, Math.max(lo * 60, snap(start, DRAG_STEP)));
    return { e: p.e, ymd: days[col], minutes };
  };

  /** The half hour under the pointer in a day column, or null in the past (or over an item). */
  const slotAt = (ev: React.MouseEvent<HTMLDivElement>, ymd: string) => {
    if ((ev.target as HTMLElement).closest('[data-event]')) return null;
    const rect = ev.currentTarget.getBoundingClientRect();
    const minutes = lo * 60 + Math.floor(((ev.clientY - rect.top) / HOUR_PX) * (60 / SLOT_STEP)) * SLOT_STEP;
    const at = zonedInstant(ymd, minutes, tz);
    if (at.getTime() + SLOT_STEP * 60_000 <= now) return null;
    return { ymd, minutes, at };
  };

  return (
    <div className="overflow-x-auto">
      <div className={days.length > 1 ? 'min-w-[720px]' : ''}>
        {/* Day headings — in a week, each opens that day. */}
        <div className="grid border-b pb-2" style={{ gridTemplateColumns: cols }}>
          <div />
          {days.map((ymd) => {
            const isToday = ymd === today;
            const label = (
              <>
                <span className="block text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">{DOW[weekday(ymd)]}</span>
                <span className={`mx-auto mt-0.5 grid h-7 w-7 place-items-center rounded-full font-display text-[14px] font-semibold ${isToday ? 'bg-primary text-primary-foreground' : ''}`}>
                  {Number(ymd.slice(8))}
                </span>
                <span className="block text-[10.5px] text-muted-foreground">{(byDay.get(ymd) ?? []).length ? itemCount((byDay.get(ymd) ?? []).length) : '—'}</span>
              </>
            );
            return onDay ? (
              <button key={ymd} type="button" onClick={() => onDay(ymd)} className="rounded-md py-1 text-center hover:bg-muted">{label}</button>
            ) : (
              <div key={ymd} className="py-1 text-center">{label}</div>
            );
          })}
        </div>

        <div ref={bodyRef} className={`relative grid ${preview ? 'cursor-grabbing select-none' : ''}`} style={{ gridTemplateColumns: cols }}>
          {/* Hour labels. */}
          <div>
            {hours.map((h) => (
              <div key={h} className="relative pr-2 text-right text-[10.5px] text-muted-foreground" style={{ height: HOUR_PX }}>
                <span className="relative -top-2">{fmtHour(h)}</span>
              </div>
            ))}
          </div>
          {days.map((ymd) => {
            const placed = layoutDay(
              (byDay.get(ymd) ?? []).map((e) => ({ item: e, start: (e.hour - lo) * 60 + e.minute, length: lengthOf(e) })),
            );
            return (
              // A free time is clicked to book it; the keyboard way in is the "New" button.
              <div
                key={ymd}
                className={`relative border-l ${ymd < today ? 'bg-muted/25' : ''}`}
                style={{ height: hours.length * HOUR_PX }}
                onClick={(ev) => {
                  if (swallowClick.current) return;
                  const slot = slotAt(ev, ymd);
                  if (!slot) return;
                  // The half hour already under way books from the next one.
                  onSlot(slot.at.getTime() < now ? nextHalfHour(now, tz) : slot.at);
                }}
                onMouseMove={(ev) => {
                  if (preview) return;
                  const slot = slotAt(ev, ymd);
                  if (slot?.ymd !== hover?.ymd || slot?.minutes !== hover?.minutes) setHover(slot ? { ymd: slot.ymd, minutes: slot.minutes } : null);
                }}
                onMouseLeave={() => setHover(null)}
              >
                {hours.map((h, i) => <div key={h} className="absolute inset-x-0 border-t border-border/70" style={{ top: i * HOUR_PX }} aria-hidden />)}
                {ymd === today && nowTop >= 0 && nowTop <= hours.length * HOUR_PX && (
                  <div className="pointer-events-none absolute inset-x-0 z-10 flex items-center" style={{ top: nowTop }} aria-hidden>
                    <span className="-ml-1 h-2 w-2 rounded-full bg-[var(--tone-red-fg-2)]" />
                    <span className="h-[2px] flex-1 bg-[var(--tone-red-fg-2)]" />
                  </div>
                )}
                {hover?.ymd === ymd && !preview && !moving && (
                  <div
                    className="pointer-events-none absolute inset-x-[2px] flex items-center gap-1 rounded-md border border-dashed border-primary/60 bg-primary/5 px-1.5 text-[10.5px] font-semibold text-primary"
                    style={{ top: px(hover.minutes - lo * 60) + 1, height: px(SLOT_STEP) - 2 }}
                    aria-hidden
                  >
                    <Plus className="h-3 w-3" /> {clockLabel(hover.minutes)}
                  </div>
                )}
                {placed.map(({ item: e, top, length, lane, lanes }) => {
                  const Icon = TYPE_META[e.type].icon;
                  // A half-hour block has room for one line: time and company side by side.
                  const short = px(length) < 44;
                  const blocker = moveBlocker(e);
                  const beingMoved = ghost?.e.id === e.id;
                  const p = paint(e);
                  return (
                    <button
                      key={e.id}
                      type="button"
                      data-event
                      onClick={(ev) => {
                        ev.stopPropagation();
                        if (swallowClick.current) return;
                        onPick(e);
                      }}
                      onPointerDown={(ev) => {
                        // Mouse and pen drag; a finger scrolls, and taps open the panel to reschedule.
                        if (ev.button !== 0 || ev.pointerType === 'touch') return;
                        // Held even for an item that can't move, so letting go elsewhere
                        // isn't read as a click on the free time underneath.
                        press.current = { e, x: ev.clientX, y: ev.clientY, moved: false };
                        ev.currentTarget.setPointerCapture(ev.pointerId);
                      }}
                      onPointerMove={(ev) => {
                        const p = press.current;
                        if (!p || p.e.id !== e.id) return;
                        if (!p.moved && Math.hypot(ev.clientX - p.x, ev.clientY - p.y) < 5) return;
                        p.moved = true;
                        if (blocker) return;
                        const d = dropFor(ev, p);
                        if (d.ymd !== preview?.ymd || d.minutes !== preview?.minutes) setPreview(d);
                      }}
                      onPointerUp={(ev) => {
                        const p = press.current;
                        press.current = null;
                        if (!p?.moved) return;
                        swallowClick.current = true;
                        setTimeout(() => { swallowClick.current = false; }, 0);
                        // It can't move: open it instead, where the panel says why.
                        if (blocker) return onPick(e);
                        const d = dropFor(ev, p);
                        setPreview(null);
                        if (d.ymd === e.ymd2 && d.minutes === e.hour * 60 + e.minute) return; // put back where it was
                        onMove(e, zonedInstant(d.ymd, d.minutes, tz));
                      }}
                      onPointerCancel={() => {
                        press.current = null;
                        setPreview(null);
                      }}
                      title={`${TYPE_META[e.type].label} · ${e.companyName} · ${e.atLabel}${blocker ? '' : ' · drag to move'}`}
                      className={`absolute overflow-hidden rounded-md border border-background/60 px-1.5 py-1 text-left text-[11px] leading-tight shadow-sm transition-[filter,opacity] hover:brightness-95 ${blocker ? '' : 'cursor-grab active:cursor-grabbing'} ${beingMoved ? 'opacity-40' : ''} ${p.cls}`}
                      style={{
                        top: px(top) + 1,
                        height: px(length) - 2,
                        left: `calc(${(lane / lanes) * 100}% + 2px)`,
                        width: `calc(${100 / lanes}% - 4px)`,
                        touchAction: 'manipulation',
                        ...p.style,
                      }}
                    >
                      <span className="flex min-w-0 items-center gap-1 font-semibold">
                        <Icon className="h-3 w-3 shrink-0" aria-hidden />
                        <span className="shrink-0 tabular-nums">{e.time}</span>
                        {short && <span className="truncate font-medium">{e.companyName}</span>}
                      </span>
                      {!short && <span className="block truncate font-semibold">{e.companyName}</span>}
                      {!short && days.length === 1 && (
                        <span className="block truncate opacity-80">{[e.leadName, e.atLabel, e.assignedTo].filter(Boolean).join(' · ')}</span>
                      )}
                    </button>
                  );
                })}
                {ghost?.ymd === ymd && (
                  <div
                    className="pointer-events-none absolute inset-x-[2px] z-20 overflow-hidden rounded-md border-2 border-dashed border-primary bg-card/95 px-1.5 py-1 text-[11px] leading-tight shadow-lg"
                    style={{ top: px(ghost.minutes - lo * 60) + 1, height: px(lengthOf(ghost.e)) - 2 }}
                    aria-hidden
                  >
                    <span className="flex min-w-0 items-center gap-1 font-semibold">
                      <span className="shrink-0 tabular-nums text-primary">{clockLabel(ghost.minutes)}</span>
                      <span className="truncate">{ghost.e.companyName}</span>
                    </span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Agenda({ days, today, byDay, now, paint, onPick, loading }: {
  days: string[]; today: string; byDay: Map<string, Placed[]>; now: number; paint: (e: Placed) => Look; onPick: (e: CalendarEvent) => void; loading: boolean;
}) {
  const withEvents = days.filter((d) => (byDay.get(d) ?? []).length > 0);
  if (!withEvents.length) {
    return <p className="py-12 text-center text-sm text-muted-foreground">{loading ? 'Loading…' : 'Nothing scheduled in these two weeks.'}</p>;
  }
  return (
    <div className="space-y-4">
      {withEvents.map((ymd) => {
        const evs = (byDay.get(ymd) ?? []).sort((a, b) => a.date.localeCompare(b.date));
        return (
          <section key={ymd} aria-label={dayHeading(ymd, today)}>
            <h4 className={`mb-1.5 flex items-baseline gap-2 text-[12px] font-semibold ${ymd === today ? 'text-primary' : ''}`}>
              {dayHeading(ymd, today)}
              <span className="text-[11px] font-normal text-muted-foreground">{ymd} · {evs.length}</span>
            </h4>
            <ul className="divide-y rounded-xl border">
              {evs.map((e) => {
                const Icon = TYPE_META[e.type].icon;
                const overdue = isOverdue(e, now);
                return (
                  <li key={e.id}>
                    <button type="button" onClick={() => onPick(e)} className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/50">
                      <span className="w-[62px] shrink-0 text-[12px] font-semibold tabular-nums">{e.time}</span>
                      <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg ${paint(e).cls}`} style={paint(e).style}><Icon className="h-4 w-4" aria-hidden /></span>
                      <span className="min-w-0 flex-1">
                        <span className={`block truncate text-[12.5px] font-semibold ${e.status === 'cancelled' ? 'line-through text-muted-foreground' : ''}`}>{e.companyName}</span>
                        <span className="block truncate text-[11px] text-muted-foreground">
                          {TYPE_META[e.type].label} · {e.atLabel}{e.assignedTo ? ` · ${e.assignedTo}` : ''}
                        </span>
                      </span>
                      {overdue && <span className={`shrink-0 rounded-full px-2 py-[2px] text-[10.5px] font-semibold ${OVERDUE_CHIP}`}>Overdue</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
