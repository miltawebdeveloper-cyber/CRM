'use client';

import { Clock } from 'lucide-react';
import type { CalendarEvent } from '@/lib/crm';
import { nextUp, untilLabel } from '@/lib/calendar-grid';
import { TYPE_META, type Look, type Placed } from '@/lib/calendar-look';

/** Within this long, the countdown is highlighted — time to get ready. */
const SOON_MS = 15 * 60_000;

/**
 * "Next up": the next three things on today's schedule, with how long until
 * each. The calendar answers "what's this week"; this answers "what now",
 * without reading the grid. It's today on the calendar's clock, whatever
 * period the grid below is showing.
 */
export function CalendarNextUp({ events, now, endOfDay, showOwner, paint, onPick }: {
  events: Placed[]; now: number; endOfDay: number; showOwner: boolean; paint: (e: Placed) => Look; onPick: (e: CalendarEvent) => void;
}) {
  const items = nextUp(events, now, endOfDay);
  return (
    <section aria-label="Next up today" className="flex flex-col gap-2.5 rounded-2xl border bg-card px-4 py-3 shadow-sm sm:flex-row sm:items-center sm:px-5">
      <h2 className="flex shrink-0 items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground sm:w-[92px]">
        <Clock className="h-3.5 w-3.5" aria-hidden /> Next up
      </h2>
      {items.length === 0 ? (
        <p className="text-[12.5px] text-muted-foreground">Nothing else scheduled today.</p>
      ) : (
        <ol className="grid min-w-0 flex-1 gap-2 md:grid-cols-3">
          {items.map((e) => {
            const Icon = TYPE_META[e.type].icon;
            const at = new Date(e.date).getTime();
            const until = untilLabel(at, now);
            const soon = at - now <= SOON_MS;
            const p = paint(e);
            return (
              <li key={e.id} className="min-w-0">
                <button
                  type="button"
                  onClick={() => onPick(e)}
                  className="flex w-full min-w-0 items-center gap-2.5 rounded-xl border px-2.5 py-2 text-left transition-colors hover:bg-muted/50"
                >
                  <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg ${p.cls}`} style={p.style}><Icon className="h-4 w-4" aria-hidden /></span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12.5px] font-semibold">{e.companyName}</span>
                    <span className="block truncate text-[11px] text-muted-foreground">
                      <span className="tabular-nums">{e.time}</span>
                      {e.type !== 'task' && e.timezone && !e.atLabel.includes(e.time) ? ` · ${e.atLabel.replace(/^[A-Z][a-z]{2} \d{1,2}, 0?/, '')} for them` : ''}
                      {showOwner && e.assignedTo ? ` · ${e.assignedTo}` : ''}
                    </span>
                  </span>
                  <span className={`shrink-0 rounded-full px-2 py-[2px] text-[10.5px] font-semibold tabular-nums ${soon ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}>
                    {until}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
