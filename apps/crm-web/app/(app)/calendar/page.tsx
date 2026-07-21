'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plus, ChevronLeft, ChevronRight } from 'lucide-react';
import { calendarApi, type CalendarEvent } from '@/lib/crm';
import { PageHead } from '@/components/page-head';
import { Segmented } from '@/components/segmented';

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const EV_STYLE: Record<string, string> = {
  call: 'bg-[#d8eed9] text-[#266929]',
  fu: 'bg-[#fbf3e2] text-[#c98a18]',
  task: 'bg-[#e7f0f8] text-[#2c5d8f]',
};
type CalView = 'month' | 'week' | 'day';
const VIEWS = [{ label: 'Month', value: 'month' as CalView }, { label: 'Week', value: 'week' as CalView }, { label: 'Day', value: 'day' as CalView }];

export default function CalendarPage() {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [view, setView] = useState<CalView>('month');

  const { data: events = [] } = useQuery({ queryKey: ['calendar', year, month], queryFn: () => calendarApi.events(year, month) });
  const byDay = new Map<number, CalendarEvent[]>();
  for (const e of events) {
    if (!byDay.has(e.day)) byDay.set(e.day, []);
    byDay.get(e.day)!.push(e);
  }

  const daysInMonth = new Date(year, month, 0).getDate();
  const todayDay = now.getFullYear() === year && now.getMonth() + 1 === month ? now.getDate() : -1;
  const anchor = todayDay > 0 ? todayDay : 1;

  function shift(delta: number) {
    let m = month + delta, y = year;
    if (m < 1) { m = 12; y--; } else if (m > 12) { m = 1; y++; }
    setMonth(m); setYear(y);
  }

  const blank = (k: string) => <div key={k} className="min-h-[96px] rounded-[10px] border bg-background" />;
  const dayCell = (d: number) => {
    const evs = byDay.get(d) ?? [];
    return (
      <div key={d} className={`min-h-[96px] rounded-[10px] border bg-card p-[7px] transition-colors hover:bg-muted/50 ${d === todayDay ? 'border-[#2b732f] shadow-[inset_0_0_0_1px_#2b732f]' : ''}`}>
        <div className="mb-[5px] text-[12px] font-semibold">{d}</div>
        {evs.slice(0, view === 'day' ? 20 : 3).map((e, i) => (
          <div key={i} title={e.label} className={`mb-[3px] truncate rounded-[5px] px-1.5 py-0.5 text-[10.5px] font-semibold ${EV_STYLE[e.type]}`}>{e.label}</div>
        ))}
        {view !== 'day' && evs.length > 3 && <div className="px-1.5 text-[10px] text-muted-foreground">+{evs.length - 3} more</div>}
      </div>
    );
  };

  // Build the grid cells for the active view.
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

  return (
    <div>
      <PageHead>
        <Segmented options={VIEWS} value={view} onChange={setView} />
        <div className="flex items-center gap-1 rounded-md border bg-card">
          <button onClick={() => shift(-1)} className="grid h-9 w-9 place-items-center rounded-l-md text-muted-foreground hover:bg-muted"><ChevronLeft className="h-4 w-4" /></button>
          <button onClick={() => shift(1)} className="grid h-9 w-9 place-items-center rounded-r-md text-muted-foreground hover:bg-muted"><ChevronRight className="h-4 w-4" /></button>
        </div>
        <button className="inline-flex items-center gap-2 rounded-md bg-primary px-[15px] py-[9px] text-[13px] font-semibold text-primary-foreground hover:opacity-90"><Plus className="h-4 w-4" /> New event</button>
      </PageHead>

      <div className="rounded-2xl border bg-card shadow-sm">
        <div className="flex items-center justify-between border-b px-[18px] py-4">
          <h3 className="font-display text-[15px] font-semibold">{heading} <span className="text-xs font-normal capitalize text-muted-foreground">· {view} view</span></h3>
          <div className="flex flex-wrap gap-3.5 text-[12px] text-muted-foreground">
            <span className="flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-[3px] bg-[#a6c74d]" /> Calls</span>
            <span className="flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-[3px] bg-[#f0d589]" /> Follow-ups</span>
            <span className="flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-[3px] bg-[#a9c8e6]" /> Tasks</span>
          </div>
        </div>
        <div className="p-[18px]">
          <div className="grid grid-cols-7 gap-1.5">
            {DOW.map((d) => <div key={d} className="py-1.5 text-center text-[11px] font-semibold uppercase tracking-[.08em] text-muted-foreground">{d}</div>)}
            {cells}
          </div>
        </div>
      </div>
    </div>
  );
}
