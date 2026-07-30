'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Phone, PhoneCall, Video, CalendarDays, User as UserIcon } from 'lucide-react';
import { calendarApi, assignmentsApi, type CalendarEvent, type ActivityType } from '@/lib/crm';
import { api } from '@/lib/api';
import { PageHead, Avatar } from '@/components/page-head';
import { Segmented } from '@/components/segmented';
import { KpiCard } from '@/components/dashboard/kpi-card';
import { DateFilter } from '@/components/date-picker';
import { FilterSelect } from '@/components/filter-controls';
import { CallbackStatusPill } from '@/components/callback-status-pill';
import { formatInUserZone } from '@/lib/timezone';
import { EMPTY_DATE_FILTER, type DateFilterValue } from '@/lib/date-filters';

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** One visual identity per activity type, reused by the chips and the legend. */
const TYPE_META: Record<ActivityType, { label: string; chip: string; dot: string; icon: typeof Phone }> = {
  call: { label: 'Scheduled Call', chip: 'bg-[#d8eed9] text-[#266929]', dot: 'bg-[#a6c74d]', icon: Phone },
  callback: { label: 'Callback', chip: 'bg-[#fbf3e2] text-[#8a5d0a]', dot: 'bg-[#f0d589]', icon: PhoneCall },
  zoom: { label: 'Zoom Meeting', chip: 'bg-[#e7f0fb] text-[#1f5fae]', dot: 'bg-[#a9c8e6]', icon: Video },
};

/**
 * A callback that has gone past its window is coloured as the problem it is,
 * overriding its activity-type chip. An overdue callback sitting in the same
 * amber as a comfortably-upcoming one is how it stays unnoticed in a full month.
 */
const overdueChip = (e: CalendarEvent): string | null =>
  e.callbackStatus === 'overdue' ? 'bg-[#fbeeec] text-[#8f2b1c]' : e.callbackStatus === 'due' ? 'bg-[#f7e2c0] text-[#8a5d0a]' : null;

type CalView = 'month' | 'week' | 'day';
const VIEWS = [{ label: 'Month', value: 'month' as CalView }, { label: 'Week', value: 'week' as CalView }, { label: 'Day', value: 'day' as CalView }];

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * Calendar — one consolidated schedule of every upcoming activity: planned calls,
 * callbacks and Zoom meetings.
 *
 * The date range is the single source of truth: it drives the grid, the query and
 * the summary cards together, so the counts can never describe a different window
 * from the one on screen. Scope is the API's to enforce — an employee is always
 * limited to their own schedule whatever this page asks for.
 */
export default function CalendarPage() {
  const now = new Date();
  const [view, setView] = useState<CalView>('month');
  const [range, setRange] = useState<DateFilterValue>(EMPTY_DATE_FILTER);
  const [userId, setUserId] = useState('');
  const [openDay, setOpenDay] = useState<number | null>(null);

  const { data: me } = useQuery({ queryKey: ['me'], queryFn: async () => (await api.get('/auth/me')).data, retry: false });
  const isManager = me?.role === 'admin' || me?.role === 'team_leader';

  // Employee picker — managers only; the API ignores it for everyone else.
  const { data: summary } = useQuery({ queryKey: ['assignments-summary'], queryFn: assignmentsApi.summary, enabled: !!isManager });
  const userOpts = useMemo(
    () => [{ label: 'All Employees', value: '' }, ...(summary?.callers ?? []).map((c) => ({ label: c.name, value: c.id }))],
    [summary],
  );

  // The month on screen. With no explicit range it's the current month; a chosen
  // range moves the grid to the month its start falls in.
  const anchorDate = range.from ? new Date(`${range.from}T00:00:00`) : now;
  const [monthOffset, setMonthOffset] = useState(0);
  const viewed = new Date(anchorDate.getFullYear(), anchorDate.getMonth() + monthOffset, 1);
  const year = viewed.getFullYear();
  const month = viewed.getMonth() + 1;

  // Query window: the explicit range when set, else the whole viewed month — so
  // paging months with the arrows refetches rather than showing a stale set.
  const from = range.from || iso(new Date(year, month - 1, 1));
  const to = range.to || iso(new Date(year, month, 0));

  const { data } = useQuery({
    queryKey: ['calendar', from, to, userId],
    queryFn: () => calendarApi.events({ from, to, userId: userId || undefined }),
  });
  const events = data?.events ?? [];
  const s = data?.summary;

  // Only events that fall in the month being drawn get a cell.
  const byDay = new Map<number, CalendarEvent[]>();
  for (const e of events) {
    const d = new Date(e.date);
    if (d.getFullYear() !== year || d.getMonth() + 1 !== month) continue;
    if (!byDay.has(e.day)) byDay.set(e.day, []);
    byDay.get(e.day)!.push(e);
  }

  const daysInMonth = new Date(year, month, 0).getDate();
  const todayDay = now.getFullYear() === year && now.getMonth() + 1 === month ? now.getDate() : -1;
  const anchor = todayDay > 0 ? todayDay : 1;

  const blank = (k: string) => <div key={k} className="min-h-[96px] rounded-[10px] border bg-background" />;
  const dayCell = (d: number) => {
    const evs = byDay.get(d) ?? [];
    return (
      <div
        key={d}
        onClick={() => setOpenDay(evs.length ? d : null)}
        className={`min-h-[96px] rounded-[10px] border bg-card p-[7px] transition-colors hover:bg-muted/50 ${evs.length ? 'cursor-pointer' : ''} ${d === todayDay ? 'border-[#2b732f] shadow-[inset_0_0_0_1px_#2b732f]' : ''}`}
      >
        <div className="mb-[5px] text-[12px] font-semibold">{d}</div>
        {evs.slice(0, view === 'day' ? 20 : 3).map((e) => (
          // `atLabel` is the API's rendering on the CUSTOMER's clock with the
          // zone named. The chip used to call `toLocaleTimeString` on the
          // instant, which shows the REP's hour with nothing to say so — a
          // Pacific callback read three hours off and looked authoritative.
          <div
            key={e.id}
            title={`${TYPE_META[e.type].label} · ${e.companyName} · ${e.atLabel}`}
            className={`mb-[3px] truncate rounded-[5px] px-1.5 py-0.5 text-[10.5px] font-semibold ${overdueChip(e) ?? TYPE_META[e.type].chip}`}
          >
            {e.atLabel} {e.companyName}
          </div>
        ))}
        {view !== 'day' && evs.length > 3 && <div className="px-1.5 text-[10px] text-muted-foreground">+{evs.length - 3} more</div>}
      </div>
    );
  };

  const cells: React.ReactNode[] = [];
  if (view === 'month') {
    const firstDow = new Date(year, month - 1, 1).getDay();
    for (let i = 0; i < firstDow; i++) cells.push(blank(`o${i}`));
    for (let d = 1; d <= daysInMonth; d++) cells.push(dayCell(d));
  } else if (view === 'week') {
    const dow = new Date(year, month - 1, anchor).getDay();
    const weekStart = anchor - dow;
    for (let i = 0; i < 7; i++) {
      const d = weekStart + i;
      cells.push(d < 1 || d > daysInMonth ? blank(`w${i}`) : dayCell(d));
    }
  } else {
    const dow = new Date(year, month - 1, anchor).getDay();
    for (let i = 0; i < dow; i++) cells.push(blank(`d${i}`));
    cells.push(dayCell(anchor));
  }

  const heading = view === 'day' ? `${MONTHS[month - 1]} ${anchor}, ${year}` : `${MONTHS[month - 1]} ${year}`;
  // The detail list: one day when a cell is picked, otherwise the whole window.
  const detail = openDay ? (byDay.get(openDay) ?? []) : events;

  return (
    <div>
      <PageHead>
        <Segmented options={VIEWS} value={view} onChange={setView} />
        {/* Same range filter Lead Management uses — it drives the grid, the list
            and the summary cards together. */}
        <DateFilter value={range} onChange={(v) => { setRange(v); setMonthOffset(0); setOpenDay(null); }} />
        {isManager && <FilterSelect icon={UserIcon} value={userId} onChange={(v) => { setUserId(v); setOpenDay(null); }} options={userOpts} />}
        <div className="flex items-center gap-1 rounded-md border bg-card">
          <button onClick={() => { setMonthOffset((m) => m - 1); setOpenDay(null); }} aria-label="Previous month" className="grid h-9 w-9 place-items-center rounded-l-md text-muted-foreground hover:bg-muted"><ChevronLeft className="h-4 w-4" /></button>
          <button onClick={() => { setMonthOffset((m) => m + 1); setOpenDay(null); }} aria-label="Next month" className="grid h-9 w-9 place-items-center rounded-r-md text-muted-foreground hover:bg-muted"><ChevronRight className="h-4 w-4" /></button>
        </div>
      </PageHead>

      {/* Summary — counts for the selected window and employee scope. */}
      <div className="mb-5 grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(180px,1fr))]">
        <KpiCard index={0} icon={Phone} iconBg="#d8eed9" iconColor="#266929" value={s?.calls ?? 0} label="Scheduled Calls" />
        <KpiCard index={1} icon={PhoneCall} iconBg="#fbf3e2" iconColor="#c98a18" value={s?.callbacks ?? 0} label="Callback Calls" />
        <KpiCard index={2} icon={Video} iconBg="#e7f0fb" iconColor="#1f5fae" value={s?.zooms ?? 0} label="Zoom Meetings" />
        <KpiCard index={3} icon={CalendarDays} iconBg="#e4f2e4" iconColor="#317d34" value={s?.total ?? 0} label="Total Scheduled" />
      </div>

      <div className="rounded-2xl border bg-card shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b px-[18px] py-4">
          <h3 className="font-display text-[15px] font-semibold">{heading} <span className="text-xs font-normal capitalize text-muted-foreground">· {view} view</span></h3>
          <div className="flex flex-wrap gap-3.5 text-[12px] text-muted-foreground">
            {(Object.keys(TYPE_META) as ActivityType[]).map((t) => (
              <span key={t} className="flex items-center gap-1.5"><i className={`h-2.5 w-2.5 rounded-[3px] ${TYPE_META[t].dot}`} /> {TYPE_META[t].label}s</span>
            ))}
          </div>
        </div>
        {/* A week is seven columns whatever the screen — collapsing it would stop
            being a calendar. So on a narrow screen the grid keeps a workable
            minimum width and the container scrolls sideways instead. */}
        <div className="overflow-x-auto p-3 sm:p-[18px]">
          <div className="grid min-w-[560px] grid-cols-7 gap-1.5">
            {DOW.map((d) => <div key={d} className="py-1.5 text-center text-[11px] font-semibold uppercase tracking-[.08em] text-muted-foreground">{d}</div>)}
            {cells}
          </div>
        </div>
      </div>

      {/* Full detail per activity — the month cell has no room for the lead, the
          owner and the status, so they're listed underneath. */}
      <div className="mt-[18px] rounded-2xl border bg-card shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b px-[18px] py-4">
          <h3 className="font-display text-[15px] font-semibold">
            Scheduled Activities
            <span className="ml-1.5 text-xs font-normal text-muted-foreground">
              {openDay ? `· ${MONTHS[month - 1]} ${openDay}` : '· selected range'} · {detail.length}
            </span>
          </h3>
          {openDay && (
            <button onClick={() => setOpenDay(null)} className="text-[12px] font-medium text-primary hover:underline">Show whole range</button>
          )}
        </div>
        <div className="max-h-[420px] overflow-y-auto p-[14px]">
          {detail.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">No scheduled activities in this period.</p>}
          {detail.map((e) => {
            const M = TYPE_META[e.type];
            const Icon = M.icon;
            return (
              <div key={e.id} className="mb-2 flex items-center gap-3 rounded-[11px] border p-3 last:mb-0">
                <div className={`grid h-9 w-9 shrink-0 place-items-center rounded-[9px] ${M.chip}`}><Icon className="h-[17px] w-[17px]" /></div>
                <Avatar name={e.companyName} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-semibold">{e.companyName}</div>
                  <div className="truncate text-[11.5px] text-muted-foreground">
                    {e.leadName ? `${e.leadName} · ` : ''}{e.leadId}
                  </div>
                </div>
                {/* The customer's clock on top, the rep's underneath — the same
                    pairing the scheduler and the reminder popup show, so the
                    rep never has to work out the difference in their head. */}
                <div className="hidden min-w-0 shrink-0 sm:block">
                  <div className="text-[12px] font-medium">{e.atLabel}</div>
                  <div className="text-[11.5px] text-muted-foreground">
                    Your time: {formatInUserZone(new Date(e.date))}
                  </div>
                </div>
                <div className="hidden w-[130px] shrink-0 truncate text-[12px] md:block">
                  <span className="text-muted-foreground">{e.assignedTo ?? 'Unassigned'}</span>
                </div>
                {e.callbackStatus && <CallbackStatusPill status={e.callbackStatus} className="shrink-0" />}
                <span className={`shrink-0 rounded-full px-2 py-[3px] text-[10.5px] font-semibold capitalize ${M.chip}`}>
                  {e.status.replace(/_/g, ' ')}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
